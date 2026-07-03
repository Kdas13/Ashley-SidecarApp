/**
 * EMAIL SENDER
 *
 * Resend HTTPS API. Replaces the old Gmail SMTP/nodemailer transport
 * (removed 2026-07-03) because Railway blocks outbound SMTP ports
 * 465/587 on the Hobby plan — see the SMTP investigation report. Resend
 * sends over HTTPS (443), which is unaffected by that block.
 *
 * This module is intentionally thin: it sends and throws on failure.
 * All approval-gate logic lives in agentLoop / index.ts — nothing here
 * decides whether an email should be sent.
 *
 * Required Railway environment variables:
 *   RESEND_API_KEY   API key from the Resend dashboard (re_...)
 *   GMAIL_USER       kept as the configured "from" address for now
 *                    (nrnlofficial@gmail.com) — see FROM-ADDRESS WARNING
 *                    below. Despite the name, this is no longer a Gmail
 *                    SMTP credential; it's just the address string used
 *                    in the "From" header.
 *
 * FROM-ADDRESS WARNING — Kane must confirm this, not the agent:
 *   Resend requires the sending domain to be verified in the Resend
 *   dashboard (SPF/DKIM DNS records added on that domain). Gmail's own
 *   domain (gmail.com) cannot be verified by anyone other than Google —
 *   there is no way to add the required DNS records to gmail.com. That
 *   means sending "from" nrnlofficial@gmail.com via Resend will almost
 *   certainly be REJECTED by Resend's API (typically a 403 with a
 *   "domain is not verified" error), even though everything else here is
 *   correctly configured.
 *
 *   This code intentionally still reads GMAIL_USER as the from-address
 *   (per explicit instruction — do not silently substitute a different
 *   address) rather than assuming resend.dev's shared test sender or
 *   guessing at a domain Kane owns. getEmailDiagnostics() surfaces
 *   `fromAddressDomain` and `fromDomainLikelyUnverifiable` so this is
 *   visible over HTTP without guessing silently. Kane needs to either:
 *     (a) verify a domain he owns in Resend and set RESEND_FROM_ADDRESS
 *         to an address on that domain (e.g. no-reply@nrnl.co), or
 *     (b) use Resend's shared onboarding sender for early testing only
 *         (onboarding@resend.dev — visibly "via resend.dev" to
 *         recipients, not suitable for real send).
 *   Until one of those happens, live test-sends here may fail at the
 *   Resend API step even with a valid RESEND_API_KEY.
 *
 * Optional Railway environment variable:
 *   RESEND_FROM_ADDRESS   overrides the from-address if set, so Kane can
 *                          switch to a verified domain without another
 *                          code change. Falls back to GMAIL_USER if unset.
 */

import { Resend } from "resend";

function readResendApiKey(): string | undefined {
  const raw = process.env.RESEND_API_KEY;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readFromAddress(): string | undefined {
  const override = process.env.RESEND_FROM_ADDRESS?.trim();
  if (override && override.length > 0) return override;
  const raw = process.env.GMAIL_USER;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function isEmailConfigured(): boolean {
  return Boolean(readResendApiKey() && readFromAddress());
}

/**
 * Non-secret diagnostics for troubleshooting emailConfigured=false without
 * ever exposing the actual API key. Safe to expose over HTTP.
 */
export interface EmailDiagnostics {
  resendApiKeySet: boolean;
  resendApiKeyLength: number;
  resendApiKeyLooksValid: boolean;
  fromAddressSet: boolean;
  fromAddress: string | null;
  fromAddressSource: "RESEND_FROM_ADDRESS" | "GMAIL_USER" | "none";
  fromAddressDomain: string | null;
  fromDomainLikelyUnverifiable: boolean;
  emailConfigured: boolean;
}

export function getEmailDiagnostics(): EmailDiagnostics {
  const apiKeyRaw = process.env.RESEND_API_KEY;
  const apiKeyTrimmed = apiKeyRaw?.trim() ?? "";
  const fromAddress = readFromAddress() ?? null;
  const fromAddressDomain = fromAddress?.split("@")[1]?.toLowerCase() ?? null;
  const override = process.env.RESEND_FROM_ADDRESS?.trim();

  return {
    resendApiKeySet: apiKeyTrimmed.length > 0,
    resendApiKeyLength: apiKeyTrimmed.length,
    // Resend API keys are always prefixed "re_".
    resendApiKeyLooksValid: apiKeyTrimmed.startsWith("re_"),
    fromAddressSet: Boolean(fromAddress),
    fromAddress,
    fromAddressSource: override && override.length > 0
      ? "RESEND_FROM_ADDRESS"
      : fromAddress
        ? "GMAIL_USER"
        : "none",
    fromAddressDomain,
    // gmail.com (and other big free-mail domains) can't be DNS-verified
    // by anyone other than the provider, so Resend will reject sends
    // from addresses on these domains until a domain Kane controls is
    // verified in the Resend dashboard.
    fromDomainLikelyUnverifiable: fromAddressDomain
      ? ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com"].includes(fromAddressDomain)
      : false,
    emailConfigured: isEmailConfigured(),
  };
}

let cachedClient: Resend | undefined;

function getClient(): Resend {
  const apiKey = readResendApiKey();
  if (!apiKey) {
    throw new Error(
      "Email not configured. Set RESEND_API_KEY in Railway environment variables."
    );
  }
  if (!cachedClient) {
    cachedClient = new Resend(apiKey);
  }
  return cachedClient;
}

export interface EmailPayload {
  to: string;
  subject: string;
  body: string;
}

export interface EmailResult {
  messageId: string;
  accepted: string[];
}

export async function sendEmail(payload: EmailPayload): Promise<EmailResult> {
  const from = readFromAddress();
  if (!from) {
    throw new Error(
      "Email not configured. Set GMAIL_USER (or RESEND_FROM_ADDRESS) in Railway environment variables."
    );
  }
  const client = getClient();
  const { data, error } = await client.emails.send({
    from: `No Rules. No Labels. <${from}>`,
    to: payload.to,
    subject: payload.subject,
    text: payload.body,
  });

  if (error) {
    throw new Error(`Resend send failed: ${error.name} — ${error.message}`);
  }
  if (!data) {
    throw new Error("Resend send failed: no data returned from API");
  }

  console.log(`[email] Sent → ${payload.to}  messageId: ${data.id}`);
  return {
    messageId: data.id,
    accepted: [payload.to],
  };
}
