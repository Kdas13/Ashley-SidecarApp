import type { ConversationState, ConversationTurn, ResponseAssessment } from '../domain/types.js';

export function assessResponse(
  candidate: string,
  recentTurns: ConversationTurn[],
  state: ConversationState,
): ResponseAssessment {
  const recentAssistant = recentTurns.filter((turn) => turn.role === 'assistant').slice(-4);
  const duplicateScore = Math.max(0, ...recentAssistant.map((turn) => similarity(candidate, turn.content)));
  const ignoredCorrection = Boolean(
    state.correctionTargetTurnId &&
      duplicateScore >= 0.72 &&
      !acknowledgesCorrection(candidate),
  );
  const contradictionDetected = contradictsKnownState(candidate, state);
  const reasons: string[] = [];

  if (duplicateScore >= 0.88) reasons.push('near_duplicate');
  if (ignoredCorrection) reasons.push('ignored_correction');
  if (contradictionDetected) reasons.push('state_contradiction');

  return {
    accepted: reasons.length === 0,
    duplicateScore,
    contradictionDetected,
    ignoredCorrection,
    reasons,
  };
}

export function buildRetryInstruction(assessment: ResponseAssessment, state: ConversationState): string {
  return [
    'RESPONSE REJECTED BEFORE DISPLAY.',
    `Reasons: ${assessment.reasons.join(', ') || 'unknown'}.`,
    state.unresolvedQuestion ? `Answer the unresolved user point directly: ${state.unresolvedQuestion}` : '',
    state.correctionTargetTurnId ? 'The user corrected or reframed the previous answer. Do not restate it.' : '',
    'Produce a materially different answer. Address the latest intent first. Do not repeat stock wording.',
  ].filter(Boolean).join('\n');
}

function acknowledgesCorrection(text: string): boolean {
  return /\b(understand|different|you are asking|the point|instead|not the same|correction)\b/i.test(text);
}

function contradictsKnownState(text: string, state: ConversationState): boolean {
  if (state.referencedArtifactIds.length > 0 && /\b(no files?|cannot access any|nothing created)\b/i.test(text)) return true;
  if (state.pendingActionId && /\bcompleted|done|finished successfully\b/i.test(text)) return true;
  return false;
}

function similarity(left: string, right: string): number {
  const a = shingles(normalize(left));
  const b = shingles(normalize(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function shingles(value: string): Set<string> {
  const words = value.split(' ').filter(Boolean);
  const result = new Set<string>();
  for (let index = 0; index < words.length - 2; index += 1) {
    result.add(words.slice(index, index + 3).join(' '));
  }
  return result;
}
