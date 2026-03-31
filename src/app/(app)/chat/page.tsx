'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { MessageSquare, Send, Plus, ChevronLeft } from 'lucide-react'
import type { ChatSession, ChatMessage } from '@/types/chat'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ---------------------------------------------------------------------------
// Message bubble
// ---------------------------------------------------------------------------

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'tool') return null // don't render raw tool results

  const isUser = msg.role === 'user'
  return (
    <div
      data-testid={`message-${msg.role}`}
      className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={[
          'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'bg-primary text-primary-foreground rounded-br-sm'
            : 'bg-muted text-foreground rounded-bl-sm',
        ].join(' ')}
      >
        <p className="whitespace-pre-wrap">{msg.content}</p>
        <p className={`text-[10px] mt-1 ${isUser ? 'text-primary-foreground/60' : 'text-muted-foreground'}`}>
          {fmtTime(msg.created_at)}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Session list item
// ---------------------------------------------------------------------------

function SessionItem({
  session,
  active,
  onSelect,
}: {
  session: ChatSession
  active:  boolean
  onSelect: () => void
}) {
  return (
    <button
      data-testid="session-item"
      onClick={onSelect}
      className={[
        'w-full text-left px-3 py-2.5 rounded-lg text-sm truncate transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'hover:bg-muted text-foreground',
      ].join(' ')}
    >
      {session.title}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main chat page
// ---------------------------------------------------------------------------

export default function ChatPage() {
  const [sessions, setSessions]         = useState<ChatSession[]>([])
  const [activeId, setActiveId]         = useState<string | null>(null)
  const [messages, setMessages]         = useState<ChatMessage[]>([])
  const [input, setInput]               = useState('')
  const [sending, setSending]           = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [sendError, setSendError]       = useState<string | null>(null)
  const [showSidebar, setShowSidebar]   = useState(true)

  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' })
  }, [messages])

  // Load session list
  const loadSessions = useCallback(async () => {
    setLoadingSessions(true)
    const res = await fetch('/api/chat/sessions')
    if (res.ok) {
      const body = await res.json()
      setSessions(body.sessions ?? [])
    }
    setLoadingSessions(false)
  }, [])

  useEffect(() => { loadSessions() }, [loadSessions])

  // Load messages for active session
  const loadMessages = useCallback(async (sessionId: string) => {
    setLoadingMessages(true)
    const res = await fetch(`/api/chat/sessions/${sessionId}`)
    if (res.ok) {
      const body = await res.json()
      setMessages(body.messages ?? [])
    }
    setLoadingMessages(false)
  }, [])

  useEffect(() => {
    if (activeId) loadMessages(activeId)
    else setMessages([])
  }, [activeId, loadMessages])

  // Create a new session
  async function handleNewSession() {
    const res = await fetch('/api/chat/sessions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ title: 'New conversation' }),
    })
    if (res.ok) {
      const session: ChatSession = await res.json()
      setSessions((prev) => [session, ...prev])
      setActiveId(session.session_id)
      setMessages([])
    }
  }

  // Send a message
  async function handleSend() {
    if (!input.trim() || !activeId || sending) return
    setSending(true)
    setSendError(null)

    const text = input.trim()
    setInput('')

    // Optimistic user bubble (with a fake id)
    const optimistic: ChatMessage = {
      message_id: `opt-${Date.now()}`,
      session_id: activeId,
      role:       'user',
      content:    text,
      tool_calls: null,
      tool_name:  null,
      created_at: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimistic])

    try {
      const res = await fetch(`/api/chat/sessions/${activeId}/messages`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ content: text }),
      })
      const body = await res.json()
      if (!res.ok) {
        setSendError(body.error ?? 'Failed to send message.')
        setMessages((prev) => prev.filter((m) => m.message_id !== optimistic.message_id))
      } else {
        // Replace optimistic + append reply by reloading the session messages
        await loadMessages(activeId)
        // Also refresh session list (title may have changed)
        await loadSessions()
      }
    } catch {
      setSendError('Network error. Please try again.')
      setMessages((prev) => prev.filter((m) => m.message_id !== optimistic.message_id))
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const visibleMessages = messages.filter((m) => m.role !== 'tool')

  return (
    <div data-testid="chat-page" className="flex h-[calc(100vh-8rem)] max-w-5xl mx-auto gap-0 overflow-hidden rounded-xl border bg-background">

      {/* Sidebar */}
      {showSidebar && (
        <div
          data-testid="chat-sidebar"
          className="w-56 shrink-0 border-r flex flex-col bg-muted/30"
        >
          <div className="p-3 border-b flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Conversations</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={handleNewSession}
              data-testid="new-session-button"
              aria-label="New conversation"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {loadingSessions ? (
              <div data-testid="sessions-loading" className="space-y-2 p-1">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : sessions.length === 0 ? (
              <p data-testid="no-sessions" className="text-xs text-muted-foreground px-2 py-4 text-center">
                No conversations yet.
              </p>
            ) : (
              sessions.map((s) => (
                <SessionItem
                  key={s.session_id}
                  session={s}
                  active={s.session_id === activeId}
                  onSelect={() => setActiveId(s.session_id)}
                />
              ))
            )}
          </div>
        </div>
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="border-b px-4 py-3 flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setShowSidebar((v) => !v)}
            aria-label="Toggle sidebar"
          >
            {showSidebar ? <ChevronLeft className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
          </Button>
          <h1 className="text-sm font-semibold">
            {activeId
              ? sessions.find((s) => s.session_id === activeId)?.title ?? 'Chat'
              : 'Chat Copilot'}
          </h1>
        </div>

        {/* Message area */}
        <div
          data-testid="message-list"
          className="flex-1 overflow-y-auto p-4 space-y-3"
        >
          {!activeId && (
            <div data-testid="chat-empty" className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-3">
              <MessageSquare className="h-10 w-10 opacity-30" />
              <p className="text-sm">Start a new conversation or select one from the sidebar.</p>
              <Button size="sm" variant="outline" onClick={handleNewSession} data-testid="start-chat-button">
                <Plus className="h-4 w-4 mr-1.5" /> New conversation
              </Button>
            </div>
          )}

          {activeId && loadingMessages && (
            <div data-testid="messages-loading" className="space-y-3">
              <Skeleton className="h-10 w-2/3" />
              <Skeleton className="h-10 w-1/2 ml-auto" />
            </div>
          )}

          {activeId && !loadingMessages && visibleMessages.length === 0 && (
            <div data-testid="empty-session" className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-2">
              <p className="text-sm">Ask me about your inventory, a card analysis, or your best sell opportunities.</p>
            </div>
          )}

          {visibleMessages.map((msg) => (
            <MessageBubble key={msg.message_id} msg={msg} />
          ))}

          {sending && (
            <div data-testid="thinking-indicator" className="flex justify-start">
              <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm text-muted-foreground">
                Thinking…
              </div>
            </div>
          )}

          {sendError && (
            <p data-testid="send-error" className="text-xs text-destructive text-center">{sendError}</p>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input area */}
        {activeId && (
          <div className="border-t p-3 shrink-0">
            <div className="flex gap-2 items-end">
              <textarea
                data-testid="chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about your inventory, a card analysis, or selling opportunities…"
                rows={2}
                disabled={sending}
                className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              />
              <Button
                data-testid="send-button"
                onClick={handleSend}
                disabled={!input.trim() || sending}
                size="sm"
                className="h-10 px-3"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5 px-1">
              Press Enter to send · Shift+Enter for new line
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
