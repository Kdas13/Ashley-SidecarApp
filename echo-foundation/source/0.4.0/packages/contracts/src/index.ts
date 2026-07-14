import { z } from 'zod';

export const RiskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ApprovalKindSchema = z.enum(['ALPHA', 'OMEGA']);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalDecisionSchema = z.enum(['APPROVED', 'REJECTED']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const PipelineStateSchema = z.enum([
  'DRAFT',
  'AWAITING_ALPHA',
  'ENGINE_ONE',
  'SPEC_FROZEN',
  'BUILDING',
  'ENGINE_TWO',
  'AWAITING_OMEGA',
  'APPROVED',
  'REJECTED',
  'FAILED',
  'ROLLED_BACK'
]);
export type PipelineState = z.infer<typeof PipelineStateSchema>;

export const EngineOneStageSchema = z.enum([
  'INTAKE',
  'CONTEXT_RECOVERY',
  'ARCHITECT',
  'CODER_REVIEW',
  'BREAKER',
  'FIXER',
  'SECURITY',
  'PRIVACY',
  'FLYOVER',
  'GAP_SWEEP',
  'SPEC_FREEZE'
]);
export type EngineOneStage = z.infer<typeof EngineOneStageSchema>;

export const EngineTwoStageSchema = z.enum([
  'SANDBOX_BUILD',
  'STATIC_CHECKS',
  'UNIT_TESTS',
  'INTEGRATION_TESTS',
  'MIGRATION_DRY_RUN',
  'SECURITY_SCAN',
  'BREAKER',
  'FIXER',
  'REGRESSION',
  'MOBILE_SMOKE',
  'RECOVERY',
  'FLYOVER',
  'FINAL_GAP_SWEEP',
  'RELEASE_PACKAGE'
]);
export type EngineTwoStage = z.infer<typeof EngineTwoStageSchema>;

export const PermissionClassSchema = z.enum([
  'READ_ONLY',
  'PLAN',
  'CODE_GENERATION',
  'SANDBOX_EXECUTION',
  'WRITE',
  'COMMUNICATION',
  'FINANCIAL',
  'DESTRUCTIVE',
  'IDENTITY_SENSITIVE',
  'MEMORY_SENSITIVE',
  'PRODUCTION_DEPLOYMENT',
  'PHYSICAL_DEVICE_CONTROL'
]);
export type PermissionClass = z.infer<typeof PermissionClassSchema>;

export const TaskInputSchema = z.object({
  title: z.string().min(3).max(160),
  originalIdea: z.string().min(1).max(100_000),
  projectId: z.string().min(1).max(120),
  requestedPermissions: z.array(PermissionClassSchema).default([]),
  estimatedCostPence: z.number().int().nonnegative().default(0),
  affectsProtectedIdentity: z.boolean().default(false),
  affectsMemoryGovernance: z.boolean().default(false),
  affectsProduction: z.boolean().default(false),
  destructive: z.boolean().default(false)
});
export type TaskInput = z.infer<typeof TaskInputSchema>;

export const ApprovalEventSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  kind: ApprovalKindSchema,
  decision: ApprovalDecisionSchema,
  approvedBy: z.string().min(1),
  reason: z.string().max(10_000).nullable(),
  createdAt: z.string().datetime()
});
export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>;

export const OrchestrationTaskSchema = z.object({
  id: z.string().uuid(),
  input: TaskInputSchema,
  riskLevel: RiskLevelSchema,
  state: PipelineStateSchema,
  engineOneCompleted: z.array(EngineOneStageSchema),
  engineTwoCompleted: z.array(EngineTwoStageSchema),
  approvals: z.array(ApprovalEventSchema),
  blockers: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive()
});
export type OrchestrationTask = z.infer<typeof OrchestrationTaskSchema>;

export const NormalizedMemorySchema = z.object({
  memory_id: z.string().nullable(),
  thread_name: z.string(),
  thread_id: z.string(),
  content: z.string().nullable(),
  original_summary: z.string().nullable().optional(),
  first_mentioned: z.string().nullable(),
  last_updated: z.string().nullable().optional(),
  current_state: z.string().nullable().optional(),
  source_message_id: z.string().nullable().optional(),
  source_message_text: z.string().nullable().optional(),
  source_timestamp: z.string().nullable().optional(),
  original_file: z.string(),
  original_record_index: z.number().int().nonnegative(),
  original_raw_record: z.unknown()
});
export type NormalizedMemory = z.infer<typeof NormalizedMemorySchema>;

