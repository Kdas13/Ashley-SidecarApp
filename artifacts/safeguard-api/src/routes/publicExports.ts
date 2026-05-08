/**
 * Public, token-gated landing page + PDF fetch for surgery scans /
 * shared links.
 *
 * Mounted OUTSIDE the Clerk gate in `app.ts`. Authentication is the
 * opaque `accessToken` minted by the deliver endpoint — no Clerk session,
 * no patient identifier in the URL. The token grants read-only access to
 * exactly one stored export PDF and stops working once `expiresAt` has
 * passed.
 *
 * Two surfaces share the same token URL:
 *
 *   GET /safeguard-api/public/exports/:token
 *     → HTML landing page with patient name, appointment date, language
 *       pair, expiry note, and an "Open PDF" button. Does NOT update
 *       `fetchedAt` — viewing the preview is not the same as opening the
 *       record.
 *
 *   GET /safeguard-api/public/exports/:token?pdf=1
 *   GET /safeguard-api/public/exports/:token.pdf  (legacy alias)
 *     → Serves the stored PDF inline and stamps `fetchedAt` so the
 *       patient's review screen can show "Opened by {recipient} at
 *       {when}". The `.pdf` alias keeps already-printed QR codes working
 *       — older deliveries minted before the landing page existed point
 *       directly at that path.
 *
 * The lookup is keyed on `accessToken` only — both the `qr` and
 * `nhs_app` channels mint tokens that resolve through this route. The
 * `accessToken` column has a unique index so we don't need a channel
 * filter to disambiguate.
 *
 * We don't delete the row on first scan — the audit trail is more useful
 * than single-shot semantics, and any single token is the patient's to
 * share or revoke.
 */

import { Router, type IRouter, type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  safeguardAppointmentExportDeliveriesTable,
  safeguardAppointmentExportsTable,
  safeguardAppointmentsTable,
  safeguardProfilesTable,
} from "@workspace/db";

const router: IRouter = Router();

interface TokenRow {
  deliveryId: string;
  expiresAt: Date | null;
  channel: string;
  recipient: string | null;
  surgeryName: string | null;
  pdfBase64: string;
  appointmentCreatedAt: Date | null;
  appointmentTitle: string | null;
  patientLang: string | null;
  clinicianLang: string | null;
  preferredName: string | null;
}

async function loadByToken(token: string): Promise<TokenRow | null> {
  const rows = await db
    .select({
      deliveryId: safeguardAppointmentExportDeliveriesTable.id,
      expiresAt: safeguardAppointmentExportDeliveriesTable.expiresAt,
      channel: safeguardAppointmentExportDeliveriesTable.channel,
      recipient: safeguardAppointmentExportDeliveriesTable.recipient,
      surgeryName: safeguardAppointmentExportDeliveriesTable.surgeryName,
      pdfBase64: safeguardAppointmentExportsTable.pdfBase64,
      appointmentCreatedAt: safeguardAppointmentsTable.createdAt,
      appointmentTitle: safeguardAppointmentsTable.title,
      patientLang: safeguardAppointmentsTable.patientLang,
      clinicianLang: safeguardAppointmentsTable.clinicianLang,
      preferredName: safeguardProfilesTable.preferredName,
    })
    .from(safeguardAppointmentExportDeliveriesTable)
    .innerJoin(
      safeguardAppointmentExportsTable,
      eq(
        safeguardAppointmentExportDeliveriesTable.exportId,
        safeguardAppointmentExportsTable.id,
      ),
    )
    .innerJoin(
      safeguardAppointmentsTable,
      eq(
        safeguardAppointmentExportDeliveriesTable.appointmentId,
        safeguardAppointmentsTable.id,
      ),
    )
    .leftJoin(
      safeguardProfilesTable,
      eq(
        safeguardAppointmentExportDeliveriesTable.userId,
        safeguardProfilesTable.userId,
      ),
    )
    .where(
      eq(safeguardAppointmentExportDeliveriesTable.accessToken, token),
    );
  return rows[0] ?? null;
}

interface ParsedToken {
  token: string;
  /**
   * True when the request path ended in `.pdf` — the legacy URL shape
   * minted before the landing page existed. We strip the suffix off the
   * token and route straight to the PDF so already-printed QR codes
   * continue to work.
   */
  legacyPdfSuffix: boolean;
}

function parseToken(raw: unknown): ParsedToken | null {
  let token = typeof raw === "string" ? raw.trim() : "";
  let legacyPdfSuffix = false;
  if (token.endsWith(".pdf")) {
    legacyPdfSuffix = true;
    token = token.slice(0, -4);
  }
  if (!token || token.length > 200) return null;
  return { token, legacyPdfSuffix };
}

