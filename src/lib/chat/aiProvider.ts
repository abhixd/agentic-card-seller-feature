// ---------------------------------------------------------------
// AI provider abstraction — Ollama-first, optional OpenAI fallback
// Set AI_PROVIDER=openai to use OpenAI instead.
// ---------------------------------------------------------------

import type { ToolDefinition, ToolCall } from '@/types/chat'

export interface AIMessage {
  role:        'user' | 'assistant' | 'tool' | 'system'
  content:     string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?:       string
}

export interface AIResponse {
  content:    string | null
  tool_calls: ToolCall[] | null
}

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL    ?? 'llama3.2'
const OPENAI_MODEL    = process.env.OPENAI_MODEL    ?? 'gpt-4o-mini'

// ---------------------------------------------------------------
// Ollama chat
// ---------------------------------------------------------------

async function callOllama(
  messages:  AIMessage[],
  tools:     ToolDefinition[],
): Promise<AIResponse> {
  const body: Record<string, unknown> = {
    model:    OLLAMA_MODEL,
    messages: messages.map(normalizeForOllama),
    stream:   false,
  }
  if (tools.length > 0) {
    body.tools = tools
  }

  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Ollama error ${res.status}: ${text}`)
  }

  const data = await res.json()
  const msg  = data?.message ?? {}

  return {
    content:    msg.content ?? null,
    tool_calls: msg.tool_calls ? normalizeOllamaToolCalls(msg.tool_calls) : null,
  }
}

function normalizeForOllama(msg: AIMessage): Record<string, unknown> {
  if (msg.role === 'tool') {
    return {
      role:         'tool',
      content:      msg.content ?? '',
      name:         msg.name ?? undefined,
      tool_call_id: msg.tool_call_id ?? undefined,
    }
  }
  const out: Record<string, unknown> = {
    role:    msg.role,
    content: msg.content ?? '',
  }
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    out.tool_calls = msg.tool_calls
  }
  return out
}

function normalizeOllamaToolCalls(raw: unknown[]): ToolCall[] {
  return raw.map((tc: any, i: number) => ({
    id:       tc.id ?? `call_${i}`,
    type:     'function' as const,
    function: {
      name:      tc.function?.name ?? '',
      arguments: typeof tc.function?.arguments === 'string'
        ? tc.function.arguments
        : JSON.stringify(tc.function?.arguments ?? {}),
    },
  }))
}

// ---------------------------------------------------------------
// OpenAI-compatible chat (fallback)
// ---------------------------------------------------------------

async function callOpenAI(
  messages: AIMessage[],
  tools:    ToolDefinition[],
): Promise<AIResponse> {
  const body: Record<string, unknown> = {
    model:    OPENAI_MODEL,
    messages: messages.map(normalizeForOpenAI),
  }
  if (tools.length > 0) {
    body.tools       = tools
    body.tool_choice = 'auto'
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`OpenAI error ${res.status}: ${text}`)
  }

  const data    = await res.json()
  const choice  = data?.choices?.[0]?.message ?? {}

  return {
    content:    choice.content ?? null,
    tool_calls: choice.tool_calls ?? null,
  }
}

function normalizeForOpenAI(msg: AIMessage): Record<string, unknown> {
  if (msg.role === 'tool') {
    return {
      role:         'tool',
      content:      msg.content ?? '',
      tool_call_id: msg.tool_call_id ?? '',
    }
  }
  const out: Record<string, unknown> = {
    role:    msg.role,
    content: msg.content ?? '',
  }
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    out.tool_calls = msg.tool_calls
  }
  return out
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

export async function callAI(
  messages: AIMessage[],
  tools:    ToolDefinition[] = [],
): Promise<AIResponse> {
  const provider = process.env.AI_PROVIDER ?? 'ollama'
  if (provider === 'openai') {
    return callOpenAI(messages, tools)
  }
  return callOllama(messages, tools)
}
