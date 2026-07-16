'use client'

/**
 * CardAnalysisContent — the FULL card analysis (decision hero, price intelligence, grading advisor),
 * extracted from /analyze/[catalogId] so it renders anywhere: the analyze detail page AND the grade
 * page's in-context analysis sheet (no navigation — grade a card, see everything Analyze shows, close,
 * and you're exactly where you were).
 *
 * Self-contained: fetches /api/catalog/{catalogId} itself and owns its loading skeleton.
 */
import { useState, useEffect } from 'react'
import { PriceIntelligenceHub } from '@/components/catalog/PriceIntelligenceHub'
import { CardDecisionHero } from '@/components/catalog/CardDecisionHero'
import { GradingAdvisor } from '@/components/catalog/GradingAdvisor'
import { TournamentMetaBadge } from '@/components/catalog/TournamentMetaBadge'
import type { CardCatalogItem } from '@/types/catalog'

export function CardAnalysisContent({ catalogId }: { catalogId: string }) {
  const [card, setCard] = useState<CardCatalogItem | null>(null)
  const [loading, setLoading] = useState(true)
  // Edition selection is owned by PriceIntelligenceHub; kept as state so a future consumer can read it.
  const [, setSelectedEdition] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setCard(null)
    fetch(`/api/catalog/${catalogId}`)
      .then(r => r.json())
      .then(d => { setCard(d.card); setLoading(false) })
      .catch(() => setLoading(false))
  }, [catalogId])

  const meta = (card?.metadata_json ?? {}) as Record<string, any>
  const types: string[] = meta?.types ?? []
  const imageUrl = meta?.images?.large ?? meta?.images?.small ?? card?.canonical_image_url

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-48 bg-muted/40 animate-pulse rounded-lg" />
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
          <div className="aspect-[2/3] bg-muted/30 animate-pulse rounded-2xl" />
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => <div key={i} className="h-12 bg-muted/30 animate-pulse rounded-xl" />)}
          </div>
        </div>
      </div>
    )
  }

  if (!card) return <div className="text-muted-foreground">Card not found.</div>

  return (
    <div className="space-y-6">
      {/* ── HERO: 3-column decision layout (metrics · image · trajectory) ── */}
      <CardDecisionHero
        catalogId={catalogId}
        cardName={card.card_name}
        setName={card.set_name}
        year={card.year}
        cardNumber={card.card_number}
        imageUrl={imageUrl ?? null}
        types={types}
      />

      {/* tiny meta strip */}
      <div className="flex items-center justify-center gap-2.5 flex-wrap -mt-1">
        {meta?.rarity && <span className="text-[11px] text-muted-foreground">{meta.rarity}</span>}
        {meta?.hp && <span className="text-[11px] text-muted-foreground border border-border/30 px-2 py-0.5 rounded-full">HP {meta.hp}</span>}
        <TournamentMetaBadge catalogId={catalogId} />
      </div>

      {/* ── BELOW THE FOLD: full price chart + grading ── */}
      <PriceIntelligenceHub
        catalogId={catalogId}
        meta={meta}
        onEditionChange={setSelectedEdition}
      />

      {/* GRADING — left exactly as-is. (PSA cert lookup removed — standalone utility.) */}
      <GradingAdvisor catalogId={catalogId} />
    </div>
  )
}
