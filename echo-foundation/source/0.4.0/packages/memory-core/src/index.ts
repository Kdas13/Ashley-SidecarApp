import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import type { DatabasePool } from '@echo/database';
import { withTransaction } from '@echo/database';
import type { MemoryImportBatchSummary, MemoryImportPreview } from '@echo/contracts';

export interface PreparedMemoryRecord {
  originalId: string | null;
  content: string;
  contentHash: string;
  threadId: string | null;
  threadName: string | null;
  sourceFile: string;
  originalRecordIndex: number;
  sourceTimestamp: string | null;
  originalRawRecord: unknown;
}

export interface PreparedQuarantineRecord {
  sourceFile: string | null;
  originalRecordIndex: number | null;
  reasons: string[];
  rawRecord: unknown;
}

export interface PreparedAshleyImport {
  archivePath: string;
  archiveSha256: string;
  archiveSizeBytes: number;
  manifest: Record<string, unknown> & { source_system: string };
  preview: MemoryImportPreview;
  stageable: PreparedMemoryRecord[];
  quarantine: PreparedQuarantineRecord[];
}

export interface StageAshleyImportResult {
  dryRun: boolean;
  preview: MemoryImportPreview;
  batch: MemoryImportBatchSummary | null;
}

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const idOf = (row: Record<string, unknown>) => text(row.memory_id ?? row.id) || null;
const contentOf = (row: Record<string, unknown>) => text(row.content ?? row.text ?? row.summary ?? row.original_summary);
const threadIdOf = (row: Record<string, unknown>) => text(row.thread_id ?? row.threadId) || null;
const threadNameOf = (row: Record<string, unknown>) => text(row.thread_name ?? row.threadName) || null;
const timestampOf = (row: Record<string, unknown>) => text(row.source_timestamp ?? row.first_mentioned ?? row.created_at) || null;

function rowsFromJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['memories', 'records', 'items']) {
      const rows = (value as Record<string, unknown>)[key];
      if (Array.isArray(rows)) return rows;
    }
    return [value];
  }
  return [];
}

function parseRows(fileName: string, bytes: Uint8Array): { rows: unknown[]; sourceFile: string; manifest?: Record<string, unknown> } {
  if (fileName.toLowerCase().endsWith('.zip')) {
    const entries = unzipSync(bytes);
    const memoryPath = entries['archive/normalized/memories.jsonl']
      ? 'archive/normalized/memories.jsonl'
      : Object.keys(entries).find((name) => /\.(jsonl|json)$/i.test(name) && !/manifest|quarantine/i.test(name));
    if (!memoryPath || !entries[memoryPath]) throw new Error('ZIP contains no memory JSON or JSONL file.');
    const raw = strFromU8(entries[memoryPath]);
    const rows = memoryPath.endsWith('.jsonl')
      ? raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      : rowsFromJson(JSON.parse(raw));
    const manifestBytes = entries['archive/manifest.json'];
    return { rows, sourceFile: memoryPath, ...(manifestBytes ? { manifest: JSON.parse(strFromU8(manifestBytes)) as Record<string, unknown> } : {}) };
  }
  const raw = new TextDecoder().decode(bytes);
  return {
    rows: fileName.toLowerCase().endsWith('.jsonl')
      ? raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      : rowsFromJson(JSON.parse(raw)),
    sourceFile: fileName
  };
}

export function prepareMemoryUpload(fileName: string, bytes: Uint8Array): PreparedAshleyImport {
  if (!/\.(json|jsonl|zip)$/i.test(fileName)) throw new Error('Memory upload must be JSON, JSONL, or ZIP.');
  const { rows, sourceFile, manifest } = parseRows(fileName, bytes);
  if (rows.length === 0) throw new Error('Memory upload contains no records.');

  const seen = new Set<string>();
  const stageable: PreparedMemoryRecord[] = [];
  const quarantine: PreparedQuarantineRecord[] = [];
  const threads = new Set<string>();
  let duplicateIdRows = 0;
  let missingContentRows = 0;
  let missingTimestampRows = 0;

  rows.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      quarantine.push({ sourceFile, originalRecordIndex: index, reasons: ['invalid_record'], rawRecord: raw });
      return;
    }
    const row = raw as Record<string, unknown>;
    const originalId = idOf(row);
    const content = contentOf(row).replace(/\s+/g, ' ').trim();
    const reasons: string[] = [];
    if (!content) { reasons.push('missing_content'); missingContentRows += 1; }
    if (originalId && seen.has(originalId)) { reasons.push('duplicate_id'); duplicateIdRows += 1; }
    if (originalId) seen.add(originalId);
    const sourceTimestamp = timestampOf(row);
    if (!sourceTimestamp) missingTimestampRows += 1;
    if (reasons.length) {
      quarantine.push({ sourceFile, originalRecordIndex: index, reasons, rawRecord: row });
      return;
    }
    const threadId = threadIdOf(row);
    if (threadId) threads.add(threadId);
    stageable.push({
      originalId,
      content,
      contentHash: hash(content),
      threadId,
      threadName: threadNameOf(row),
      sourceFile,
      originalRecordIndex: index,
      sourceTimestamp,
      originalRawRecord: row
    });
  });

  const archiveSha256 = hash(bytes);
  const preview: MemoryImportPreview = {
    archiveSha256,
    expectedMemories: rows.length,
    totalRows: rows.length,
    stageableRows: stageable.length,
    quarantineRows: quarantine.length,
    duplicateIdRows,
    missingContentRows,
    missingTimestampRows,
    expectedThreads: threads.size,
    actualThreads: threads.size,
    sourceMessagesExpectedButUnavailable: 0,
    databaseMessagesAvailable: 0,
    fileHashFailures: [],
    safeToStage: stageable.length + quarantine.length === rows.length
  };
  return {
    archivePath: fileName,
    archiveSha256,
    archiveSizeBytes: bytes.byteLength,
    manifest: { source_system: text(manifest?.source_system) || 'Ashley memory upload', ...(manifest ?? {}) },
    preview,
    stageable,
    quarantine
  };
}

