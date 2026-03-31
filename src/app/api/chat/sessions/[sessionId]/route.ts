import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getSessionWithMessages } from '@/lib/chat/chatService'

// GET /api/chat/sessions/[sessionId] — get session + messages
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  const { sessionId } = await params

  const { session, messages, error } = await getSessionWithMessages(supabase, user.id, sessionId)
  if (error || !session) {
    return NextResponse.json({ error: error ?? 'Session not found.' }, { status: 404 })
  }
  return NextResponse.json({ session, messages })
}
