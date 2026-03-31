import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ChatPage from '@/app/(app)/chat/page'

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({
  useParams:  vi.fn().mockReturnValue({}),
  useRouter:  vi.fn().mockReturnValue({ push: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440010'

const MOCK_SESSION = {
  session_id: SESSION_ID,
  user_id:    'user-123',
  title:      'What should I sell?',
  created_at: '2026-03-29T00:00:00Z',
  updated_at: '2026-03-29T00:00:00Z',
}

const MOCK_MESSAGES = [
  {
    message_id: '550e8400-e29b-41d4-a716-446655440020',
    session_id: SESSION_ID,
    role:       'user',
    content:    'What should I sell?',
    tool_calls: null,
    tool_name:  null,
    created_at: '2026-03-29T00:00:00Z',
  },
  {
    message_id: '550e8400-e29b-41d4-a716-446655440021',
    session_id: SESSION_ID,
    role:       'assistant',
    content:    'Based on your analysis, Charizard has a SELL_RAW recommendation.',
    tool_calls: null,
    tool_name:  null,
    created_at: '2026-03-29T00:00:01Z',
  },
  {
    message_id: '550e8400-e29b-41d4-a716-446655440022',
    session_id: SESSION_ID,
    role:       'tool',
    content:    '{"count":1,"candidates":[]}',
    tool_calls: null,
    tool_name:  'find_sell_now_candidates',
    created_at: '2026-03-29T00:00:00.5Z',
  },
]

afterEach(() => vi.unstubAllGlobals())
beforeEach(() => vi.clearAllMocks())

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(handlers: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
    const method = (opts?.method ?? 'GET').toUpperCase()
    const key = `${method} ${url}`

    // Exact match first
    if (key in handlers) {
      const val = handlers[key]
      return { ok: true, json: async () => val }
    }
    // Prefix match
    for (const [pattern, val] of Object.entries(handlers)) {
      if (key.startsWith(pattern)) {
        return { ok: true, json: async () => val }
      }
    }
    return { ok: false, json: async () => ({ error: 'Not found' }) }
  }))
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe('ChatPage — loading', () => {
  it('shows loading skeleton while fetching sessions', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<ChatPage />)
    expect(screen.getByTestId('sessions-loading')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Empty state — no sessions
// ---------------------------------------------------------------------------

describe('ChatPage — no sessions', () => {
  it('shows no-sessions message and empty chat area', async () => {
    mockFetch({ 'GET /api/chat/sessions': { sessions: [] } })
    render(<ChatPage />)
    await waitFor(() => screen.getByTestId('no-sessions'))
    expect(screen.getByTestId('no-sessions')).toBeInTheDocument()
    expect(screen.getByTestId('chat-empty')).toBeInTheDocument()
  })

  it('shows start-chat button in empty state', async () => {
    mockFetch({ 'GET /api/chat/sessions': { sessions: [] } })
    render(<ChatPage />)
    await waitFor(() => screen.getByTestId('start-chat-button'))
    expect(screen.getByTestId('start-chat-button')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Sessions list
// ---------------------------------------------------------------------------

describe('ChatPage — sessions list', () => {
  it('renders sessions in sidebar', async () => {
    mockFetch({ 'GET /api/chat/sessions': { sessions: [MOCK_SESSION] } })
    render(<ChatPage />)
    await waitFor(() => screen.getAllByTestId('session-item'))
    expect(screen.getAllByTestId('session-item')).toHaveLength(1)
    expect(screen.getByText('What should I sell?')).toBeInTheDocument()
  })

  it('shows new-session-button', async () => {
    mockFetch({ 'GET /api/chat/sessions': { sessions: [] } })
    render(<ChatPage />)
    await waitFor(() => screen.getByTestId('new-session-button'))
    expect(screen.getByTestId('new-session-button')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// New session creation
// ---------------------------------------------------------------------------

describe('ChatPage — new session', () => {
  it('creates a session and shows empty-session prompt', async () => {
    const newSession = { ...MOCK_SESSION, title: 'New conversation' }
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      const method = (opts?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && url === '/api/chat/sessions') {
        return { ok: true, json: async () => newSession }
      }
      if (method === 'GET' && url === '/api/chat/sessions') {
        return { ok: true, json: async () => ({ sessions: [] }) }
      }
      if (method === 'GET' && url.includes('/api/chat/sessions/')) {
        return { ok: true, json: async () => ({ session: newSession, messages: [] }) }
      }
      return { ok: false, json: async () => ({ error: 'Not found' }) }
    }))

    render(<ChatPage />)
    await waitFor(() => screen.getByTestId('new-session-button'))
    fireEvent.click(screen.getByTestId('new-session-button'))
    await waitFor(() => screen.getByTestId('empty-session'))
    expect(screen.getByTestId('empty-session')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Message display
// ---------------------------------------------------------------------------

describe('ChatPage — message display', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      const method = (opts?.method ?? 'GET').toUpperCase()
      if (method === 'GET' && url === '/api/chat/sessions') {
        return { ok: true, json: async () => ({ sessions: [MOCK_SESSION] }) }
      }
      if (method === 'GET' && url.includes('/api/chat/sessions/')) {
        return { ok: true, json: async () => ({ session: MOCK_SESSION, messages: MOCK_MESSAGES }) }
      }
      return { ok: false, json: async () => ({ error: 'Not found' }) }
    }))
  })

  it('renders user and assistant messages after selecting a session', async () => {
    render(<ChatPage />)
    await waitFor(() => screen.getAllByTestId('session-item'))
    fireEvent.click(screen.getAllByTestId('session-item')[0])

    await waitFor(() => screen.getAllByTestId('message-user'))
    expect(screen.getAllByTestId('message-user')).toHaveLength(1)
    expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
    // Message bubble content (not the session title or header)
    const userBubble = screen.getByTestId('message-user')
    expect(userBubble).toHaveTextContent('What should I sell?')
    expect(screen.getByText('Based on your analysis, Charizard has a SELL_RAW recommendation.')).toBeInTheDocument()
  })

  it('does not render tool messages', async () => {
    render(<ChatPage />)
    await waitFor(() => screen.getAllByTestId('session-item'))
    fireEvent.click(screen.getAllByTestId('session-item')[0])

    await waitFor(() => screen.getAllByTestId('message-user'))
    expect(screen.queryByTestId('message-tool')).not.toBeInTheDocument()
    // Tool content should not appear
    expect(screen.queryByText(/find_sell_now_candidates/)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Send message
// ---------------------------------------------------------------------------

describe('ChatPage — send message', () => {
  it('shows thinking indicator while waiting for reply', async () => {
    let resolveMsg: (() => void) | null = null
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      const method = (opts?.method ?? 'GET').toUpperCase()
      if (method === 'GET' && url === '/api/chat/sessions') {
        return { ok: true, json: async () => ({ sessions: [MOCK_SESSION] }) }
      }
      if (method === 'GET' && url.includes('/api/chat/sessions/')) {
        return { ok: true, json: async () => ({ session: MOCK_SESSION, messages: [] }) }
      }
      if (method === 'POST' && url.includes('/messages')) {
        // Hang indefinitely
        return new Promise((resolve) => { resolveMsg = () => resolve({ ok: true, json: async () => ({ reply: null }) }) })
      }
      return { ok: false, json: async () => ({ error: 'Not found' }) }
    }))

    render(<ChatPage />)
    await waitFor(() => screen.getAllByTestId('session-item'))
    fireEvent.click(screen.getAllByTestId('session-item')[0])
    await waitFor(() => screen.getByTestId('chat-input'))

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Which cards should I sell?' } })
    fireEvent.click(screen.getByTestId('send-button'))

    await waitFor(() => screen.getByTestId('thinking-indicator'))
    expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument()
  })

  it('send button is disabled when input is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      const method = (opts?.method ?? 'GET').toUpperCase()
      if (method === 'GET' && url === '/api/chat/sessions') {
        return { ok: true, json: async () => ({ sessions: [MOCK_SESSION] }) }
      }
      if (method === 'GET' && url.includes('/api/chat/sessions/')) {
        return { ok: true, json: async () => ({ session: MOCK_SESSION, messages: [] }) }
      }
      return { ok: false, json: async () => ({ error: 'Not found' }) }
    }))

    render(<ChatPage />)
    await waitFor(() => screen.getAllByTestId('session-item'))
    fireEvent.click(screen.getAllByTestId('session-item')[0])
    await waitFor(() => screen.getByTestId('send-button'))
    expect(screen.getByTestId('send-button')).toBeDisabled()
  })

  it('shows send error when message fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      const method = (opts?.method ?? 'GET').toUpperCase()
      if (method === 'GET' && url === '/api/chat/sessions') {
        return { ok: true, json: async () => ({ sessions: [MOCK_SESSION] }) }
      }
      if (method === 'GET' && url.includes('/api/chat/sessions/')) {
        return { ok: true, json: async () => ({ session: MOCK_SESSION, messages: [] }) }
      }
      if (method === 'POST' && url.includes('/messages')) {
        return { ok: false, json: async () => ({ error: 'Session not found.' }) }
      }
      return { ok: false, json: async () => ({ error: 'Not found' }) }
    }))

    render(<ChatPage />)
    await waitFor(() => screen.getAllByTestId('session-item'))
    fireEvent.click(screen.getAllByTestId('session-item')[0])
    await waitFor(() => screen.getByTestId('chat-input'))

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByTestId('send-button'))

    await waitFor(() => screen.getByTestId('send-error'))
    expect(screen.getByTestId('send-error')).toHaveTextContent('Session not found.')
  })
})

// ---------------------------------------------------------------------------
// Chat input
// ---------------------------------------------------------------------------

describe('ChatPage — chat input', () => {
  it('renders chat input and send button when session is active', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      const method = (opts?.method ?? 'GET').toUpperCase()
      if (method === 'GET' && url === '/api/chat/sessions') {
        return { ok: true, json: async () => ({ sessions: [MOCK_SESSION] }) }
      }
      if (method === 'GET' && url.includes('/api/chat/sessions/')) {
        return { ok: true, json: async () => ({ session: MOCK_SESSION, messages: [] }) }
      }
      return { ok: false, json: async () => ({ error: 'Not found' }) }
    }))

    render(<ChatPage />)
    await waitFor(() => screen.getAllByTestId('session-item'))
    fireEvent.click(screen.getAllByTestId('session-item')[0])
    await waitFor(() => screen.getByTestId('chat-input'))
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    expect(screen.getByTestId('send-button')).toBeInTheDocument()
  })

  it('does not render input when no session is active', async () => {
    mockFetch({ 'GET /api/chat/sessions': { sessions: [] } })
    render(<ChatPage />)
    await waitFor(() => screen.getByTestId('no-sessions'))
    expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument()
  })
})
