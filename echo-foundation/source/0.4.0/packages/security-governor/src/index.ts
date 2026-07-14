import type { PermissionClass, RiskLevel, TaskInput } from '@echo/contracts';

const permissionRisk: Record<PermissionClass, RiskLevel> = {
  READ_ONLY: 'LOW',
  PLAN: 'LOW',
  CODE_GENERATION: 'MEDIUM',
  SANDBOX_EXECUTION: 'MEDIUM',
  WRITE: 'HIGH',
  COMMUNICATION: 'HIGH',
  FINANCIAL: 'CRITICAL',
  DESTRUCTIVE: 'CRITICAL',
  IDENTITY_SENSITIVE: 'CRITICAL',
  MEMORY_SENSITIVE: 'CRITICAL',
  PRODUCTION_DEPLOYMENT: 'CRITICAL',
  PHYSICAL_DEVICE_CONTROL: 'HIGH'
};

const rank: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export interface SecurityDecision {
  riskLevel: RiskLevel;
  requiresAlpha: boolean;
  requiresOmega: boolean;
  requiresPerActionConfirmation: boolean;
  reasons: string[];
}

export function classifyTask(input: TaskInput): SecurityDecision {
  let level: RiskLevel = 'LOW';
  const reasons: string[] = [];

  for (const permission of input.requestedPermissions) {
    const candidate = permissionRisk[permission];
    if (rank[candidate] > rank[level]) level = candidate;
    reasons.push(`Permission ${permission} classified as ${candidate}.`);
  }

  if (input.estimatedCostPence > 0) {
    level = rank[level] < rank.HIGH ? 'HIGH' : level;
    reasons.push('Task can create external cost.');
  }
  if (input.affectsProduction) {
    level = 'CRITICAL';
    reasons.push('Task affects production.');
  }
  if (input.affectsProtectedIdentity) {
    level = 'CRITICAL';
    reasons.push('Task affects protected identity.');
  }
  if (input.affectsMemoryGovernance) {
    level = 'CRITICAL';
    reasons.push('Task affects memory governance.');
  }
  if (input.destructive) {
    level = 'CRITICAL';
    reasons.push('Task is destructive.');
  }

  if (reasons.length === 0) reasons.push('No elevated-risk indicators were declared.');

  return {
    riskLevel: level,
    requiresAlpha: level !== 'LOW' || input.requestedPermissions.includes('CODE_GENERATION'),
    requiresOmega: true,
    requiresPerActionConfirmation:
      input.destructive ||
      input.estimatedCostPence > 0 ||
      input.requestedPermissions.some((p) => ['FINANCIAL', 'DESTRUCTIVE', 'COMMUNICATION'].includes(p)),
    reasons
  };
}