export const ArchiveManifestSchema = z.object({
  generated_at: z.string(),
  archive_name: z.string(),
  source_system: z.string(),
  preservation_rules: z.array(z.string()),
  record_counts: z.object({
    v1_memories_expected: z.number().int().nonnegative(),
    v1_memories_found: z.number().int().nonnegative(),
    v1_memories_match: z.boolean(),
    v1_messages_expected: z.number().int().nonnegative(),
    v1_messages_in_thread_files: z.number().int().nonnegative(),
    v1_messages_note: z.string(),
    db_messages_total: z.number().int().nonnegative(),
    db_messages_kane_device: z.number().int().nonnegative(),
    db_profiles_total: z.number().int().nonnegative()
  }),
  threads: z.object({
    count: z.number().int().nonnegative(),
    expected: z.number().int().nonnegative(),
    thread_ids: z.array(z.string())
  }),
  validation: z.record(z.string(), z.unknown()),
  files: z.array(z.object({
    path: z.string(),
    size_bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }))
}).passthrough();
export type ArchiveManifest = z.infer<typeof ArchiveManifestSchema>;

export const DeviceTrustStateSchema = z.enum(['PENDING', 'TRUSTED', 'REVOKED']);
export type DeviceTrustState = z.infer<typeof DeviceTrustStateSchema>;

export const DevicePlatformSchema = z.enum(['ANDROID', 'IOS', 'WEB', 'DESKTOP', 'HOME', 'OTHER']);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

export const BootstrapDeviceRequestSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().min(1).max(120).default('Kane'),
  deviceName: z.string().min(1).max(160),
  platform: DevicePlatformSchema.default('ANDROID'),
  fingerprint: z.string().min(16).max(512)
});
export type BootstrapDeviceRequest = z.infer<typeof BootstrapDeviceRequestSchema>;

export const SessionPrincipalSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  isFinalAuthority: z.boolean(),
  deviceId: z.string().uuid(),
  deviceName: z.string(),
  sessionId: z.string().uuid()
});
export type SessionPrincipal = z.infer<typeof SessionPrincipalSchema>;

export const BootstrapDeviceResponseSchema = z.object({
  token: z.string().min(32),
  expiresAt: z.string().datetime(),
  principal: SessionPrincipalSchema
});
export type BootstrapDeviceResponse = z.infer<typeof BootstrapDeviceResponseSchema>;

export const DeviceSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  platform: z.string(),
  trustState: DeviceTrustStateSchema,
  approvedAt: z.string().datetime().nullable(),
  lastSeenAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable()
});
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>;

export const MemoryImportStatusSchema = z.enum(['VALIDATED', 'STAGING', 'STAGED', 'PROMOTED', 'REJECTED', 'FAILED']);
export type MemoryImportStatus = z.infer<typeof MemoryImportStatusSchema>;

export const MemoryImportPreviewSchema = z.object({
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedMemories: z.number().int().nonnegative(),
  totalRows: z.number().int().nonnegative(),
  stageableRows: z.number().int().nonnegative(),
  quarantineRows: z.number().int().nonnegative(),
  duplicateIdRows: z.number().int().nonnegative(),
  missingContentRows: z.number().int().nonnegative(),
  missingTimestampRows: z.number().int().nonnegative(),
  expectedThreads: z.number().int().nonnegative(),
  actualThreads: z.number().int().nonnegative(),
  sourceMessagesExpectedButUnavailable: z.number().int().nonnegative(),
  databaseMessagesAvailable: z.number().int().nonnegative(),
  fileHashFailures: z.array(z.object({ path: z.string(), expected: z.string(), actual: z.string().nullable() })),
  safeToStage: z.boolean()
});
export type MemoryImportPreview = z.infer<typeof MemoryImportPreviewSchema>;

export const StageMemoryImportRequestSchema = z.object({
  taskId: z.string().uuid(),
  dryRun: z.boolean().default(true)
});
export type StageMemoryImportRequest = z.infer<typeof StageMemoryImportRequestSchema>;

export const UploadMemoryFileRequestSchema = z.object({
  taskId: z.string().uuid(),
  fileName: z.string().min(1).max(255).refine(
    (value) => /\.(json|jsonl|zip)$/i.test(value),
    'Memory upload must be a .json, .jsonl, or .zip file.'
  ),
  mimeType: z.string().max(255).nullable().optional(),
  contentBase64: z.string().min(4).max(40_000_000),
  dryRun: z.boolean().default(false)
});
export type UploadMemoryFileRequest = z.infer<typeof UploadMemoryFileRequestSchema>;

