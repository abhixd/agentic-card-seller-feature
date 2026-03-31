import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const limit  = Math.min(parseInt(searchParams.get('limit')  ?? '20', 10), 100)
  const offset = parseInt(searchParams.get('offset') ?? '0', 10)

  try {
    const supabase = await createClient()

    const { data: articles, error, count } = await supabase
      .from('pokemon_news')
      .select('*', { count: 'exact' })
      .order('published_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      console.error('[api/news] Query error:', error.message)
      return Response.json({ error: error.message }, { status: 500 })
    }

    return Response.json({
      articles: articles ?? [],
      total: count ?? 0,
    })
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
