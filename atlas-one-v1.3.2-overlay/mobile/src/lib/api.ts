import { fetch } from 'expo/fetch';

import type { ChatResult, ImageGenerationResult, Memory, SystemStatus, Task } from '@/types/api';
import type { Connection } from './connection';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code = 'REQUEST_FAILED',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(connection: Connection, path: string, init: RequestInit = {}): Promise<T> {
  if (!connection.baseUrl) throw new ApiError('Set the Atlas One API address in Settings.', 0, 'NO_URL');
  if (!connection.apiKey) throw new ApiError('Set the Atlas One API key in Settings.', 0, 'NO_KEY');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'X-API-Key': connection.apiKey,
        ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { detail?: string; message?: string };
      throw new ApiError(payload.detail || payload.message || `Request failed (${response.status})`, response.status);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError('Atlas One timed out after two minutes.', 0, 'TIMEOUT');
    }
    throw new ApiError('Could not reach Atlas One. Check the API address and network.', 0, 'NETWORK');
  } finally {
    clearTimeout(timeout);
  }
}

export const atlasApi = {
  status: (connection: Connection) => request<SystemStatus>(connection, '/v1/system/status'),
  chat: (connection: Connection, message: string, conversationId?: string | null) =>
    request<ChatResult>(connection, '/v1/chat', {
      method: 'POST',
      body: JSON.stringify({ user_id: 'kane', conversation_id: conversationId || null, message }),
    }),
  approval: (connection: Connection, pendingId: string, approve: boolean) =>
    request<ChatResult>(connection, `/v1/approvals/${encodeURIComponent(pendingId)}`, {
      method: 'POST',
      body: JSON.stringify({ approve }),
    }),
  tasks: async (connection: Connection, status = 'open') => {
    const result = await request<{ items: Task[] }>(connection, `/v1/tasks?user_id=kane&status=${encodeURIComponent(status)}`);
    return result.items;
  },
  createTask: async (connection: Connection, title: string, details = '', priority = 3) => {
    const result = await request<{ item: Task }>(connection, '/v1/tasks', {
      method: 'POST',
      body: JSON.stringify({ user_id: 'kane', title, details, priority }),
    });
    return result.item;
  },
  updateTask: async (connection: Connection, taskId: string, status: string) => {
    const result = await request<{ item: Task }>(
      connection,
      `/v1/tasks/${encodeURIComponent(taskId)}?user_id=kane`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
    );
    return result.item;
  },
  memories: async (connection: Connection, query = '') => {
    const suffix = query ? `&query=${encodeURIComponent(query)}` : '';
    const result = await request<{ items: Memory[] }>(connection, `/v1/memories?user_id=kane&limit=80${suffix}`);
    return result.items;
  },
  createMemory: async (connection: Connection, content: string, kind = 'fact') => {
    const result = await request<{ item: Memory }>(connection, '/v1/memories', {
      method: 'POST',
      body: JSON.stringify({ user_id: 'kane', content, kind, importance: 0.7, confidence: 1 }),
    });
    return result.item;
  },
  upload: async (connection: Connection, uri: string, name: string, mimeType?: string | null) => {
    const data = new FormData();
    data.append('file', { uri, name, type: mimeType || 'application/octet-stream' } as never);
    return request<{
      item: { stored_path: string; original_name: string; media_type?: string | null };
      text_extracted: boolean;
      vision_summary?: string | null;
      content_url?: string | null;
    }>(connection, '/v1/files?user_id=kane', { method: 'POST', body: data });
  },
  generateImage: (connection: Connection, prompt: string, aspect: 'square' | 'portrait' | 'landscape' = 'square') =>
    request<ImageGenerationResult>(connection, '/v1/images/generate?user_id=kane', {
      method: 'POST',
      body: JSON.stringify({ prompt, aspect, quality: 'high' }),
    }),
  fileUrl: (connection: Connection, contentUrlOrPath: string) => {
    const path = contentUrlOrPath.startsWith('/v1/')
      ? contentUrlOrPath
      : `/v1/files/content?path=${encodeURIComponent(contentUrlOrPath)}`;
    return `${connection.baseUrl}${path}`;
  },
};
