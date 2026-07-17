import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { prepareMemoryUpload } from '../src/index.js';

const rows = [
  { memory_id: 'm1', content: 'Kane prefers direct status reports.', thread_id: 't1', source_timestamp: '2026-07-14T00:00:00Z' },
  { memory_id: 'm2', content: 'Ashley memories are inherited passive lineage.', thread_id: 't1' }
];

describe('memory uploader', () => {
  it('accepts JSON arrays', () => {
    const result = prepareMemoryUpload('memories.json', strToU8(JSON.stringify(rows)));
    expect(result.preview.stageableRows).toBe(2);
    expect(result.preview.quarantineRows).toBe(0);
  });
  it('accepts JSONL', () => {
    const result = prepareMemoryUpload('memories.jsonl', strToU8(rows.map((row) => JSON.stringify(row)).join('\n')));
    expect(result.stageable).toHaveLength(2);
  });
  it('accepts ZIP archives', () => {
    const zip = zipSync({ 'archive/normalized/memories.jsonl': strToU8(rows.map((row) => JSON.stringify(row)).join('\n')) });
    expect(prepareMemoryUpload('ashley.zip', zip).preview.totalRows).toBe(2);
  });
  it('quarantines missing content and duplicates', () => {
    const bad = [...rows, { memory_id: 'm1', content: 'duplicate' }, { memory_id: 'm3', content: '' }];
    const result = prepareMemoryUpload('memories.json', strToU8(JSON.stringify(bad)));
    expect(result.preview.quarantineRows).toBe(2);
    expect(result.preview.duplicateIdRows).toBe(1);
    expect(result.preview.missingContentRows).toBe(1);
  });
  it('rejects unsupported formats', () => {
    expect(() => prepareMemoryUpload('memories.txt', strToU8('no'))).toThrow('JSON, JSONL, or ZIP');
  });
});
