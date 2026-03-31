// ---------------------------------------------------------------
// Chat session + message types
// ---------------------------------------------------------------

export type ChatRole = 'user' | 'assistant' | 'tool'

export interface ChatSession {
  session_id: string
  user_id:    string
  title:      string
  created_at: string
  updated_at: string
}

export interface ToolCall {
  id:       string
  type:     'function'
  function: {
    name:      string
    arguments: string // JSON string
  }
}

export interface ChatMessage {
  message_id:  string
  session_id:  string
  role:        ChatRole
  content:     string | null
  tool_calls:  ToolCall[] | null
  tool_name:   string | null
  created_at:  string
}

// ---------------------------------------------------------------
// API request/response shapes
// ---------------------------------------------------------------

export interface SendMessageRequest {
  content: string
}

export interface SessionWithMessages {
  session: ChatSession
  messages: ChatMessage[]
}

// ---------------------------------------------------------------
// Tool definitions (Ollama / OpenAI-compatible format)
// ---------------------------------------------------------------

export interface ToolDefinition {
  type: 'function'
  function: {
    name:        string
    description: string
    parameters:  Record<string, unknown>
  }
}
