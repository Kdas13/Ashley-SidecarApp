// Deliverable mode detection.
// When the user message implies a structured output (plan, list, spec, guide,
// document) rather than a conversational turn, the chat routes inject
// buildDeliverableModeBlock() into the system prompt so Ashley knows to
// produce clean, copy-pasteable output with no embodied reactions inside the body.

const DELIVERABLE_PATTERNS: RegExp[] = [
  /\bwrite\s+(?:me\s+)?(?:a|an|the|up|out)\b/i,
  /\bdraft\s+(?:me\s+)?(?:a|an|the)\b/i,
  /\bfor\s+samsung\s+notes?\b/i,
  /\bfor\s+(?:my\s+)?notes?\b/i,
  /\bmake\s+(?:me\s+)?(?:a|an)\s+(?:list|plan|spec|guide|summary|outline|template|schedule|checklist|breakdown|overview)\b/i,
  /\bcreate\s+(?:me\s+)?(?:a|an)\s+(?:list|plan|spec|guide|summary|outline|template|schedule|checklist|breakdown|overview)\b/i,
  /\bstep[- ]by[- ]step\b/i,
  /\bput\s+together\s+(?:a|an)\b/i,
  /\bgive\s+me\s+(?:a|an)\s+(?:full|complete|detailed|proper)\b/i,
  /\bwrite\s+(?:it\s+)?up\b/i,
  /\bwrite\s+out\b/i,
  /\bdrop\s+(?:it\s+)?into\s+(?:notes?|samsung)\b/i,
  /\bpull\s+(?:that\s+)?together\b/i,
  /\blay\s+(?:it|that)\s+out\b/i,
  /\bbreak\s+(?:it|that)\s+down\b/i,
];

export function isDeliverableRequest(userMessage: string): boolean {
  return DELIVERABLE_PATTERNS.some((p) => p.test(userMessage));
}

export function buildDeliverableModeBlock(): string {
  return `## This turn: Deliverable Mode
The request shape implies a structured output — a plan, list, spec, guide, summary, or document intended for use outside this chat. Rules for this turn only:

1. Produce the full deliverable. Length cap is raised — do not truncate or summarise what should be detailed.
2. No embodied reactions inside the deliverable body. No *leans in*, no warmth phrases, no sighing mid-document. The output must be clean enough to copy-paste directly into Samsung Notes or anywhere else.
3. A short warm intro line before the body and a short sign-off after it are fine. They stay outside the document — they do not interrupt it.
4. If the output is long, deliver it all in one reply where possible. If continuation is unavoidable, say so explicitly at the end of the first part.
5. Normal Ashley reply style — short paragraphs, warmth, embodied presence — resumes on the next conversational turn after this one.`;
}
