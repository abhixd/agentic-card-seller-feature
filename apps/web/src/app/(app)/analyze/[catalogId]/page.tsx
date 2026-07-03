'use client'

import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { PriceIntelligenceHub } from '@/components/catalog/PriceIntelligenceHub'
import { CardDecisionHero } from '@/components/catalog/CardDecisionHero'
import { GradingAdvisor } from '@/components/catalog/GradingAdvisor'
import { ArrowLeft } from 'lucide-react'
import type { CardCatalogItem } from '@/types/catalog'
import { TournamentMetaBadge } from '@/components/catalog/TournamentMetaBadge'

// NOTE (v2 redesign): this page is the decision-first hero layout. The old
// AnalysisForm / condition-estimator / CardMarket sections were removed —
// the sell/grade/hold analysis flow lives in Portfolio → Sell Intelligence.

export default function CardDetailPage() {
  const { catalogId } = useParams<{ catalogId: string }>()
  const searchParams  = useSearchParams()
  const backQuery     = searchParams.get('q') ?? ''

  const [card, setCard]       = useState<CardCatalogItem | null>(null)
  const [loading, setLoading] = useState(true)
  // Edition selection is owned by PriceIntelligenceHub; kept as state so a
  // future consumer (e.g. edition-aware analysis) can read it.
  const [, setSelectedEdition] = useState<string | null>(null)

  useEffect(() => {
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
      <div className="max-w-5xl mx-auto space-y-4 p-4">
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

  if (!card) return (
    <div className="max-w-5xl mx-auto p-4 text-muted-foreground">Card not found.</div>
  )

  return (
    <div className="max-w-5xl mx-auto px-4 pb-12 space-y-6">

      {/* Back link */}
      <Link
        href={backQuery ? `/analyze?q=${encodeURIComponent(backQuery)}` : '/analyze'}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors group"
      >
        <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" />
        {backQuery ? `Back to "${backQuery}" results` : 'Back to search'}
      </Link>

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
