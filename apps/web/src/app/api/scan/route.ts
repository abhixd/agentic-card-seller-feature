import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const formData = await req.formData()
    const file = formData.get('image') as File | null
    if (!file) return NextResponse.json({ error: 'No image provided' }, { status: 400 })

    // Validate size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: 'Image must be under 5MB' }, { status: 400 })
    }

    const buffer     = await file.arrayBuffer()
    const base64     = Buffer.from(buffer).toString('base64')
    const mediaType  = (file.type || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            {
              type:   'image',
              source: { type: 'base64', media_type: mediaType, data: base64 },
            },
            {
              type: 'text',
              text: `Identify this trading card. Return ONLY a JSON object with these exact fields:
{
  "card_name": "the card's name exactly as printed (e.g. Charizard, Pikachu, Blastoise)",
  "set_name": "the set name if visible (e.g. Base Set, Brilliant Stars) or null",
  "card_number": "the card number if visible (e.g. 4/102) or null",
  "confidence": "high | medium | low"
}

If this is not a trading card, return: {"card_name": null, "set_name": null, "card_number": null, "confidence": "low"}
Return ONLY the JSON, no explanation.`,
            },
          ],
        },
      ],
    })

    const text  = (message.content[0] as any)?.text ?? ''
    const clean = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const result = JSON.parse(clean)

    return NextResponse.json(result)
  } catch (e: any) {
    console.error('scan error:', e)
    return NextResponse.json({ error: e?.message ?? 'Scan failed' }, { status: 500 })
  }
}
