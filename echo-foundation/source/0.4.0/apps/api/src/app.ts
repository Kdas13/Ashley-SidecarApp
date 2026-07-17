import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { randomUUID } from 'node:crypto';
import { TaskInputSchema, UploadMemoryFileRequestSchema, type OrchestrationTask } from '@echo/contracts';
import { createTask, recordApproval } from '@echo/orchestration';
import { prepareMemoryUpload, stagePreparedAshleyImport } from '@echo/memory-core';
import type { DatabasePool } from '@echo/database';

export interface AppOptions { pool?: DatabasePool; ownerUserId?: string; }
export async function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 42_000_000 });
  await app.register(cors, { origin: false });
  await app.register(helmet);
  const tasks = new Map<string, OrchestrationTask>();

  app.get('/health', async () => ({ ok: true, service: 'echo-api', version: '0.4.0' }));
  app.get('/v1/system/capabilities', async () => ({
    echo: { lineage: 'Ashley V4 clean-room successor', status: 'FOUNDATION' },
    orchestration: { alphaGate: true, omegaGate: true, doubleEngine: true },
    memory: { upload: ['json', 'jsonl', 'zip'], inheritedState: 'PASSIVE', automaticLivePromotion: false }
  }));
  app.get('/v1/orchestration/tasks', async () => [...tasks.values()]);
  app.post('/v1/orchestration/tasks', async (request, reply) => {
    const task = createTask(TaskInputSchema.parse(request.body));
    tasks.set(task.id, task);
    return reply.code(201).send(task);
  });
  app.post('/v1/orchestration/tasks/:id/alpha', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const current = tasks.get(id);
    if (!current) return reply.code(404).send({ error: 'Task not found.' });
    const body = request.body as { decision?: 'APPROVED' | 'REJECTED'; reason?: string };
    const task = recordApproval(current, 'ALPHA', body.decision ?? 'APPROVED', 'Kane', body.reason ?? null);
    tasks.set(id, task);
    return task;
  });
  app.post('/v1/memory/imports/upload', async (request, reply) => {
    const input = UploadMemoryFileRequestSchema.parse(request.body);
    const task = tasks.get(input.taskId);
    if (!task) return reply.code(404).send({ error: 'Memory installation task not found.' });
    const alphaApproved = task.approvals.some((event) => event.kind === 'ALPHA' && event.decision === 'APPROVED');
    if (!alphaApproved) return reply.code(409).send({ error: 'Kane Alpha approval is required before memory staging.' });
    const bytes = Uint8Array.from(Buffer.from(input.contentBase64, 'base64'));
    const prepared = prepareMemoryUpload(input.fileName, bytes);
    if (input.dryRun || !options.pool) return { dryRun: true, preview: prepared.preview, batch: null };
    const ownerUserId = options.ownerUserId ?? request.headers['x-echo-user-id'];
    if (typeof ownerUserId !== 'string') return reply.code(503).send({ error: 'Echo owner identity is not configured.' });
    return stagePreparedAshleyImport(options.pool, ownerUserId, input.taskId, prepared, false);
  });
  app.setErrorHandler((error: unknown, _request, reply) => {
    const value = error instanceof Error ? error : new Error(String(error));
    const status = typeof error === 'object' && error !== null && 'issues' in error ? 400 : 500;
    reply.code(status).send({ error: value.message, requestId: randomUUID() });
  });
  return app;
}
