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
import nodemailer from "nodemailer";
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
  const path = `/safeguard-api/public/exports/${token}.pdf`;
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

export interface EmailDeliveryResult {
  status: "sent" | "failed";
  errorCode?: string;
  errorMessage?: string;
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
 */
export async function sendExportEmail(args: {
  to: string;
  surgeryName: string;
  pdfBytes: Buffer;
  patientName: string;
  appointmentId: string;
}): Promise<EmailDeliveryResult> {
  const transport = process.env.SAFEGUARD_DELIVERY_SMTP_URL;
  if (!transport) {
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
  try {
    const tx = nodemailer.createTransport(transport);
    await tx.sendMail({
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
    return { status: "sent" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown SMTP error.";
    logger.error(
      { err, appointmentId: args.appointmentId, to: args.to },
      "export email send failed",
    );
    return {
      status: "failed",
      errorCode: "smtp_error",
      errorMessage: `Email could not be delivered: ${message}`,
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
  const shareText = `Pre-appointment summary from ${who} for ${surgery}. Opens the PDF directly: ${publicUrl}`;
  return {
    token,
    publicUrl,
    shareText,
    expiresAt: new Date(Date.now() + QR_TTL_MS),
  };
}