export async function prepareAshleyImport(path: string): Promise<PreparedAshleyImport> {
  return prepareMemoryUpload(path, new Uint8Array(await readFile(path)));
}

export async function validateAshleyArchive(path: string) {
  const prepared = await prepareAshleyImport(path);
  return { archivePath: path, ...prepared.preview, safeToImportValidatedRows: prepared.preview.safeToStage };
}

function batch(row: Record<string, unknown>): MemoryImportBatchSummary {
  return {
    id: String(row.id), archiveSha256: String(row.archive_sha256), sourceSystem: String(row.source_system),
    expectedCount: Number(row.expected_count), validCount: Number(row.valid_count),
    quarantinedCount: Number(row.quarantined_count), status: row.status as MemoryImportBatchSummary['status'],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  };
}

export async function stagePreparedAshleyImport(
  pool: DatabasePool, ownerUserId: string, taskId: string, prepared: PreparedAshleyImport, dryRun = true
): Promise<StageAshleyImportResult> {
  if (dryRun || !prepared.preview.safeToStage) return { dryRun: true, preview: prepared.preview, batch: null };
  const result = await withTransaction(pool, async (client) => {
    const batchId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO memory_import_batches(id,archive_sha256,source_system,expected_count,valid_count,quarantined_count,status,report,owner_user_id,orchestration_task_id,source_filename,archive_size_bytes,manifest)
       VALUES($1,$2,$3,$4,$5,$6,'STAGING',$7::jsonb,$8,$9,$10,$11,$12::jsonb)
       RETURNING *`,
      [batchId, prepared.archiveSha256, prepared.manifest.source_system, prepared.preview.expectedMemories,
       prepared.stageable.length, prepared.quarantine.length, JSON.stringify(prepared.preview), ownerUserId, taskId,
       prepared.archivePath, prepared.archiveSizeBytes, JSON.stringify(prepared.manifest)]
    );
    for (const record of prepared.stageable) {
      await client.query(
        `INSERT INTO memory_import_staging(import_batch_id,owner_user_id,original_id,source_system,source_file,original_record_index,lineage_type,content,content_hash,thread_id,thread_name,state,source_timestamp,transformation_history,original_raw_record)
         VALUES($1,$2,$3,$4,$5,$6,'INHERITED_ASHLEY_V1',$7,$8,$9,$10,'PASSIVE',$11,'[]'::jsonb,$12::jsonb)`,
        [batchId, ownerUserId, record.originalId, prepared.manifest.source_system, record.sourceFile,
         record.originalRecordIndex, record.content, record.contentHash, record.threadId, record.threadName,
         record.sourceTimestamp, JSON.stringify(record.originalRawRecord)]
      );
    }
    for (const record of prepared.quarantine) {
      await client.query(
        `INSERT INTO memory_quarantine(import_batch_id,source_file,original_record_index,reasons,raw_record)
         VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`,
        [batchId, record.sourceFile, record.originalRecordIndex, JSON.stringify(record.reasons), JSON.stringify(record.rawRecord)]
      );
    }
    const counts = await client.query(
      `SELECT (SELECT count(*)::int FROM memory_import_staging WHERE import_batch_id=$1) staged,
              (SELECT count(*)::int FROM memory_quarantine WHERE import_batch_id=$1) quarantined,
              (SELECT count(*)::int FROM memories WHERE import_batch_id=$1) live`, [batchId]
    );
    const verified = counts.rows[0] as { staged: number; quarantined: number; live: number };
    if (verified.staged !== prepared.stageable.length || verified.quarantined !== prepared.quarantine.length || verified.live !== 0) {
      throw new Error(`Memory verification failed: ${JSON.stringify(verified)}`);
    }
    const completed = await client.query(
      `UPDATE memory_import_batches SET status='STAGED',completed_at=now(),verified_stageable_count=$2,verified_quarantine_count=$3
       WHERE id=$1 RETURNING *`, [batchId, verified.staged, verified.quarantined]
    );
    return batch(completed.rows[0] as Record<string, unknown>);
  });
  return { dryRun: false, preview: prepared.preview, batch: result };
}

export async function stageAshleyImport(pool: DatabasePool, ownerUserId: string, taskId: string, path: string, dryRun = true) {
  return stagePreparedAshleyImport(pool, ownerUserId, taskId, await prepareAshleyImport(path), dryRun);
}
