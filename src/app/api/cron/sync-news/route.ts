import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { fetchAllFeeds } from '@/lib/news/rssParser'
import { generateNewsArticle } from '@/lib/news/newsGenerator'

function makeSlug(title: string, date: Date): string {
  return (
    title
      .slice(0, 50)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') +
    '-' +
    date.toISOString().slice(0, 10)
  )
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const supabase = await createClient()
    const items = await fetchAllFeeds()
    const limited = items.slice(0, 10)
    let processed = 0

    for (const item of limited) {
      const slug = makeSlug(item.title, item.pubDate)

      // Check if slug already exists
      const { data: existing } = await supabase
        .from('pokemon_news')
        .select('id')
        .eq('slug', slug)
        .maybeSingle()

      if (existing) continue

      // Generate article
      const article = await generateNewsArticle(item)

      // Insert into DB
      const { error } = await supabase.from('pokemon_news').insert({
        slug,
        title:        article.title,
        summary:      item.summary.slice(0, 300),
        body:         article.body,
        source_url:   item.link,
        source_name:  item.sourceName,
        tags:         article.tags,
        published_at: item.pubDate.toISOString(),
      })

      if (error) {
        console.error('[sync-news] Insert error:', error.message)
      } else {
        processed++
      }
    }

    return Response.json({ ok: true, processed })
  } catch (err) {
    console.error('[cron/sync-news] Error:', err)
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
