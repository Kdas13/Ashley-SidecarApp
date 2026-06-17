// ---------------------------------------------------------------------------
// PersistentSessionStateGuard — P1-1 + G-1
//
// Fire-and-forget async write queue for VoiceSession state transitions.
// Each DB write is promise-chained per sessionId so that execution order
// always matches the in-memory transition order, even under rapid interrupts.
//
// G-1 resolved: chaining prevents DB lag causing registry drift.
// ---------------------------------------------------------------------------

import { db, activeSessionsTable } from "@workspace/db";

export interface IDBSessionStateUpdate {
  sessionId: string;
  deviceId: string;
  connectionGeneration: number;
  state: string;
  currentTurnId: string | null;
  currentResponseId: string | null;
  callStartTime: Date;
  updatedAt: Date;
}

export class PersistentSessionStateGuard {
  private static chains: Map<string, Promise<void>> = new Map();

  /**
   * Queue a session state write. Un-awaited by caller.
   * Writes are chained per sessionId — guaranteed in-order execution.
   * G-1: prevents DB lag causing registry drift under rapid interrupts.
   */
  static queue(update: IDBSessionStateUpdate): void {
    const current = this.chains.get(update.sessionId) ?? Promise.resolve();
    const next = current
      .then(() =>
        db
          .insert(activeSessionsTable)
          .values({
            sessionId: update.sessionId,
            deviceId: update.deviceId,
            connectionGeneration: update.connectionGeneration,
            state: update.state,
            currentTurnId: update.currentTurnId,
            currentResponseId: update.currentResponseId,
            callStartTime: update.callStartTime,
            updatedAt: update.updatedAt,
          })
          .onConflictDoUpdate({
            target: activeSessionsTable.sessionId,
            set: {
              deviceId: update.deviceId,
              connectionGeneration: update.connectionGeneration,
              state: update.state,
              currentTurnId: update.currentTurnId,
              currentResponseId: update.currentResponseId,
              callStartTime: update.callStartTime,
              updatedAt: update.updatedAt,
            },
          })
          .then(() => undefined),
      )
      .catch((err: unknown) => {
        console.error("[PersistentSessionStateGuard] write failed:", err);
      });
    this.chains.set(update.sessionId, next);
  }

  /**
   * Clear the chain for a session after it is fully closed.
   * Waits for the last write to settle before deleting the chain entry.
   * Call from finalise() after the terminal state write has queued.
   */
  static clearChain(sessionId: string): void {
    const last = this.chains.get(sessionId) ?? Promise.resolve();
    void last.finally(() => this.chains.delete(sessionId));
  }
}
