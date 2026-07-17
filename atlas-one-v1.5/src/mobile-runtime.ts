export type RuntimeRole = 'user' | 'assistant' | 'system';
export type RuntimeTurn = { role: RuntimeRole; content: string; artifactName?: string | null };
export type IntentKind =
  | 'correction'
  | 'clarification'
  | 'confirmation'
  | 'artifact_reference'
  | 'workspace_design'
  | 'document_creation'
  | 'command'
  | 'question'
  | 'topic_shift';

export type ConversationSnapshot = {
  latestUserText: string;
  previousUserText: string;
  previousAssistantText: string;
  intent: IntentKind;
  topicChanged: boolean;
  correctionActive: boolean;
  artifactNames: string[];
};

export type CandidateAssessment = {
  accepted: boolean;
  similarity: number;
  reasons: string[];
};

const CORRECTION = /\b(no|not that|wrong|actually|i meant|that's different|you misunderstood|stop repeating|come on|that is not what)\b/i;
const CLARIFICATION = /\b(i mean|what i am saying|to clarify|the point is|what i wanted|what i was hoping|moving forward)\b/i;
const CONFIRMATION = /\b(yes|correct|exactly|perfect|that's right|good|understood)\b/i;
const QUESTION = /\?|\b(what|why|how|when|where|who|can you|do you|have you|is there|are you)\b/i;
const COMMAND = /\b(create|make|build|send|generate|download|save|edit|revise|delete|run|check|proceed|start|implement)\b/i;
const ARTIFACT = /\b(file|document|image|pdf|docx|txt|spreadsheet|presentation|artifact)\b/i;
const WORKSPACE = /\b(folder|android device|workspace|external memory|working memory|offload|overload|storage access)\b/i;
const DOCUMENT_CREATE = /\b(create|make|generate|write|prepare|produce|export|convert|save as|give me|send me)\b[\s\S]{0,120}\b(txt|text file|markdown|md|pdf|docx|word document|document|file|csv|json|html)\b/i;
const EXISTING_ARTIFACT = /\b(still have|have access|can you (?:see|read|open|access|revise|edit|reuse)|do you (?:have|still have)|what about (?:it|the file)|that file|that document)\b/i;

export function classifyIntent(text: string, previousUserText = ''): IntentKind {
  const value = text.trim();
  if (CORRECTION.test(value)) return 'correction';
  if (CLARIFICATION.test(value)) return 'clarification';
  if (WORKSPACE.test(value) && !DOCUMENT_CREATE.test(value)) return 'workspace_design';
  if (DOCUMENT_CREATE.test(value) && !EXISTING_ARTIFACT.test(value)) return 'document_creation';
  if (CONFIRMATION.test(value) && value.length < 120) return 'confirmation';
  if (ARTIFACT.test(value) && !COMMAND.test(value)) return 'artifact_reference';
  if (QUESTION.test(value) && !COMMAND.test(value)) return 'question';
  if (COMMAND.test(value)) return 'command';
  if (previousUserText && lexicalDistance(previousUserText, value) > 0.82) return 'topic_shift';
  return 'question';
}

export function deriveConversationSnapshot(turns: RuntimeTurn[]): ConversationSnapshot {
  const users = turns.filter((turn) => turn.role === 'user');
  const assistants = turns.filter((turn) => turn.role === 'assistant');
  const latestUserText = users.at(-1)?.content ?? '';
  const previousUserText = users.at(-2)?.content ?? '';
  const previousAssistantText = assistants.at(-1)?.content ?? '';
  const intent = classifyIntent(latestUserText, previousUserText);
  const topicChanged = intent === 'topic_shift' || lexicalDistance(previousUserText, latestUserText) > 0.82;
  return {
    latestUserText,
    previousUserText,
    previousAssistantText,
    intent,
    topicChanged,
    correctionActive: intent === 'correction' || intent === 'clarification',
    artifactNames: [...new Set(turns.map((turn) => turn.artifactName).filter((name): name is string => Boolean(name)))],
  };
}

export function shouldForceDocumentTool(snapshot: ConversationSnapshot): boolean {
  return snapshot.intent === 'document_creation';
}

export function buildFoundationInstruction(snapshot: ConversationSnapshot): string {
  return [
    'ATLAS ONE v1.5 CONVERSATION STATE:',
    `Latest intent: ${snapshot.intent}.`,
    snapshot.correctionActive
      ? 'The user corrected or clarified the previous response. Address the changed point first and do not restate the old answer.'
      : '',
    snapshot.topicChanged
      ? 'The user changed topic or objective. Do not continue the previous answer or repeat its conclusion.'
      : '',
    snapshot.intent === 'artifact_reference'
      ? 'This is a question about an existing artifact, not permission to create another copy.'
      : '',
    snapshot.intent === 'workspace_design'
      ? 'The user is discussing a persistent user-authorised Android workspace. Answer that architecture directly; do not repeat a generic app-private-file explanation.'
      : '',
    snapshot.artifactNames.length
      ? `Known artifact names: ${snapshot.artifactNames.slice(-12).join(', ')}.`
      : 'No registered artifacts are present in this conversation.',
    `Latest user point: ${snapshot.latestUserText.slice(0, 1800)}`,
  ].filter(Boolean).join('\n');
}

export function assessCandidateResponse(
  candidate: string,
  snapshot: ConversationSnapshot,
  recentAssistantTexts: string[],
): CandidateAssessment {
  const similarities = recentAssistantTexts.slice(-4).map((text) => similarity(candidate, text));
  const similarityScore = Math.max(0, ...similarities);
  const reasons: string[] = [];
  if (similarityScore >= 0.82) reasons.push('near_duplicate');
  if (snapshot.correctionActive && similarity(candidate, snapshot.previousAssistantText) >= 0.66) reasons.push('ignored_correction');
  if (snapshot.topicChanged && similarity(candidate, snapshot.previousAssistantText) >= 0.64) reasons.push('continued_old_topic');
  if (snapshot.intent === 'workspace_design' && /app-private working copy[\s\S]{0,200}upload/i.test(candidate)) {
    reasons.push('repeated_private_copy_script');
  }
  return { accepted: reasons.length === 0, similarity: similarityScore, reasons };
}

export function buildRetryInstruction(snapshot: ConversationSnapshot, assessment: CandidateAssessment): string {
  return [
    'RESPONSE REJECTED BEFORE DISPLAY.',
    `Reasons: ${assessment.reasons.join(', ') || 'failed conversation-state validation'}.`,
    `Latest user point: ${snapshot.latestUserText.slice(0, 1800)}`,
    snapshot.correctionActive ? 'The user corrected the previous answer. Do not repeat or paraphrase it.' : '',
    snapshot.topicChanged ? 'Treat this as a new objective. Stop continuing the old topic.' : '',
    snapshot.intent === 'workspace_design'
      ? 'Explain or act on the persistent Android workspace design. Do not repeat the app-private/exported-copy distinction unless the user asks for that exact distinction.'
      : '',
    'Produce a materially different answer that directly resolves the latest point.',
  ].filter(Boolean).join('\n');
}

function lexicalDistance(left: string, right: string): number {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  const union = new Set([...a, ...b]).size;
  if (!union) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return 1 - intersection / union;
}

function similarity(left: string, right: string): number {
  const a = shingles(normalize(left));
  const b = shingles(normalize(right));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(value: string): string[] {
  return normalize(value).split(' ').filter((token) => token.length > 2);
}

function shingles(value: string): Set<string> {
  const words = value.split(' ').filter(Boolean);
  const result = new Set<string>();
  if (words.length < 3) {
    if (value) result.add(value);
    return result;
  }
  for (let index = 0; index < words.length - 2; index += 1) result.add(words.slice(index, index + 3).join(' '));
  return result;
}
