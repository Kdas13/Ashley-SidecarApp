import { createHash } from 'node:crypto';

export interface WorkspaceAdapter {
  requestDirectoryPermission(): Promise<{ granted: boolean; directoryUri?: string }>;
  persistDirectoryUri(uri: string): Promise<void>;
  loadDirectoryUri(): Promise<string | null>;
  listFiles(uri: string): Promise<Array<{ name: string; uri: string; size: number; modifiedAt?: string }>>;
  readFile(uri: string): Promise<Uint8Array>;
  writeFile(directoryUri: string, name: string, bytes: Uint8Array, mimeType: string): Promise<string>;
}

export interface WorkspaceIndexEntry {
  name: string;
  uri: string;
  size: number;
  checksum: string;
  modifiedAt?: string;
  indexedAt: string;
}

export interface WorkspaceIndexStore {
  replace(entries: WorkspaceIndexEntry[]): Promise<void>;
  list(): Promise<WorkspaceIndexEntry[]>;
}

export class AndroidWorkspaceService {
  constructor(
    private readonly adapter: WorkspaceAdapter,
    private readonly indexStore: WorkspaceIndexStore,
  ) {}

  async connect(): Promise<string> {
    const permission = await this.adapter.requestDirectoryPermission();
    if (!permission.granted || !permission.directoryUri) {
      throw new Error('Workspace permission was not granted');
    }
    await this.adapter.persistDirectoryUri(permission.directoryUri);
    await this.reindex();
    return permission.directoryUri;
  }

  async status(): Promise<{ connected: boolean; directoryUri?: string; fileCount: number }> {
    const directoryUri = await this.adapter.loadDirectoryUri();
    const entries = await this.indexStore.list();
    return {
      connected: Boolean(directoryUri),
      ...(directoryUri ? { directoryUri } : {}),
      fileCount: entries.length,
    };
  }

  async reindex(): Promise<{ added: number; changed: number; removed: number }> {
    const directoryUri = await this.requireDirectory();
    const previous = await this.indexStore.list();
    const previousByUri = new Map(previous.map((entry) => [entry.uri, entry]));
    const files = await this.adapter.listFiles(directoryUri);
    const next: WorkspaceIndexEntry[] = [];
    let added = 0;
    let changed = 0;

    for (const file of files) {
      const bytes = await this.adapter.readFile(file.uri);
      const checksum = createHash('sha256').update(bytes).digest('hex');
      const before = previousByUri.get(file.uri);
      if (!before) added += 1;
      else if (before.checksum !== checksum || before.size !== file.size) changed += 1;
      next.push({
        name: file.name,
        uri: file.uri,
        size: file.size,
        checksum,
        ...(file.modifiedAt ? { modifiedAt: file.modifiedAt } : {}),
        indexedAt: new Date().toISOString(),
      });
    }

    const nextUris = new Set(next.map((entry) => entry.uri));
    const removed = previous.filter((entry) => !nextUris.has(entry.uri)).length;
    await this.indexStore.replace(next);
    return { added, changed, removed };
  }

  async write(name: string, bytes: Uint8Array, mimeType: string): Promise<string> {
    const directoryUri = await this.requireDirectory();
    const uri = await this.adapter.writeFile(directoryUri, sanitizeName(name), bytes, mimeType);
    await this.reindex();
    return uri;
  }

  private async requireDirectory(): Promise<string> {
    const directoryUri = await this.adapter.loadDirectoryUri();
    if (!directoryUri) throw new Error('No Android workspace has been authorised');
    return directoryUri;
  }
}

function sanitizeName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  if (!safe) throw new Error('Artifact name is empty after sanitisation');
  return safe;
}
