import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------

const {
  mockGetUser,
  mockCreateSession,
  mockListSessions,
  mockGetSessionWithMessages,
  mockSendMessage,
} = vi.hoisted(() => ({
  mockGetUser:                 vi.fn(),
  mockCreateSession:           vi.fn(),
  mockListSessions:            vi.fn(),
  mockGetSessionWithMessages:  vi.fn(),
  mockSendMessage:             vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({ auth: { getUser: mockGetUser } }),
}))

vi.mock('@/lib/chat/chatService', () => ({
  createSession:           mockCreateSession,
  listSessions:            mockListSessions,
  getSessionWithMessages:  mockGetSessionWithMessages,
  sendMessage:             mockSendMessage,
}))

import { POST as sessionsPost, GET as sessionsGet } from '@/app/api/chat/sessions/route'
import { GET as sessionGet } from '@/app/api/chat/sessions/[sessionId]/route'
import { POST as messagesPost } from '@/app/api/chat/sessions/[sessionId]/messages/route'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440010'

const MOCK_SESSION = {
  session_id: SESSION_ID,
  user_id:    'user-123',
  title:      'Test session',
  created_at: '2026-03-29T00:00:00Z',
  updated_at: '2026-03-29T00:00:00Z',
}

const MOCK_MESSAGE = {
  message_id: '550e8400-e29b-41d4-a716-446655440020',
  session_id: SESSION_ID,
  role:       'assistant',
  content:    'You have 3 cards in inventory.',
  tool_calls: null,
  tool_name:  null,
  created_at: '2026-03-29T00:00:00Z',
}

function makeSessionsRequest(method: 'POST' | 'GET', body?: object) {
  return new NextRequest('http://localhost/api/chat/sessions', {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  })
}

function makeSessionRequest(sessionId: string) {
  return new NextRequest(`http://localhost/api/chat/sessions/${sessionId}`)
}

function makeMessagesRequest(sessionId: string, body?: object) {
  return new NextRequest(`http://localhost/api/chat/sessions/${sessionId}/messages`, {
    method:  'POST',
    body:    JSON.stringify(body ?? {}),
    headers: { 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } } })
})

// ---------------------------------------------------------------------------
// POST /api/chat/sessions
// ---------------------------------------------------------------------------

describe('POST /api/chat/sessions', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await sessionsPost(makeSessionsRequest('POST'))
    expect(res.status).toBe(401)
  })

  it('returns 201 with session on success', async () => {
    mockCreateSession.mockResolvedValue({ session: MOCK_SESSION, error: null })
    const res = await sessionsPost(makeSessionsRequest('POST', { title: 'Test session' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.session_id).toBe(SESSION_ID)
    expect(body.title).toBe('Test session')
  })

  it('uses default title when none provided', async () => {
    mockCreateSession.mockResolvedValue({ session: MOCK_SESSION, error: null })
    await sessionsPost(makeSessionsRequest('POST'))
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.anything(), 'user-123', 'New conversation'
    )
  })

  it('returns 500 when service fails', async () => {
    mockCreateSession.mockResolvedValue({ session: null, error: 'DB error.' })
    const res = await sessionsPost(makeSessionsRequest('POST'))
    expect(res.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// GET /api/chat/sessions
// ---------------------------------------------------------------------------

describe('GET /api/chat/sessions', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await sessionsGet()
    expect(res.status).toBe(401)
  })

  it('returns sessions list', async () => {
    mockListSessions.mockResolvedValue({ sessions: [MOCK_SESSION], error: null })
    const res = await sessionsGet()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0].session_id).toBe(SESSION_ID)
  })

  it('returns empty list when no sessions', async () => {
    mockListSessions.mockResolvedValue({ sessions: [], error: null })
    const res = await sessionsGet()
    const body = await res.json()
    expect(body.sessions).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// GET /api/chat/sessions/[sessionId]
// ---------------------------------------------------------------------------

describe('GET /api/chat/sessions/[sessionId]', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await sessionGet(makeSessionRequest(SESSION_ID), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 404 when session not found', async () => {
    mockGetSessionWithMessages.mockResolvedValue({ session: null, messages: [], error: 'Session not found.' })
    const res = await sessionGet(makeSessionRequest(SESSION_ID), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(404)
  })

  it('returns session and messages on success', async () => {
    mockGetSessionWithMessages.mockResolvedValue({
      session:  MOCK_SESSION,
      messages: [MOCK_MESSAGE],
      error:    null,
    })
    const res = await sessionGet(makeSessionRequest(SESSION_ID), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.session.session_id).toBe(SESSION_ID)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('assistant')
  })
})

// ---------------------------------------------------------------------------
// POST /api/chat/sessions/[sessionId]/messages
// ---------------------------------------------------------------------------

describe('POST /api/chat/sessions/[sessionId]/messages', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await messagesPost(makeMessagesRequest(SESSION_ID, { content: 'hello' }), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 when content is empty', async () => {
    const res = await messagesPost(makeMessagesRequest(SESSION_ID, { content: '' }), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBeTruthy()
  })

  it('returns 400 when content is missing', async () => {
    const res = await messagesPost(makeMessagesRequest(SESSION_ID, {}), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 200 with reply on success', async () => {
    mockSendMessage.mockResolvedValue({ reply: MOCK_MESSAGE, error: null })
    const res = await messagesPost(makeMessagesRequest(SESSION_ID, { content: 'What should I sell?' }), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reply.content).toBe('You have 3 cards in inventory.')
  })

  it('returns 404 when session not found', async () => {
    mockSendMessage.mockResolvedValue({ reply: null, error: 'Session not found.' })
    const res = await messagesPost(makeMessagesRequest(SESSION_ID, { content: 'Hi' }), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(res.status).toBe(404)
  })

  it('passes sessionId and userId to sendMessage', async () => {
    mockSendMessage.mockResolvedValue({ reply: MOCK_MESSAGE, error: null })
    await messagesPost(makeMessagesRequest(SESSION_ID, { content: 'What should I sell?' }), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    })
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(), 'user-123', SESSION_ID, 'What should I sell?'
    )
  })
})
