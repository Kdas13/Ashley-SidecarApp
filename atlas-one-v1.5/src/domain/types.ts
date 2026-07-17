export type ConversationStatus = 'active' | 'paused' | 'archived';
export type IntentKind =
  | 'question'
  | 'command'
  | 'correction'
  | 'clarification'
  | 'confirmation'
  | 'artifact_reference'
  | 'topic_shift';

export type ArtifactLocation = 'private' | 'workspace' | 'exported';
export type ArtifactKind = 'document' | 'image' | 'audio' | 'code' | 'data' | 'other';

export interface ConversationTurn {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
  artifactIds: string[];
}

export interface ConversationState {
  conversationId: string;
  projectId?: string;
  status: ConversationStatus;
  currentObjective?: string;
  activeTopic?: string;
  latestIntent?: IntentKind;
  unresolvedQuestion?: string;
  correctionTargetTurnId?: string;
  referencedArtifactIds: string[];
  pendingActionId?: string;
  lastAssistantTurnId?: string;
  updatedAt: string;
}

export interface ArtifactVersion {
  id: string;
  artifactId: string;
  version: number;
  checksum: string;
  mimeType: string;
  byteSize: number;
  location: ArtifactLocation;
  uri: string;
  createdAt: string;
  createdByTurnId?: string;
  parentVersionId?: string;
}

export interface ArtifactRecord {
  id: string;
  projectId?: string;
  conversationId?: string;
  kind: ArtifactKind;
  name: string;
  description?: string;
  currentVersionId: string;
  versions: ArtifactVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface ResponseAssessment {
  accepted: boolean;
  duplicateScore: number;
  contradictionDetected: boolean;
  ignoredCorrection: boolean;
  reasons: string[];
}
