import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalKind,
  EngineOneStage,
  EngineTwoStage,
  OrchestrationTask,
  PipelineState,
  TaskInput
} from '@echo/contracts';
import { TaskInputSchema } from '@echo/contracts';
import { classifyTask } from '@echo/security-governor';

const engineOneOrder: EngineOneStage[] = [
  'INTAKE', 'CONTEXT_RECOVERY', 'ARCHITECT', 'CODER_REVIEW', 'BREAKER', 'FIXER',
  'SECURITY', 'PRIVACY', 'FLYOVER', 'GAP_SWEEP', 'SPEC_FREEZE'
];
const engineTwoOrder: EngineTwoStage[] = [
  'SANDBOX_BUILD', 'STATIC_CHECKS', 'UNIT_TESTS', 'INTEGRATION_TESTS',
  'MIGRATION_DRY_RUN', 'SECURITY_SCAN', 'BREAKER', 'FIXER', 'REGRESSION',
  'MOBILE_SMOKE', 'RECOVERY', 'FLYOVER', 'FINAL_GAP_SWEEP', 'RELEASE_PACKAGE'
];

export class PipelineError extends Error {}

function now(): string { return new Date().toISOString(); }

export function createTask(rawInput: TaskInput): OrchestrationTask {
  const input = TaskInputSchema.parse(rawInput);
  const security = classifyTask(input);
  const timestamp = now();
  return {
    id: randomUUID(), input, riskLevel: security.riskLevel,
    state: security.requiresAlpha ? 'AWAITING_ALPHA' : 'ENGINE_ONE',
    engineOneCompleted: [], engineTwoCompleted: [], approvals: [], blockers: [],
    createdAt: timestamp, updatedAt: timestamp, version: 1
  };
}

function mutate(task: OrchestrationTask, state?: PipelineState): OrchestrationTask {
  return { ...task, ...(state ? { state } : {}), updatedAt: now(), version: task.version + 1 };
}

export function recordApproval(
  task: OrchestrationTask,
  kind: ApprovalKind,
  decision: ApprovalDecision,
  approvedBy: string,
  reason: string | null = null
): OrchestrationTask {
  if (kind === 'ALPHA' && task.state !== 'AWAITING_ALPHA') throw new PipelineError('Alpha approval is not expected in the current state.');
  if (kind === 'OMEGA' && task.state !== 'AWAITING_OMEGA') throw new PipelineError('Omega approval is not expected in the current state.');
  const event = { id: randomUUID(), taskId: task.id, kind, decision, approvedBy, reason, createdAt: now() };
  const nextState: PipelineState = decision === 'REJECTED' ? 'REJECTED' : kind === 'ALPHA' ? 'ENGINE_ONE' : 'APPROVED';
  return { ...mutate(task, nextState), approvals: [...task.approvals, event] };
}

export function completeEngineOneStage(task: OrchestrationTask, stage: EngineOneStage): OrchestrationTask {
  if (task.state !== 'ENGINE_ONE') throw new PipelineError('Engine One is not active.');
  const expected = engineOneOrder[task.engineOneCompleted.length];
  if (stage !== expected) throw new PipelineError(`Expected Engine One stage ${expected ?? 'none'}, received ${stage}.`);
  const completed = [...task.engineOneCompleted, stage];
  const finished = completed.length === engineOneOrder.length;
  return { ...mutate(task, finished ? 'SPEC_FROZEN' : 'ENGINE_ONE'), engineOneCompleted: completed };
}

export function beginCanonicalBuild(task: OrchestrationTask): OrchestrationTask {
  if (task.state !== 'SPEC_FROZEN') throw new PipelineError('Specification must be frozen before Sol begins the canonical build.');
  if (task.blockers.length > 0) throw new PipelineError('Known blockers must be closed before building.');
  return mutate(task, 'BUILDING');
}

export function submitSandboxBuild(task: OrchestrationTask): OrchestrationTask {
  if (task.state !== 'BUILDING') throw new PipelineError('Canonical build is not active.');
  return mutate(task, 'ENGINE_TWO');
}

export function completeEngineTwoStage(task: OrchestrationTask, stage: EngineTwoStage): OrchestrationTask {
  if (task.state !== 'ENGINE_TWO') throw new PipelineError('Engine Two is not active.');
  const expected = engineTwoOrder[task.engineTwoCompleted.length];
  if (stage !== expected) throw new PipelineError(`Expected Engine Two stage ${expected ?? 'none'}, received ${stage}.`);
  const completed = [...task.engineTwoCompleted, stage];
  const finished = completed.length === engineTwoOrder.length;
  return { ...mutate(task, finished ? 'AWAITING_OMEGA' : 'ENGINE_TWO'), engineTwoCompleted: completed };
}

export function addBlocker(task: OrchestrationTask, blocker: string): OrchestrationTask {
  if (!blocker.trim()) throw new PipelineError('Blocker cannot be empty.');
  return { ...mutate(task), blockers: [...task.blockers, blocker.trim()] };
}

export function clearBlocker(task: OrchestrationTask, blocker: string): OrchestrationTask {
  return { ...mutate(task), blockers: task.blockers.filter((item) => item !== blocker) };
}

export const PIPELINE_STAGE_ORDER = Object.freeze({ engineOne: engineOneOrder, engineTwo: engineTwoOrder });
