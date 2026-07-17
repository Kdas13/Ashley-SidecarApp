import { createHash, randomUUID } from 'node:crypto';

import type { ArtifactKind, ArtifactLocation, ArtifactRecord, ArtifactVersion } from '../domain/types.js';

export interface ArtifactStore {
  save(record: ArtifactRecord): Promise<void>;
  get(id: string): Promise<ArtifactRecord | null>;
  findByName(name: string): Promise<ArtifactRecord[]>;
}

export class ArtifactRegistry {
  constructor(private readonly store: ArtifactStore) {}

  async register(input: {
    name: string;
    kind: ArtifactKind;
    mimeType: string;
    bytes: Uint8Array;
    location: ArtifactLocation;
    uri: string;
    projectId?: string;
    conversationId?: string;
    createdByTurnId?: string;
  }): Promise<ArtifactRecord> {
    const now = new Date().toISOString();
    const artifactId = randomUUID();
    const version = this.makeVersion(artifactId, 1, input, now);
    const record: ArtifactRecord = {
      id: artifactId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      kind: input.kind,
      name: input.name,
      currentVersionId: version.id,
      versions: [version],
      createdAt: now,
      updatedAt: now,
    };
    await this.store.save(record);
    return record;
  }

  async addVersion(
    artifactId: string,
    input: {
      mimeType: string;
      bytes: Uint8Array;
      location: ArtifactLocation;
      uri: string;
      createdByTurnId?: string;
    },
  ): Promise<ArtifactRecord> {
    const existing = await this.store.get(artifactId);
    if (!existing) throw new Error(`Artifact not found: ${artifactId}`);
    const now = new Date().toISOString();
    const version = this.makeVersion(artifactId, existing.versions.length + 1, input, now, existing.currentVersionId);
    const updated: ArtifactRecord = {
      ...existing,
      currentVersionId: version.id,
      versions: [...existing.versions, version],
      updatedAt: now,
    };
    await this.store.save(updated);
    return updated;
  }

  async resolveReference(reference: string): Promise<ArtifactRecord[]> {
    const exact = await this.store.get(reference);
    if (exact) return [exact];
    return this.store.findByName(reference.trim().toLowerCase());
  }

  private makeVersion(
    artifactId: string,
    number: number,
    input: {
      mimeType: string;
      bytes: Uint8Array;
      location: ArtifactLocation;
      uri: string;
      createdByTurnId?: string;
    },
    createdAt: string,
    parentVersionId?: string,
  ): ArtifactVersion {
    return {
      id: randomUUID(),
      artifactId,
      version: number,
      checksum: createHash('sha256').update(input.bytes).digest('hex'),
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      location: input.location,
      uri: input.uri,
      createdAt,
      ...(input.createdByTurnId ? { createdByTurnId: input.createdByTurnId } : {}),
      ...(parentVersionId ? { parentVersionId } : {}),
    };
  }
}