/**
 * Minimal HTML escaper — patient names and surgery names are user input
 * and arrive in the response as-is, so we have to neutralise the five
 * characters that change HTML parsing. We deliberately don't pull in a
 * whole templating library: the landing page is a few hundred bytes of
 * static markup with a handful of interpolations.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const LANG_NAMES: Record<string, string> = {
  en: "English",
  pl: "Polish",
  uk: "Ukrainian",
  ar: "Arabic",
  ur: "Urdu",
  ps: "Pashto",
  so: "Somali",
};

function languageLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return LANG_NAMES[code] ?? code;
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  // British English wording per the pilot — `en-GB` for the date format
  // (e.g. "8 May 2026") so a UK clinician reads it the same way they'd
  // read a hospital letter.
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatExpiry(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function renderLandingHtml(args: {
  patientName: string;
  surgeryName: string;
  appointmentDate: string;
  languagePair: string;
  expiry: string;
}): string {
  const safe = {
    patient: escapeHtml(args.patientName),
    surgery: escapeHtml(args.surgeryName),
    date: escapeHtml(args.appointmentDate),
    langs: escapeHtml(args.languagePair),
    expiry: escapeHtml(args.expiry),
  };
  // Note: relative URL on the button — keeps the page working whether
  // the surgery scanned a same-origin link or it was rewritten by an
  // intermediate proxy. We append `?pdf=1` to the current path rather
  // than constructing an absolute URL.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Patient summary — Safeguard</title>
    <meta name="robots" content="noindex, nofollow" />
    <style>
      :root {
        color-scheme: light;
        --fg: #0f172a;
        --muted: #475569;
        --border: #e2e8f0;
        --bg: #f8fafc;
        --card: #ffffff;
        --primary: #1d4ed8;
        --primary-fg: #ffffff;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
        line-height: 1.5;
        padding: 24px 16px 40px;
        display: flex;
        justify-content: center;
      }
      main {
        width: 100%;
        max-width: 520px;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 24px;
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
      }
      h1 {
        font-size: 1.25rem;
        margin: 0 0 4px;
      }
      .lede { color: var(--muted); margin: 0 0 20px; font-size: 0.95rem; }
      dl { margin: 0 0 24px; padding: 0; }
      dt { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-top: 14px; }
      dt:first-of-type { margin-top: 0; }
      dd { margin: 2px 0 0; font-size: 1rem; font-weight: 500; }
      .cta {
        display: inline-block;
        background: var(--primary);
        color: var(--primary-fg);
        text-decoration: none;
        padding: 12px 20px;
        border-radius: 8px;
        font-weight: 600;
        font-size: 1rem;
      }
      .cta:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }
      .note {
        margin-top: 18px;
        font-size: 0.85rem;
        color: var(--muted);
        border-top: 1px solid var(--border);
        padding-top: 14px;
      }
      .footer {
        margin-top: 18px;
        font-size: 0.75rem;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main data-testid="public-export-landing">
      <h1>Patient summary</h1>
      <p class="lede">Shared with ${safe.surgery} via Safeguard.</p>
      <dl>
        <dt>Patient</dt>
        <dd data-testid="landing-patient">${safe.patient}</dd>
        <dt>Appointment date</dt>
        <dd data-testid="landing-date">${safe.date}</dd>
        <dt>Language pair</dt>
        <dd data-testid="landing-langs">${safe.langs}</dd>
      </dl>
      <a class="cta" href="?pdf=1" data-testid="landing-open-pdf">Open PDF</a>
      <p class="note">
        This link is single-purpose and expires on ${safe.expiry}. It only
        opens this patient's pre-appointment summary — nothing else.
      </p>
      <p class="footer">Safeguard pilot. Not a clinical record system.</p>
    </main>
  </body>
</html>`;
}

const wantsPdf = (req: { query: Record<string, unknown> }): boolean => {
  const v = req.query["pdf"];
  return v === "1" || v === "true";
};

async function sendPdf(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  row: TokenRow,
): Promise<void> {
  void req;
  const now = new Date();
  await db
    .update(safeguardAppointmentExportDeliveriesTable)
    .set({ fetchedAt: now, status: "delivered" })
    .where(
      eq(safeguardAppointmentExportDeliveriesTable.id, row.deliveryId),
    );
  const bytes = Buffer.from(row.pdfBase64, "base64");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="safeguard-export.pdf"`,
  );
  res.setHeader("Cache-Control", "no-store");
  res.send(bytes);
}

const handler: RequestHandler = async (req, res, next) => {
  try {
    const parsed = parseToken(req.params.token);
    if (!parsed) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    const row = await loadByToken(parsed.token);
    if (!row) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      if (parsed.legacyPdfSuffix || wantsPdf(req)) {
        res.status(410).json({ error: "expired" });
        return;
      }
      res
        .status(410)
        .type("text/plain")
        .send(
          "This link has expired. Please ask the patient to share a new one.",
        );
      return;
    }
    // Legacy `.pdf` URL or explicit `?pdf=1` → serve the PDF and stamp
    // fetchedAt. Otherwise render the friendly landing page (which does
    // NOT mark the delivery as opened — that only happens when the PDF
    // is actually fetched).
    if (parsed.legacyPdfSuffix || wantsPdf(req)) {
      await sendPdf(req, res, row);
      return;
    }
    const html = renderLandingHtml({
      patientName: row.preferredName?.trim() || "(name withheld)",
      surgeryName:
        row.surgeryName?.trim() || row.recipient?.trim() || "the surgery",
      appointmentDate: formatDate(row.appointmentCreatedAt),
      languagePair: `${languageLabel(row.patientLang)} ↔ ${languageLabel(
        row.clinicianLang,
      )}`,
      expiry: formatExpiry(row.expiresAt),
    });
    res.status(200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (err) {
    next(err);
  }
};

// Single route handles both shapes:
//   /public/exports/:token         → HTML landing page (or PDF if `?pdf=1`)
//   /public/exports/:token.pdf     → legacy alias, always serves the PDF
// The `.pdf` suffix is stripped inside `parseToken` rather than expressed
// as a separate route pattern so we don't depend on Express 5 /
// path-to-regexp v8 quirks around literal extensions on params.
router.get("/public/exports/:token", handler);

export default router;
