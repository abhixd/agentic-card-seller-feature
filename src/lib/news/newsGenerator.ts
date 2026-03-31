// ---------------------------------------------------------------
// AI news article generator using Anthropic Claude API.
// Falls back gracefully if API key is missing or call fails.
// ---------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk'
import type { RssItem } from './rssParser'

const SYSTEM_PROMPT =
  "You are a Pokemon TCG market analyst writing a brief daily market update for card sellers and collectors. " +
  "Write concisely, with insight into what news means for card values. Sound professional but approachable — " +
  "like a knowledgeable collector writing for other collectors. Never sound robotic. 150-250 words."

export async function generateNewsArticle(item: RssItem): Promise<{
  title: string
  body:  string
  tags:  string[]
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY

  // Fallback if no key or placeholder key
  if (!apiKey || apiKey === 'placeholder' || apiKey.length < 20) {
    return {
      title: item.title,
      body:  item.summary || item.title,
      tags:  ['news'],
    }
  }

  try {
    const client = new Anthropic({ apiKey })

    const userPrompt =
      `Summarize this Pokemon TCG news and explain what it means for the card market:\n\n` +
      `${item.title} — ${item.summary}\n\n` +
      `Source: ${item.sourceName}\n\n` +
      `Reply with a JSON object: { "title": "...", "body": "...", "tags": ["tag1", "tag2"] }\n` +
      `Tags should be 2-4 lowercase keywords relevant to card sellers (e.g. "new-set", "reprint", "ban", "price-spike", "tournament").`

    const message = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 512,
      messages: [
        { role: 'user', content: userPrompt },
      ],
      system: SYSTEM_PROMPT,
    })

    const content = message.content[0]
    if (content.type !== 'text') throw new Error('Unexpected response type')

    // Extract JSON from the response (may be wrapped in markdown code blocks)
    const text = content.text
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON found in response')

    const parsed = JSON.parse(jsonMatch[0]) as { title?: string; body?: string; tags?: string[] }
    return {
      title: (parsed.title ?? item.title).slice(0, 200),
      body:  parsed.body ?? item.summary,
      tags:  Array.isArray(parsed.tags) ? parsed.tags.slice(0, 6) : ['news'],
    }
  } catch (err) {
    console.warn('[newsGenerator] Falling back to original summary:', err)
    return {
      title: item.title,
      body:  item.summary || item.title,
      tags:  ['news'],
    }
  }
}
