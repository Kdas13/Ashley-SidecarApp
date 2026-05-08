/**
 * Delivery transport for GP-export PDFs.
 *
 * Three channels are wired up today:
 *
 *   `qr`      — fully self-contained. We mint a short opaque access token
 *               and a public URL the surgery can scan. The token grants
 *               read-only access to one specific export PDF, expires after
 *               `QR_TTL_MS`, and is rotated per delivery row so revoking
 *               one scan never affects another.
 *
 *   `email`   — real SMTP send via nodemailer when
 *               `SAFEGUARD_DELIVERY_SMTP_URL` is set. The PDF is sent as
 *               an attachment. Without the env var we surface
 *               `transport_not_configured` straight back to the UI rather
 *               than pretending an email went out — once an operator
 *               wires up the transport the same delivery row can be
 *               replayed via the retry button.
 *
 *   `nhs_app` — share-intent channel: we mint the same token-gated
 *               public URL as `qr` plus a short share text, and the
 *               mobile/web client hands it to `navigator.share()` so the
 *               patient can drop it into the NHS App, WhatsApp, Signal,
 *               email, etc. The server records that the user picked
 *               this channel and the same `fetchedAt` mechanism kicks in
 *               when the surgery opens the PDF.
 */

import crypto from "node:crypto";
import QRCode from "qrcode";
import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "./logger";

export const QR_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export interface QrDeliveryArtifacts {
  token: string;
  publicUrl: string;
  qrDataUrl: string;
  expiresAt: Date;
}

/**
 * Build the public URL the surgery can fetch the PDF from. We deliberately
 * do not include the appointment id or the patient's name — only the
 * opaque token — so a leaked URL doesn't reveal anything beyond the PDF
 * itself.
 */
function publicUrlForToken(token: string): string {
  const base =
    process.env.SAFEGUARD_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
    process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ||
    "";
  // Land at the HTML preview page (no `.pdf`) so the surgery sees a
  // friendly "Patient summary for X — open PDF" landing card before the
  // raw PDF opens. The PDF itself is still served from the same token
  // route via the `?pdf=1` query flag.
  const path = `/safeguard-api/public/exports/${token}`;
  if (!base) {
    if (process.env.NODE_ENV === "production") {
      // A relative URL inside a QR code is useless to an external
      // scanner — the surgery's phone has no idea which host to
      // resolve against. Refuse to mint one in production rather than
      // hand the patient a token that won't work.
      throw new Error(
        "SAFEGUARD_PUBLIC_BASE_URL (or PUBLIC_BASE_URL) must be set in production so QR / share tokens resolve to an absolute URL.",
      );
    }
    return path;
  }
  return `${base}${path}`;
}

