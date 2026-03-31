import { NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { bulkSyncAllCards } from '@/lib/pokemon/bulkSync'

// Allow up to 5 minutes for large batch syncs
export const maxDuration = 300

export async function GET() {
  return Response.json({ status: 'ready', info: 'POST to trigger bulk sync. Optional body: { startIndex, batchSize }' })
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const expected = `Bearer ${process.env.ADMIN_SECRET}`

  if (!process.env.ADMIN_SECRET || authHeader !== expected) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Parse optional chunking params from JSON body
  let startIndex = 0
  let batchSize  = 15  // default: 15 sets per call (~60-90s)
  try {
    const body = await req.json()
    if (typeof body.startIndex === 'number') startIndex = body.startIndex
    if (typeof body.batchSize  === 'number') batchSize  = body.batchSize
  } catch {
    // No body or invalid JSON — use defaults
  }

  const supabase = createServiceClient()

  const stream = new ReadableStream({
    async start(controller) {
      const encode = (obj: unknown) =>
        new TextEncoder().encode(JSON.stringify(obj) + '\n')

      try {
        controller.enqueue(encode({ type: 'start', message: `Starting bulk sync (sets ${startIndex}–${startIndex + batchSize - 1})...` }))

        const stats = await bulkSyncAllCards(supabase, (msg) => {
          controller.enqueue(encode({ type: 'progress', message: msg }))
        }, { startIndex, batchSize })

        controller.enqueue(encode({ type: 'complete', stats }))
      } catch (err) {
        controller.enqueue(
          encode({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        )
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    },
  })
}
