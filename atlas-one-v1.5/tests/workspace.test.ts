import { describe, expect, it } from 'vitest';

import { AndroidWorkspaceService } from '../src/workspace/android-workspace.js';

describe('Android workspace service', () => {
  it('detects added, changed and removed files', async () => {
    let files = [
      { name: 'one.txt', uri: 'tree://one', size: 3 },
      { name: 'two.txt', uri: 'tree://two', size: 3 },
    ];
    const bytes = new Map<string, Uint8Array>([
      ['tree://one', new TextEncoder().encode('one')],
      ['tree://two', new TextEncoder().encode('two')],
    ]);
    let index: any[] = [];

    const service = new AndroidWorkspaceService(
      {
        requestDirectoryPermission: async () => ({ granted: true, directoryUri: 'tree://root' }),
        persistDirectoryUri: async () => undefined,
        loadDirectoryUri: async () => 'tree://root',
        listFiles: async () => files,
        readFile: async (uri) => bytes.get(uri) ?? new Uint8Array(),
        writeFile: async () => 'tree://written',
      },
      {
        replace: async (entries) => { index = entries; },
        list: async () => index,
      },
    );

    expect(await service.reindex()).toEqual({ added: 2, changed: 0, removed: 0 });
    files = [{ name: 'one.txt', uri: 'tree://one', size: 7 }];
    bytes.set('tree://one', new TextEncoder().encode('changed'));
    expect(await service.reindex()).toEqual({ added: 0, changed: 1, removed: 1 });
  });
});