export async function buildQrDelivery(): Promise<QrDeliveryArtifacts> {
  // 32 bytes of randomness, url-safe. Comfortably above the 128-bit bar
  // for a non-enumerable single-purpose access token.
  const token = crypto.randomBytes(32).toString("base64url");
  const publicUrl = publicUrlForToken(token);
  const qrDataUrl = await QRCode.toDataURL(publicUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
  });
  return {
    token,
    publicUrl,
    qrDataUrl,
    expiresAt: new Date(Date.now() + QR_TTL_MS),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(input: string): boolean {
  return EMAIL_RE.test(input.trim());
}

export type EmailDeliveryErrorCode =
  | "transport_not_configured"
  | "transport_unverified"
  | "recipient_rejected"
  | "auth_failed"
  | "smtp_error";

export interface EmailDeliveryResult {
  status: "sent" | "failed";
  errorCode?: EmailDeliveryErrorCode;
  errorMessage?: string;
  messageId?: string;
}

/**
 * Cache the nodemailer transport across requests so we aren't paying TCP +
 * TLS handshake costs on every send. The cache key is the SMTP URL itself —
 * if an operator rotates SAFEGUARD_DELIVERY_SMTP_URL we transparently
 * rebuild on the next call instead of holding a stale connection pool.
 */
let cachedTransport: { url: string; tx: Transporter } | null = null;

function getTransport(url: string): Transporter {
  if (cachedTransport && cachedTransport.url === url) {
    return cachedTransport.tx;
  }
  // Note: nodemailer's URL-form constructor takes its connection-pool
  // settings via URL query params (e.g. `smtps://u:p@host:465/?pool=true`),
  // not via a second argument — the second arg to createTransport(url, …)
  // is per-message defaults, not transport options. We just cache the
  // built transport so repeated sends reuse the underlying socket.
  const tx = nodemailer.createTransport(url);
  cachedTransport = { url, tx };
  return tx;
}

/**
 * Test-only: drop the cached transport so unit tests don't carry a mocked
 * transport from one test file into another.
 */
export function _resetEmailTransportCache(): void {
  cachedTransport = null;
  verifiedTransports.clear();
}

/**
 * Map nodemailer's loosely-typed error shape onto our small set of API
 * error codes so the mobile UI can render a useful retry path. We look at
 * `err.code` (nodemailer's machine-readable code) and `err.responseCode`
 * (the SMTP reply code) — anything 5xx on RCPT TO is a rejected recipient
 * (bad address) rather than a transport failure the operator should chase.
 */
function classifySmtpError(err: unknown): {
  code: EmailDeliveryErrorCode;
  message: string;
} {
  const e = err as {
    code?: string;
    responseCode?: number;
    command?: string;
    message?: string;
  };
  const message = e?.message || "Unknown SMTP error.";
  if (e?.code === "EAUTH") {
    return {
      code: "auth_failed",
      message:
        "Surgery email transport rejected the configured credentials. Operator needs to update SAFEGUARD_DELIVERY_SMTP_URL.",
    };
  }
  if (
    e?.code === "EENVELOPE" ||
    (typeof e?.responseCode === "number" &&
      e.responseCode >= 500 &&
      e.responseCode < 600 &&
      (e.command === "RCPT TO" || /recipient|mailbox/i.test(message)))
  ) {
    return {
      code: "recipient_rejected",
      message: `Surgery rejected the address: ${message}`,
    };
  }
  return {
    code: "smtp_error",
    message: `Email could not be delivered: ${message}`,
  };
}

/**
 * Attempt to email the export to the supplied address. Without a transport
 * configured this returns `failed / transport_not_configured` rather than
 * silently dropping the message — the UI surfaces a retry button so once
 * an operator wires up SMTP the same delivery row can be replayed.
 *
 * Transport URL format (RFC-style): e.g.
 *   smtps://user:pass@smtp.nhs.net:465
 *   smtp://user:pass@smtp.example.org:587
 * The `from` address falls back to `SAFEGUARD_DELIVERY_FROM` and finally
 * to a noreply identity that includes the patient's preferred name.
 *
 * On the first call against a given transport URL we run `transport.verify()`
 * so misconfigured credentials surface as `auth_failed` / `transport_unverified`
 * instead of a generic send failure mid-handshake.
 */
const verifiedTransports = new Set<string>();

export async function sendExportEmail(args: {
  to: string;
  surgeryName: string;
  pdfBytes: Buffer;
  patientName: string;
  appointmentId: string;
}): Promise<EmailDeliveryResult> {
  const transportUrl = process.env.SAFEGUARD_DELIVERY_SMTP_URL;
  if (!transportUrl) {
    logger.warn(
      { appointmentId: args.appointmentId },
      "export email requested but SAFEGUARD_DELIVERY_SMTP_URL is unset",
    );
    return {
      status: "failed",
      errorCode: "transport_not_configured",
      errorMessage:
        "Surgery email transport is not configured on this site yet. Use the printable QR or NHS-app share for now, or ask the operator to enable email delivery.",
    };
  }
  const from =
    process.env.SAFEGUARD_DELIVERY_FROM ||
    `Safeguard <noreply@safeguard.local>`;
  const subject = args.surgeryName
    ? `Patient summary for ${args.patientName || "a patient"} — ${args.surgeryName}`
    : `Patient summary for ${args.patientName || "a patient"}`;
  const body = [
    `A patient has shared their pre-appointment summary with the surgery.`,
    ``,
    `Patient: ${args.patientName || "(name withheld)"}`,
    `Surgery: ${args.surgeryName || "(not specified)"}`,
    ``,
    `The PDF is attached. It was generated from the patient's own answers and an AI translation; please verify against the patient in person.`,
    ``,
    `Reference: appointment ${args.appointmentId}`,
  ].join("\n");

  const tx = getTransport(transportUrl);

  if (!verifiedTransports.has(transportUrl)) {
    try {
      await tx.verify();
      verifiedTransports.add(transportUrl);
      logger.info(
        { appointmentId: args.appointmentId },
        "export email transport verified",
      );
    } catch (err) {
      const classified = classifySmtpError(err);
      logger.error(
        { err, appointmentId: args.appointmentId },
        "export email transport verify failed",
      );
      return {
        status: "failed",
        errorCode:
          classified.code === "auth_failed"
            ? "auth_failed"
            : "transport_unverified",
        errorMessage:
          classified.code === "auth_failed"
            ? classified.message
            : `Surgery email transport could not be reached: ${
                err instanceof Error ? err.message : "unknown error"
              }`,
      };
    }
  }

  try {
    const info = await tx.sendMail({
      from,
      to: args.to,
      subject,
      text: body,
      attachments: [
        {
          filename: `safeguard-${args.appointmentId}.pdf`,
          content: args.pdfBytes,
          contentType: "application/pdf",
        },
      ],
    });
    const messageId =
      (info as { messageId?: string } | undefined)?.messageId ?? undefined;
    logger.info(
      {
        appointmentId: args.appointmentId,
        to: args.to,
        messageId,
      },
      "export email sent",
    );
    return { status: "sent", messageId };
  } catch (err) {
    const classified = classifySmtpError(err);
    logger.error(
      {
        err,
        appointmentId: args.appointmentId,
        to: args.to,
        errorCode: classified.code,
      },
      "export email send failed",
    );
    return {
      status: "failed",
      errorCode: classified.code,
      errorMessage: classified.message,
    };
  }
}

/**
 * Build a token-gated public URL plus a short share text for the
 * NHS-app / share-intent channel. The recipient parameter is the
 * surgery name only — there is no email or push registration step.
 */
export interface NhsAppShareArtifacts {
  token: string;
  publicUrl: string;
  shareText: string;
  expiresAt: Date;
}

export async function buildNhsAppShare(args: {
  surgeryName: string;
  patientName: string;
}): Promise<NhsAppShareArtifacts> {
  const token = crypto.randomBytes(32).toString("base64url");
  const publicUrl = publicUrlForToken(token);
  const who = args.patientName ? args.patientName : "a patient";
  const surgery = args.surgeryName || "the surgery";
  // The link now opens a small preview page (patient name, appointment
  // date, language pair) with a one-tap "Open PDF" button, rather than
  // the raw PDF — same surgery audience as the QR scan, same landing
  // page. Reflect that in the share text so the recipient knows what
  // they're about to see.
  const shareText = `Pre-appointment summary from ${who} for ${surgery}. Opens a preview with a one-tap link to the PDF: ${publicUrl}`;
  return {
    token,
    publicUrl,
    shareText,
    expiresAt: new Date(Date.now() + QR_TTL_MS),
  };
}
