---
name: Image context continuity fix
description: How user-sent images are preserved in Ashley's conversation history across all turns.
---

## The bug
Captionless image turns were silently dropped from history by the `if (!text) continue` guard in both history builders (text chat line ~1567, streaming chat line ~5107). Images with captions survived but only as the caption text — no record of what Ashley actually saw. imageDescription column existed in schema but was never populated.

## The fix (both parts must be applied together)

**Option A — silent drop fix:**
All three history builders (text, streaming, image route) now detect `m.imageUrl && m.role === "user"` and always emit a placeholder, never `continue`. Captionless photos become `[shared a photo (category)]` at minimum.

**Option B — visual description storage:**
`/chat/image` route injects this into `modelHint` (the user turn hint in `finalContent`):
> "begin your reply with exactly one line in this exact format — [VISUAL: one-sentence factual description of what you see in the image]"

After the vision call, a regex extracts the tag, strips it from `assistantText` before persisting/sending, and stores it in `messages.image_description` via an UPDATE on the user row.

**Placeholder format (all three builders, consistent):**
```typescript
const captionPart = text ? `"${text}"` : null;
const descPart = m.imageDescription ?? null;
const parts = [captionPart, descPart].filter(Boolean).join(" — ");
text = `[shared a photo${cat}${parts ? `: ${parts}` : ""}]`;
```
This combines BOTH caption and visual description — not one-or-the-other.

## Result
`[shared a photo (other): "that's me and you" — a bald man dancing with a woman in red satin dress in a garden with string lights]`

## Migration
`ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_description text;`
Applied via node-pg script (executeSql callback broken in session; drizzle-kit generate still broken).

**Why:** executeSql in code_execution keeps cancelling in some sessions. Use node script with `../../node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js` as the import path.

## Audit finding
Only images were broken. Text, voice PTT (transcription → normal chat), proactive, app-open greeting, memory distiller, and summariser are all unified.
