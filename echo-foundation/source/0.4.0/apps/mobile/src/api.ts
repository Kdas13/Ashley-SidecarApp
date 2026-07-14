import { getApiUrl } from './settings';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiUrl = await getApiUrl();
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers }
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Echo API returned ${response.status}.`);
  return body;
}

export interface MemoryResult {
  dryRun: boolean;
  preview: { totalRows: number; stageableRows: number; quarantineRows: number; safeToStage: boolean };
  batch: null | { id: string; status: string };
}

export async function checkHealth(): Promise<{ ok: boolean; version: string }> {
  return request('/health');
}

export async function createMemoryTask(fileName: string): Promise<{ id: string; state: string }> {
  return request('/v1/orchestration/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `Install memories from ${fileName}`,
      originalIdea: 'Validate the selected archive, stage valid records as passive Ashley lineage, quarantine problems, and promote nothing automatically.',
      projectId: 'echo',
      requestedPermissions: ['MEMORY_SENSITIVE'],
      estimatedCostPence: 0,
      affectsProtectedIdentity: false,
      affectsMemoryGovernance: true,
      affectsProduction: false,
      destructive: false
    })
  });
}

export async function approveAlpha(taskId: string, fileName: string) {
  return request(`/v1/orchestration/tasks/${taskId}/alpha`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'APPROVED', reason: `Kane selected ${fileName}; passive staging only.` })
  });
}

export async function uploadMemories(input: { taskId: string; fileName: string; mimeType?: string | null; contentBase64: string }) {
  return request<MemoryResult>('/v1/memory/imports/upload', {
    method: 'POST',
    body: JSON.stringify({ ...input, dryRun: false })
  });
}
