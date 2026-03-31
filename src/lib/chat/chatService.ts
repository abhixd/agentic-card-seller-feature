// ---------------------------------------------------------------
// Chat service — session management + agentic message loop
// ---------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatSession, ChatMessage, ToolCall } from '@/types/chat'
import { callAI, type AIMessage } from './aiProvider'
import { TOOL_DEFINITIONS, runTool } from './tools'

const MAX_TOOL_ITERATIONS = 5

const SYSTEM_PROMPT = `You are a read-only card-selling copilot. You help the user understand their card inventory, analysis results, and make informed selling decisions.

RULES:
- Only reference data returned by the tools. Never invent prices, quantities, or card details.
- You are read-only. You cannot modify inventory or create listings.
- If a tool returns an error or no data, say so clearly.
- Be concise. Bullet points work well for ranked lists.
- When citing dollar values, always include the source (e.g., "based on your analysis").`

// ---------------------------------------------------------------
// Session management
// ---------------------------------------------------------------

export async function createSession(
  supabase: SupabaseClient,
  userId:   string,
  title:    string = 'New conversation',
): Promise<{ session: ChatSession | null; error: string | null }> {
  const { data, error } = await supabase
    .from('chat_sessions')
    .insert({ user_id: userId, title })
    .select('*')
    .single()

  if (error || !data) {
    return { session: null, error: error?.message ?? 'Failed to create session.' }
  }
  return { session: data as ChatSession, error: null }
}

export async function listSessions(
  supabase: SupabaseClient,
  userId:   string,
): Promise<{ sessions: ChatSession[]; error: string | null }> {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  if (error) {
    return { sessions: [], error: error.message }
  }
  return { sessions: (data ?? []) as ChatSession[], error: null }
}

export async function getSessionWithMessages(
  supabase:   SupabaseClient,
  userId:     string,
  sessionId:  string,
): Promise<{ session: ChatSession | null; messages: ChatMessage[]; error: string | null }> {
  const { data: sessionData, error: sessionError } = await supabase
    .from('chat_sessions')
    .select('*')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .single()

  if (sessionError || !sessionData) {
    return { session: null, messages: [], error: 'Session not found.' }
  }

  const { data: msgData, error: msgError } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })

  if (msgError) {
    return { session: sessionData as ChatSession, messages: [], error: msgError.message }
  }

  return {
    session:  sessionData as ChatSession,
    messages: (msgData ?? []) as ChatMessage[],
    error:    null,
  }
}

// ---------------------------------------------------------------
// Persist a single message
// ---------------------------------------------------------------

async function saveMessage(
  supabase:   SupabaseClient,
  sessionId:  string,
  role:       'user' | 'assistant' | 'tool',
  content:    string | null,
  toolCalls?: ToolCall[] | null,
  toolName?:  string | null,
): Promise<ChatMessage | null> {
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      session_id: sessionId,
      role,
      content,
      tool_calls: toolCalls ?? null,
      tool_name:  toolName ?? null,
    })
    .select('*')
    .single()

  if (error || !data) return null
  return data as ChatMessage
}

// ---------------------------------------------------------------
// Agentic message loop
// ---------------------------------------------------------------

export async function sendMessage(
  supabase:  SupabaseClient,
  userId:    string,
  sessionId: string,
  userText:  string,
): Promise<{ reply: ChatMessage | null; error: string | null }> {
  // Verify session ownership
  const { data: sessionData, error: sessionError } = await supabase
    .from('chat_sessions')
    .select('session_id, title')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .single()

  if (sessionError || !sessionData) {
    return { reply: null, error: 'Session not found.' }
  }

  // Persist user message
  await saveMessage(supabase, sessionId, 'user', userText)

  // If this is the first user message, update session title
  const { count } = await supabase
    .from('chat_messages')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId)

  if (count === 1) {
    const title = userText.length > 60 ? userText.slice(0, 57) + '...' : userText
    await supabase
      .from('chat_sessions')
      .update({ title })
      .eq('session_id', sessionId)
  }

  // Load full history for context
  const { data: history } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })

  const aiMessages: AIMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...((history ?? []) as ChatMessage[]).map(dbMessageToAI),
  ]

  // Agentic loop
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const aiResp = await callAI(aiMessages, TOOL_DEFINITIONS)

    if (aiResp.tool_calls && aiResp.tool_calls.length > 0) {
      // Persist assistant message with tool_calls
      await saveMessage(supabase, sessionId, 'assistant', aiResp.content, aiResp.tool_calls)

      // Push to context
      aiMessages.push({
        role:       'assistant',
        content:    aiResp.content,
        tool_calls: aiResp.tool_calls,
      })

      // Execute each tool and append results
      for (const tc of aiResp.tool_calls) {
        const result = await runTool(
          tc.function.name,
          tc.function.arguments,
          supabase,
          userId,
        )

        await saveMessage(supabase, sessionId, 'tool', result, null, tc.function.name)

        aiMessages.push({
          role:         'tool',
          content:      result,
          tool_call_id: tc.id,
          name:         tc.function.name,
        })
      }

      // Continue loop to get final answer
      continue
    }

    // No tool calls — this is the final assistant response
    const reply = await saveMessage(supabase, sessionId, 'assistant', aiResp.content ?? '')
    return { reply, error: null }
  }

  // Exhausted max iterations — return a graceful fallback
  const fallback = await saveMessage(
    supabase, sessionId, 'assistant',
    'I reached the maximum number of tool calls for this response. Please try rephrasing your question.'
  )
  return { reply: fallback, error: null }
}

// ---------------------------------------------------------------
// Convert DB message to AI message format
// ---------------------------------------------------------------

function dbMessageToAI(msg: ChatMessage): AIMessage {
  if (msg.role === 'tool') {
    return {
      role:         'tool',
      content:      msg.content ?? '',
      name:         msg.tool_name ?? undefined,
      // Ollama doesn't require tool_call_id but OpenAI does — use message_id as fallback
      tool_call_id: msg.message_id,
    }
  }
  if (msg.role === 'assistant' && msg.tool_calls) {
    return {
      role:       'assistant',
      content:    msg.content ?? null,
      tool_calls: msg.tool_calls as ToolCall[],
    }
  }
  return {
    role:    msg.role as 'user' | 'assistant',
    content: msg.content ?? '',
  }
}
