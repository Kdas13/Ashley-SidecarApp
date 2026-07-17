import { describe, expect, it } from 'vitest';
import type { TaskInput } from '@echo/contracts';
import { classifyTask } from '../src/index.js';

const base: TaskInput = {
  title: 'Create a project specification',
  originalIdea: 'Draft a specification only.',
  projectId: 'echo',
  requestedPermissions: ['PLAN'],
  estimatedCostPence: 0,
  affectsProtectedIdentity: false,
  affectsMemoryGovernance: false,
  affectsProduction: false,
  destructive: false
};

describe('Security Governor', () => {
  it('classifies planning as low risk', () => {
    expect(classifyTask(base).riskLevel).toBe('LOW');
  });

  it('classifies production deployment as critical', () => {
    const decision = classifyTask({ ...base, requestedPermissions: ['PRODUCTION_DEPLOYMENT'], affectsProduction: true });
    expect(decision.riskLevel).toBe('CRITICAL');
    expect(decision.requiresAlpha).toBe(true);
    expect(decision.requiresOmega).toBe(true);
  });

  it('requires per-action confirmation for spending', () => {
    expect(classifyTask({ ...base, estimatedCostPence: 100 }).requiresPerActionConfirmation).toBe(true);
  });
});
