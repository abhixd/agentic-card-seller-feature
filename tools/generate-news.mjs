import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync } from 'fs'

// Load .env.local
const __dir = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dir, '..', '.env.local')
const envFile = readFileSync(envPath, 'utf8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/)
  if (m) process.env[m[1]] = m[2]
}

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
// Use Vercel AI Gateway via OIDC token (Anthropic SDK compatible base URL)
const apiKey = process.env.ANTHROPIC_API_KEY || process.env.VERCEL_OIDC_TOKEN
const anthropic = new Anthropic({
  apiKey,
  ...(process.env.VERCEL_OIDC_TOKEN && !process.env.ANTHROPIC_API_KEY ? {
    baseURL: 'https://ai-gateway.vercel.sh/v1/providers/anthropic',
    defaultHeaders: { 'Authorization': `Bearer ${process.env.VERCEL_OIDC_TOKEN}` },
  } : {}),
})

const SYSTEM = `You are NEXUS, the market intelligence AI for a Pokemon card seller platform. You write sharp, insightful articles about the Pokemon TCG collecting market — set releases, price trends, reprint impacts, grading economics, arbitrage opportunities, and collector strategy. You sound like a brilliant quant trader who deeply loves Pokemon cards. Precise, data-aware, occasionally dry humor. Never generic.`

const PROMPT = `Generate 6 market-focused Pokemon TCG news articles for April 2026. Each MUST be relevant to card sellers and collectors — prices, new sets, reprints, market trends, grading, or collector strategy. No video game news, no anime, no Pokemon GO.

Market context (April 2026):
- Prismatic Evolutions (Jan 2026) still driving Eevee-lution demand; Umbreon ex full-art near $180
- Destined Rivals (Mar 2026) just released — Charizard ex alt-art opened at $220, settling around $150
- Stellar Crown Mew ex dropped 40% after reprint in Destined Rivals booster bundles
- TCG Pocket "Mega Shine" pack announced — causing speculation in physical Mega Evolution cards
- Base Set 1st Edition Charizard PSA 10 crossed $10,500 in February auction
- PSA grading economy tier now 12-day turnaround, bulk tier still 90+ days
- Upcoming: Battle Partners (Jun 2026) confirms returning Blastoise ex and Venusaur ex lines
- Rumored Q3 2026 "Mega Evolution ex" dedicated set — unconfirmed but driving Mega Charizard X prices up 35% in 3 weeks
- Japanese exclusives: Shiny Treasures ex still a 30-40% premium to US equivalents

Reply with a JSON array of exactly 6 objects:
{
  "title": "attention-grabbing headline under 80 chars",
  "body": "250-300 word article with specific card names, prices in USD, % changes, set names, dates",
  "tags": ["2-4 lowercase tags from: reprint, new-set, price-spike, price-drop, grading, arbitrage, charizard, eevee, market-analysis, japanese, psa, upcoming-set"],
  "source_name": "NEXUS Intelligence"
}`

async function run() {
  console.log('Generating articles with Claude...')
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: PROMPT }]
  })

  const text = msg.content[0].text
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) {
    console.error('No JSON array found in response')
    console.log(text.slice(0, 500))
    process.exit(1)
  }

  const articles = JSON.parse(match[0])
  console.log(`Generated ${articles.length} articles`)

  const now = new Date()
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i]
    const pubDate = new Date(now.getTime() - i * 3 * 60 * 60 * 1000)
    const slugBase = a.title.slice(0, 50).toLowerCase()
      .replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    const slug = `${slugBase}-${now.toISOString().slice(0, 10)}-${i}`

    const { error } = await supa.from('pokemon_news').upsert({
      slug,
      title: a.title,
      summary: a.body.slice(0, 280),
      body: a.body,
      source_url: null,
      source_name: a.source_name || 'NEXUS Intelligence',
      tags: a.tags || ['market-analysis'],
      published_at: pubDate.toISOString(),
    }, { onConflict: 'slug' })

    if (error) console.error(`Insert error (${a.title.slice(0, 40)}):`, error.message)
    else console.log(`✓ ${a.title.slice(0, 65)}`)
  }

  console.log('\nDone!')
}

run().catch(err => { console.error(err); process.exit(1) })
