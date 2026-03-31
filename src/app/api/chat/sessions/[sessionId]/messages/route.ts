import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { sendMessage } from '@/lib/chat/chatService'

const SendMessageSchema = z.object({
  content: z.string().min(1, 'Message cannot be empty.').max(2000),
})

// POST /api/chat/sessions/[sessionId]/messages — send a message
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  const { sessionId } = await params

  const body = await req.json().catch(() => null)
  const parsed = SendMessageSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues?.[0]?.message ?? 'Invalid request.' },
      { status: 400 }
    )
  }

  const { reply, error } = await sendMessage(
    supabase, user.id, sessionId, parsed.data.content
  )

  if (error) {
    return NextResponse.json({ error }, { status: error === 'Session not found.' ? 404 : 500 })
  }
  return NextResponse.json({ reply })
}
