import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createSession, listSessions } from '@/lib/chat/chatService'

// POST /api/chat/sessions — create a new chat session
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const title = typeof body?.title === 'string' ? body.title : 'New conversation'

  const { session, error } = await createSession(supabase, user.id, title)
  if (error || !session) {
    return NextResponse.json({ error: error ?? 'Failed to create session.' }, { status: 500 })
  }
  return NextResponse.json(session, { status: 201 })
}

// GET /api/chat/sessions — list all sessions for the user
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  const { sessions, error } = await listSessions(supabase, user.id)
  if (error) {
    return NextResponse.json({ error }, { status: 500 })
  }
  return NextResponse.json({ sessions })
}
