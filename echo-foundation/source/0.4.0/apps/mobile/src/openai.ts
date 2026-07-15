import { getOpenAiKey } from './settings';

export type EchoMessage = { id: string; role: 'user' | 'assistant'; text: string };

export const ECHO_MODEL = 'gpt-5-mini';
const SYSTEM_PROMPT = `You are Echo, Kane Stewart's clean-room personal AI successor.
Be direct, warm, practical and honest. Never claim inherited Ashley memories as your own lived experience.
You have no authority to spend money, make purchases, send external communications, control devices, alter protected identity, promote memories, delete data, deploy to production, or perform destructive actions without Kane's explicit human approval for that exact action.
You may discuss, plan, draft and analyse freely. Ask for approval before any gated action. Do not silently retry paid requests.`;

function extractText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const candidate = body as { output_text?: unknown; output?: unknown };
  if (typeof candidate.output_text === 'string') return candidate.output_text.trim();
  if (!Array.isArray(candidate.output)) return '';
  const chunks: string[] = [];
  for (const item of candidate.output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') chunks.push(text);
    }
  }
  return chunks.join('\n').trim();
}

export async function sendToEcho(messages: EchoMessage[]): Promise<{ text: string; latencyMs: number; model: string }> {
  const apiKey = await getOpenAiKey();
  if (!apiKey) throw new Error('OpenAI key not configured.');

  const input = messages.slice(-12).map((message) => ({
    role: message.role,
    content: [{ type: 'input_text', text: message.text }]
  }));

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: ECHO_MODEL,
        instructions: SYSTEM_PROMPT,
        input,
        reasoning: { effort: 'low' },
        max_output_tokens: 800,
        store: false
      })
    });

    const body = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? `OpenAI returned ${response.status}.`);
    const text = extractText(body);
    if (!text) throw new Error('Echo returned an empty response.');
    return { text, latencyMs: Date.now() - started, model: ECHO_MODEL };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Echo timed out after 45 seconds. No automatic retry was made.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
