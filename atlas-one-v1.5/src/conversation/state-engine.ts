import type { ConversationState, ConversationTurn, IntentKind } from '../domain/types.js';

const CORRECTION = /\b(no|not that|wrong|actually|i meant|that's different|you misunderstood|stop repeating)\b/i;
const CLARIFICATION = /\b(i mean|what i am saying|to clarify|the point is|what i wanted)\b/i;
const CONFIRMATION = /\b(yes|correct|exactly|perfect|that's right|good)\b/i;
const QUESTION = /\?|\b(what|why|how|when|where|who|can you|do you|have you)\b/i;
const COMMAND = /\b(create|make|build|send|generate|download|save|edit|revise|delete|run|check)\b/i;
const ARTIFACT = /\b(file|document|image|pdf|docx|txt|spreadsheet|presentation|artifact|folder|workspace)\b/i;

export function classifyIntent(text: string, previousUserText?: string): IntentKind {
  const value = text.trim();
  if (CORRECTION.test(value)) return 'correction';
  if (CLARIFICATION.test(value)) return 'clarification';
  if (CONFIRMATION.test(value) && value.length < 120) return 'confirmation';
  if (ARTIFACT.test(value) && !COMMAND.test(value)) return 'artifact_reference';
  if (QUESTION.test(value) && !COMMAND.test(value)) return 'question';
  if (COMMAND.test(value)) return 'command';
  if (previousUserText && lexicalDistance(previousUserText, value) > 0.82) return 'topic_shift';
  return 'question';
}

export function reduceConversationState(
  current: ConversationState,
  turn: ConversationTurn,
  previousUserText?: string,
): ConversationState {
  if (turn.role !== 'user') {
    return {
      ...current,
      lastAssistantTurnId: turn.role === 'assistant' ? turn.id : current.lastAssistantTurnId,
      updatedAt: turn.createdAt,
    };
  }

  const intent = classifyIntent(turn.content, previousUserText);
  const next: ConversationState = {
    ...current,
    latestIntent: intent,
    referencedArtifactIds: unique([...current.referencedArtifactIds, ...turn.artifactIds]),
    updatedAt: turn.createdAt,
  };

  if (intent === 'correction' || intent === 'clarification') {
    next.correctionTargetTurnId = current.lastAssistantTurnId;
    next.unresolvedQuestion = turn.content;
    next.currentObjective = turn.content;
  } else if (intent === 'question' || intent === 'artifact_reference') {
    next.unresolvedQuestion = turn.content;
  } else if (intent === 'command' || intent === 'topic_shift') {
    next.currentObjective = turn.content;
    next.activeTopic = inferTopic(turn.content);
    next.unresolvedQuestion = undefined;
    next.correctionTargetTurnId = undefined;
  } else if (intent === 'confirmation') {
    next.unresolvedQuestion = undefined;
    next.correctionTargetTurnId = undefined;
  }

  return next;
}

function inferTopic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 3)
    .slice(0, 8)
    .join(' ');
}

function lexicalDistance(left: string, right: string): number {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  const union = new Set([...a, ...b]).size;
  if (union === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return 1 - intersection / union;
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
