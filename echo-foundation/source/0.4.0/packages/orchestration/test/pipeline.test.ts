import { describe, expect, it } from 'vitest';
import {
  PIPELINE_STAGE_ORDER,
  beginCanonicalBuild,
  completeEngineOneStage,
  completeEngineTwoStage,
  createTask,
  recordApproval,
  submitSandboxBuild
} from '../src/index.js';

function newTask() {
  return createTask({
    title: 'Build Echo memory importer',
    originalIdea: 'Validate and import the preserved archive.',
    projectId: 'echo',
    requestedPermissions: ['CODE_GENERATION', 'SANDBOX_EXECUTION'],
    estimatedCostPence: 0,
    affectsProtectedIdentity: false,
    affectsMemoryGovernance: true,
    affectsProduction: false,
    destructive: false
  });
}

describe('double-engine orchestration', () => {
  it('cannot skip Alpha approval', () => {
    const task = newTask();
    expect(task.state).toBe('AWAITING_ALPHA');
    expect(() => completeEngineOneStage(task, 'INTAKE')).toThrow('Engine One is not active');
  });

  it('requires every stage in order and Omega approval at the end', () => {
    let task = recordApproval(newTask(), 'ALPHA', 'APPROVED', 'Kane');
    for (const stage of PIPELINE_STAGE_ORDER.engineOne) task = completeEngineOneStage(task, stage);
    expect(task.state).toBe('SPEC_FROZEN');
    task = beginCanonicalBuild(task);
    task = submitSandboxBuild(task);
    for (const stage of PIPELINE_STAGE_ORDER.engineTwo) task = completeEngineTwoStage(task, stage);
    expect(task.state).toBe('AWAITING_OMEGA');
    task = recordApproval(task, 'OMEGA', 'APPROVED', 'Kane');
    expect(task.state).toBe('APPROVED');
  });

  it('allows Kane to reject at Alpha', () => {
    const task = recordApproval(newTask(), 'ALPHA', 'REJECTED', 'Kane', 'Not yet.');
    expect(task.state).toBe('REJECTED');
  });
});
