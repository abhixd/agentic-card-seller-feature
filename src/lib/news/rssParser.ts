// ---------------------------------------------------------------
// RSS / Atom feed parser using native fetch + regex-based XML parsing.
// No external XML library needed.
// ---------------------------------------------------------------

export const NEWS_SOURCES = [
  { name: 'PokeBeach',        url: 'https://www.pokebeach.com/feed/',                tags: ['tcg', 'market'] },
  { name: 'PokéJungle',       url: 'https://pokejungle.net/feed/',                   tags: ['news', 'releases'] },
  { name: 'Pokémon Official', url: 'https://www.pokemon.com/en/pokemon-news/rss',    tags: ['official'] },
]

export interface RssItem {
  title:      string
  link:       string
  pubDate:    Date
  summary:    string
  source:     string
  sourceName: string
}

// ---------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------

function extractTag(xml: string, tag: string): string {
  // Handle both <tag>content</tag> and CDATA: <tag><![CDATA[content]]></tag>
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, 'i')
  const m = re.exec(xml)
  if (!m) return ''
  return (m[1] ?? m[2] ?? '').trim()
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i')
  const m = re.exec(xml)
  return m ? m[1].trim() : ''
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
}

function parseDate(raw: string): Date {
  if (!raw) return new Date()
  const d = new Date(raw)
  return isNaN(d.getTime()) ? new Date() : d
}

function parseItems(xml: string, sourceName: string, sourceUrl: string): RssItem[] {
  const items: RssItem[] = []

  // Try RSS 2.0 <item> tags
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1]
    const title   = decodeEntities(stripHtml(extractTag(block, 'title')))
    const link    = decodeEntities(extractTag(block, 'link') || extractAttr(block, 'link', 'href'))
    const pubDate = parseDate(extractTag(block, 'pubDate') || extractTag(block, 'dc:date'))
    const desc    = decodeEntities(stripHtml(extractTag(block, 'description') || extractTag(block, 'summary')))
    if (title && link) {
      items.push({ title, link, pubDate, summary: desc.slice(0, 400), source: sourceUrl, sourceName })
    }
  }

  // If no <item>s, try Atom <entry> tags
  if (items.length === 0) {
    const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi
    while ((m = entryRe.exec(xml)) !== null) {
      const block = m[1]
      const title   = decodeEntities(stripHtml(extractTag(block, 'title')))
      const link    = decodeEntities(extractAttr(block, 'link', 'href') || extractTag(block, 'id'))
      const pubDate = parseDate(extractTag(block, 'published') || extractTag(block, 'updated'))
      const desc    = decodeEntities(stripHtml(extractTag(block, 'summary') || extractTag(block, 'content')))
      if (title && link) {
        items.push({ title, link, pubDate, summary: desc.slice(0, 400), source: sourceUrl, sourceName })
      }
    }
  }

  return items
}

// ---------------------------------------------------------------
// Fetch a single feed
// ---------------------------------------------------------------

async function fetchFeed(url: string, sourceName: string): Promise<RssItem[]> {
  try {
    const res = await fetch(url, {
      next: { revalidate: 3600 },
      headers: { 'User-Agent': 'CardSellerOS/1.0 (RSS reader)' },
    })
    if (!res.ok) {
      console.warn(`[RSS] Failed to fetch ${url}: ${res.status}`)
      return []
    }
    const text = await res.text()
    return parseItems(text, sourceName, url)
  } catch (err) {
    console.warn(`[RSS] Error fetching ${url}:`, err)
    return []
  }
}

// ---------------------------------------------------------------
// Fetch all feeds, deduplicate by link, sort by date desc
// ---------------------------------------------------------------

export async function fetchAllFeeds(): Promise<RssItem[]> {
  const results = await Promise.allSettled(
    NEWS_SOURCES.map((src) => fetchFeed(src.url, src.name))
  )

  const all: RssItem[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value)
  }

  // Deduplicate by link
  const seen = new Set<string>()
  const deduped = all.filter((item) => {
    if (seen.has(item.link)) return false
    seen.add(item.link)
    return true
  })

  // Sort by date descending
  deduped.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
  return deduped
}
