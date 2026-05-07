/**
 * Public, token-gated PDF fetch for surgery scans / shared links.
 *
 * Mounted OUTSIDE the Clerk gate in `app.ts`. Authentication is the
 * opaque `accessToken` minted by the deliver endpoint — no Clerk session,
 * no patient identifier in the URL. The token grants read-only access to
 * exactly one stored export PDF and stops working once `expiresAt` has
 * passed.
 *
 * The lookup is keyed on `accessToken` only — both the `qr` and
 * `nhs_app` channels mint tokens that resolve through this route. The
 * `accessToken` column has a unique index so we don't need a channel
 * filter to disambiguate.
 *
 * Each successful fetch updates `fetchedAt` so the patient's review
 * screen can show "Opened by {recipient} at {when}". We don't delete the
 * row on first scan — the audit trail is more useful than single-shot
 * semantics, and any single token is the patient's to share or revoke.
 */

import { Router, type IRouter, type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  safeguardAppointmentExportDeliveriesTable,
  safeguardAppointmentExportsTable,
} from "@workspace/db";

const router: IRouter = Router();

const handler: RequestHandler = async (req, res, next) => {
  try {
    const rawToken = req.params.token;
    const token =
      typeof rawToken === "string" ? rawToken.trim() : "";
    if (!token || token.length > 200) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const rows = await db
      .select({
        deliveryId: safeguardAppointmentExportDeliveriesTable.id,
        expiresAt: safeguardAppointmentExportDeliveriesTable.expiresAt,
        channel: safeguardAppointmentExportDeliveriesTable.channel,
        pdfBase64: safeguardAppointmentExportsTable.pdfBase64,
      })
      .from(safeguardAppointmentExportDeliveriesTable)
      .innerJoin(
        safeguardAppointmentExportsTable,
        eq(
          safeguardAppointmentExportDeliveriesTable.exportId,
          safeguardAppointmentExportsTable.id,
        ),
      )
      .where(
        eq(safeguardAppointmentExportDeliveriesTable.accessToken, token),
      );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      res.status(410).json({ error: "expired" });
      return;
    }
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
    return;
  } catch (err) {
    next(err);
  }
};

router.get("/public/exports/:token.pdf", handler);

export default router;