export const MemoryImportBatchSummarySchema = z.object({
  id: z.string().uuid(),
  archiveSha256: z.string(),
  sourceSystem: z.string(),
  expectedCount: z.number().int(),
  validCount: z.number().int(),
  quarantinedCount: z.number().int(),
  status: MemoryImportStatusSchema,
  createdAt: z.string().datetime()
});
export type MemoryImportBatchSummary = z.infer<typeof MemoryImportBatchSummarySchema>;

export const QuarantineReviewStatusSchema = z.enum([
  'PENDING',
  'APPROVED_AS_PASSIVE',
  'REPLACED_AND_APPROVED',
  'REJECTED'
]);
export type QuarantineReviewStatus = z.infer<typeof QuarantineReviewStatusSchema>;

export const QuarantineDecisionSchema = z.enum([
  'APPROVE_AS_PASSIVE',
  'REPLACE_AND_APPROVE',
  'REJECT'
]);
export type QuarantineDecision = z.infer<typeof QuarantineDecisionSchema>;

export const QuarantineItemSchema = z.object({
  id: z.string().uuid(),
  importBatchId: z.string().uuid(),
  sourceFile: z.string().nullable(),
  originalRecordIndex: z.number().int().nullable(),
  reasons: z.array(z.string()),
  rawRecord: z.unknown(),
  reviewStatus: QuarantineReviewStatusSchema,
  decisionNote: z.string().nullable(),
  replacementContent: z.string().nullable(),
  reviewedBy: z.string().uuid().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive()
});
export type QuarantineItem = z.infer<typeof QuarantineItemSchema>;

export const QuarantineListResponseSchema = z.object({
  batchId: z.string().uuid(),
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  items: z.array(QuarantineItemSchema)
});
export type QuarantineListResponse = z.infer<typeof QuarantineListResponseSchema>;

export const QuarantineDecisionRequestSchema = z.object({
  decision: QuarantineDecisionSchema,
  reason: z.string().trim().min(3).max(10_000),
  replacementContent: z.string().trim().min(1).max(100_000).optional()
}).superRefine((value, context) => {
  if (value.decision === 'REPLACE_AND_APPROVE' && !value.replacementContent) {
    context.addIssue({ code: 'custom', path: ['replacementContent'], message: 'Replacement content is required.' });
  }
  if (value.decision !== 'REPLACE_AND_APPROVE' && value.replacementContent) {
    context.addIssue({ code: 'custom', path: ['replacementContent'], message: 'Replacement content is only allowed with REPLACE_AND_APPROVE.' });
  }
});
export type QuarantineDecisionRequest = z.infer<typeof QuarantineDecisionRequestSchema>;

export const MemoryImportBatchDetailSchema = MemoryImportBatchSummarySchema.extend({
  stagedCount: z.number().int().nonnegative(),
  pendingQuarantineCount: z.number().int().nonnegative(),
  approvedQuarantineCount: z.number().int().nonnegative(),
  rejectedQuarantineCount: z.number().int().nonnegative()
});
export type MemoryImportBatchDetail = z.infer<typeof MemoryImportBatchDetailSchema>;

export const PassiveMemorySearchRequestSchema = z.object({
  query: z.string().trim().min(2).max(1_000),
  limit: z.number().int().min(1).max(50).default(10),
  batchId: z.string().uuid().optional(),
  threadId: z.string().trim().min(1).max(200).optional()
});
export type PassiveMemorySearchRequest = z.infer<typeof PassiveMemorySearchRequestSchema>;

export const PassiveMemorySearchItemSchema = z.object({
  id: z.string().uuid(),
  importBatchId: z.string().uuid(),
  originalId: z.string().nullable(),
  content: z.string(),
  threadId: z.string().nullable(),
  threadName: z.string().nullable(),
  importance: z.number().int().nullable(),
  sourceTimestamp: z.string().datetime().nullable(),
  state: z.literal('PASSIVE'),
  rank: z.number(),
  sourceSystem: z.string(),
  lineageType: z.string()
});
export type PassiveMemorySearchItem = z.infer<typeof PassiveMemorySearchItemSchema>;

export const PassiveMemorySearchResponseSchema = z.object({
  query: z.string(),
  returnedCount: z.number().int().nonnegative(),
  liveMemoryRowsRead: z.literal(0),
  items: z.array(PassiveMemorySearchItemSchema)
});
export type PassiveMemorySearchResponse = z.infer<typeof PassiveMemorySearchResponseSchema>;
