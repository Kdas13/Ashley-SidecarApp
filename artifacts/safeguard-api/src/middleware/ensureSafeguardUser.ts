import type { RequestHandler } from "express";
import { db, safeguardUsersTable } from "@workspace/db";

/**
 * Idempotent upsert of the safeguard_users row keyed on the verified Clerk
 * user id. Runs on every authenticated request so downstream handlers can
 * assume the user row exists (FK targets won't fail) without each one
 * having to remember to call ensureUser().
 *
 * Safe to call concurrently — relies on PK conflict + onConflictDoNothing.
 */
export const ensureSafeguardUser: RequestHandler = async (req, _res, next) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) return next();
    await db
      .insert(safeguardUsersTable)
      .values({ id: userId })
      .onConflictDoNothing({ target: safeguardUsersTable.id });
    next();
  } catch (err) {
    next(err);
  }
};
