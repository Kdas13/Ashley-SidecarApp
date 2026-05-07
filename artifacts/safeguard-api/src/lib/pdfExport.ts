/**
 * GP-export PDF generator for Safeguard.
 *
 * Pure pdf-lib so it bundles cleanly with esbuild (no font binaries on
 * disk). Uses the standard Helvetica family — sufficient for Latin scripts
 * (English, Ukrainian-with-fallback). Non-Latin scripts in the patient's
 * own words are deliberately ALSO rendered as their original-language
 * source text alongside the English translation; if Helvetica cannot
 * render a glyph, pdf-lib will throw and we fall back to a "[non-Latin
 * source — see translation above]" placeholder. The PDF is intended to be
 * read by a clinician in their own language, with the translated summary
 * front-and-centre and the patient's verbatim words preserved.
 *
 * SAFEGUARDING:
 *   - Every translated/AI-generated section carries a visible AI-confidence
 *     warning.
 *   - Mental-health and safeguarding content is framed as observational.
 *   - Pilot-scope footer is always present.
 */

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFPage,
  type PDFFont,
} from "pdf-lib";
import { SAFEGUARDING_INVARIANTS } from "./safeguardingInvariants";

export interface PdfCheckinTrend {
  field: string;
  values: Array<{ at: string; score: number | null }>;
}

export interface PdfExportInput {
  generatedAt: Date;
  patient: {
    preferredName: string;
    patientLang: string;
    nativeLanguage: string;
    clinicianLang: string;
    countryOfOrigin: string;
    dateOfBirth: string;
    gpName: string;
    gpSurgery: string;
  };
  intake: {
    lang: string;
    answers: Record<string, string>;
  };
  patientSummary: {
    lang: string;
    text: string;
    confidence: string;
    notes: string;
    edited: boolean;
  } | null;
  clinicianSummary: {
    lang: string;
    text: string;
    confidence: string;
    notes: string;
  } | null;
  trends: PdfCheckinTrend[];
}

const PAGE_W = 595.28; // A4 width in pt
const PAGE_H = 841.89;
const MARGIN = 48;
const LINE = 14;

interface Cursor {
  page: PDFPage;
  y: number;
}

function safeAscii(s: string, fallback: string): string {
  // Helvetica only encodes WinAnsi; replace anything outside that range
  // with `?`. If everything is unrenderable, return the fallback.
  let any = false;
  const out = s
    .normalize("NFKC")
    .split("")
    .map((c) => {
      const code = c.charCodeAt(0);
      const ok =
        code === 10 ||
        code === 13 ||
        code === 9 ||
        (code >= 32 && code <= 126) ||
        (code >= 160 && code <= 255);
      if (ok) {
        any = true;
        return c;
      }
      return "?";
    })
    .join("");
  return any ? out : fallback;
}

function wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const paragraphs = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const p of paragraphs) {
    if (p.length === 0) {
      out.push("");
      continue;
    }
    const words = p.split(/\s+/);
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      const width = font.widthOfTextAtSize(test, size);
      if (width > maxW && line) {
        out.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function newPage(doc: PDFDocument): Cursor {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  return { page, y: PAGE_H - MARGIN };
}

function ensure(doc: PDFDocument, cur: Cursor, needed: number): Cursor {
  if (cur.y - needed < MARGIN + 30) {
    return newPage(doc);
  }
  return cur;
}

function drawText(
  doc: PDFDocument,
  cur: Cursor,
  text: string,
  opts: {
    font: PDFFont;
    size: number;
    color?: ReturnType<typeof rgb>;
    indent?: number;
  },
): Cursor {
  const indent = opts.indent ?? 0;
  const maxW = PAGE_W - MARGIN * 2 - indent;
  const lines = wrap(safeAscii(text, "[unsupported source — see translation]"), opts.font, opts.size, maxW);
  let c = cur;
  for (const line of lines) {
    c = ensure(doc, c, opts.size + 4);
    c.page.drawText(line, {
      x: MARGIN + indent,
      y: c.y - opts.size,
      size: opts.size,
      font: opts.font,
      color: opts.color ?? rgb(0, 0, 0),
    });
    c = { page: c.page, y: c.y - opts.size - 4 };
  }
  return c;
}

function spacer(cur: Cursor, n: number): Cursor {
  return { page: cur.page, y: cur.y - n };
}

function rule(doc: PDFDocument, cur: Cursor): Cursor {
  const c = ensure(doc, cur, 8);
  c.page.drawLine({
    start: { x: MARGIN, y: c.y - 4 },
    end: { x: PAGE_W - MARGIN, y: c.y - 4 },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  return spacer(c, 10);
}

const INTAKE_LABELS: Record<string, string> = {
  mainConcern: "Main concern",
  symptomDuration: "How long",
  severity: "Severity",
  medications: "Medications",
  allergies: "Allergies",
  sleep: "Sleep",
  appetite: "Appetite",
  painLevel: "Pain level",
  mentalHealth: "Mental health (observational)",
  safeguarding: "Safeguarding (observational)",
};

export async function generateGpExportPdf(input: PdfExportInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const helvOblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  let cur = newPage(doc);

  // Header
  cur = drawText(doc, cur, "Safeguard — GP appointment summary", {
    font: helvBold,
    size: 18,
  });
  cur = drawText(
    doc,
    cur,
    `Generated ${input.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    { font: helvOblique, size: 9, color: rgb(0.35, 0.35, 0.35) },
  );
  cur = spacer(cur, 6);

  // Standing AI-confidence warning
  cur = drawText(
    doc,
    cur,
    "AI confidence notice: Translated and AI-generated text in this document may " +
      "contain errors. Confidence levels are reported per section. The patient's " +
      "verbatim words are preserved alongside every translation. This document is " +
      "observational; it is not a diagnosis and not a clinical record.",
    { font: helvOblique, size: 9, color: rgb(0.3, 0, 0) },
  );
  cur = rule(doc, cur);

  // Patient block
  cur = drawText(doc, cur, "Patient", { font: helvBold, size: 12 });
  const p = input.patient;
  const patientFields: Array<[string, string]> = [
    ["Preferred name", p.preferredName || "—"],
    ["Date of birth", p.dateOfBirth || "—"],
    ["Country of origin", p.countryOfOrigin || "—"],
    ["Patient language", p.patientLang.toUpperCase()],
    ["Native language", p.nativeLanguage.toUpperCase()],
    ["Clinician language", p.clinicianLang.toUpperCase()],
    ["GP", `${p.gpName || "—"}${p.gpSurgery ? ` — ${p.gpSurgery}` : ""}`],
  ];
  for (const [k, v] of patientFields) {
    cur = drawText(doc, cur, `${k}: ${v}`, { font: helv, size: 10 });
  }
  cur = rule(doc, cur);

  // Clinician summary (front-and-centre)
  cur = drawText(doc, cur, "Clinician summary", { font: helvBold, size: 12 });
  if (input.clinicianSummary) {
    cur = drawText(
      doc,
      cur,
      `Language: ${input.clinicianSummary.lang.toUpperCase()} · AI confidence: ${input.clinicianSummary.confidence}` +
        (input.clinicianSummary.notes
          ? ` · Notes: ${input.clinicianSummary.notes}`
          : ""),
      { font: helvOblique, size: 9, color: rgb(0.35, 0.35, 0.35) },
    );
    cur = drawText(doc, cur, input.clinicianSummary.text, {
      font: helv,
      size: 11,
    });
  } else {
    cur = drawText(doc, cur, "(not generated)", {
      font: helvOblique,
      size: 10,
      color: rgb(0.4, 0.4, 0.4),
    });
  }
  cur = rule(doc, cur);

  // Patient summary (their own language, plain)
  cur = drawText(doc, cur, "Patient-facing summary", {
    font: helvBold,
    size: 12,
  });
  if (input.patientSummary) {
    cur = drawText(
      doc,
      cur,
      `Language: ${input.patientSummary.lang.toUpperCase()} · AI confidence: ${input.patientSummary.confidence}` +
        (input.patientSummary.edited ? " · Edited by patient" : "") +
        (input.patientSummary.notes
          ? ` · Notes: ${input.patientSummary.notes}`
          : ""),
      { font: helvOblique, size: 9, color: rgb(0.35, 0.35, 0.35) },
    );
    cur = drawText(doc, cur, input.patientSummary.text, {
      font: helv,
      size: 11,
    });
  } else {
    cur = drawText(doc, cur, "(not generated)", {
      font: helvOblique,
      size: 10,
      color: rgb(0.4, 0.4, 0.4),
    });
  }
  cur = rule(doc, cur);

  // Intake (verbatim, in source language)
  cur = drawText(
    doc,
    cur,
    `Intake — patient's own words (in ${input.intake.lang.toUpperCase()})`,
    { font: helvBold, size: 12 },
  );
  cur = drawText(
    doc,
    cur,
    "Preserved verbatim. Non-Latin scripts may render as placeholders in this PDF; the original is stored in the app.",
    { font: helvOblique, size: 9, color: rgb(0.35, 0.35, 0.35) },
  );
  for (const k of Object.keys(INTAKE_LABELS)) {
    const v = (input.intake.answers[k] ?? "").trim();
    if (!v) continue;
    cur = drawText(doc, cur, `${INTAKE_LABELS[k]}:`, {
      font: helvBold,
      size: 10,
    });
    cur = drawText(doc, cur, v, { font: helv, size: 10, indent: 12 });
    cur = spacer(cur, 2);
  }
  cur = rule(doc, cur);

  // Recent check-in trends
  cur = drawText(doc, cur, "Recent check-in trends", {
    font: helvBold,
    size: 12,
  });
  cur = drawText(
    doc,
    cur,
    "Self-reported scores from the patient's daily check-ins. Most recent first. Observational.",
    { font: helvOblique, size: 9, color: rgb(0.35, 0.35, 0.35) },
  );
  if (input.trends.length === 0) {
    cur = drawText(doc, cur, "(no recent check-ins)", {
      font: helvOblique,
      size: 10,
      color: rgb(0.4, 0.4, 0.4),
    });
  } else {
    for (const t of input.trends) {
      const recent = t.values
        .slice(0, 7)
        .map((v) => `${v.at.slice(0, 10)}: ${v.score ?? "—"}`)
        .join("  ");
      cur = drawText(doc, cur, `${t.field} → ${recent}`, {
        font: helv,
        size: 10,
      });
    }
  }
  cur = rule(doc, cur);

  // Invariants footer
  cur = drawText(doc, cur, "Pilot scope and operating principles", {
    font: helvBold,
    size: 11,
  });
  for (const inv of SAFEGUARDING_INVARIANTS) {
    cur = drawText(doc, cur, `• ${inv.title}: ${inv.rule}`, {
      font: helv,
      size: 9,
      color: rgb(0.25, 0.25, 0.25),
    });
  }
  cur = spacer(cur, 4);
  cur = drawText(
    doc,
    cur,
    "Safeguard is a pilot. Not affiliated with the NHS. Not a clinical record system. Nothing is shared without an action the patient takes.",
    { font: helvOblique, size: 8, color: rgb(0.4, 0.4, 0.4) },
  );

  // Footer page numbers
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    page.drawText(`Page ${i + 1} of ${pages.length}`, {
      x: PAGE_W - MARGIN - 60,
      y: MARGIN / 2,
      size: 8,
      font: helv,
      color: rgb(0.5, 0.5, 0.5),
    });
  });

  void LINE; // keep import for future tweaking
  return await doc.save();
}
