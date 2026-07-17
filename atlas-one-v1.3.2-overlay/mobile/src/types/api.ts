export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  imageUrl?: string | null;
  imageUri?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
};

export type Interruption = {
  tool_call_id?: string | null;
  tool_name?: string | null;
  arguments?: unknown;
  agent?: string | null;
};

export type ChatResult =
  | {
      status: 'completed';
      conversation_id: string;
      reply: string;
      last_response_id?: string | null;
    }
  | {
      status: 'pending_approval';
      pending_id: string;
      conversation_id: string;
      interruptions: Interruption[];
      message?: string;
    };

export type Task = {
  id: string;
  title: string;
  details: string;
  priority: number;
  status: string;
  due_at?: string | null;
  created_at: string;
};

export type Memory = {
  id: string;
  kind: string;
  content: string;
  importance: number;
  confidence: number;
  source: string;
  created_at: string;
};

export type SystemStatus = {
  status: string;
  model: string;
  providers: Record<string, boolean>;
  capabilities: Record<string, boolean>;
  mcp: { active: string[]; failed: Record<string, string> };
  usage_30d: Record<string, number>;
};

export type ImageGenerationResult = {
  status: 'generated';
  path: string;
  provider: string;
  content_url: string;
};
