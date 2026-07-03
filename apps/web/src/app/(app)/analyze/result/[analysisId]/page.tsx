'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { RecommendationBanner } from '@/components/analysis/RecommendationBanner'
import { CompsSection } from '@/components/analysis/CompsSection'
import { FeesBreakdown } from '@/components/analysis/FeesBreakdown'
import { GradingScenarios } from '@/components/analysis/GradingScenarios'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ArrowLeft, ScanLine, Archive, CheckCircle, Loader2,
  TrendingUp, Star,
} from 'lucide-react'
import type { FullAnalysisResponse } from '@/types/analysis'
import { ListingGenerator } from '@/components/analyze/ListingGenerator'

// ── Loading skeleton ───────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div data-testid="result-loading" className="space-y-4 max-w-2xl mx-auto px-4">
      <Skeleton className="h-7 w-44 rounded-xl" />
      <Skeleton className="h-28 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-4">
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
      <Skeleton className="h-36 w-full rounded-2xl" />
    </div>
  )
}

// ── Section wrapper ────────────────────────────────────────────────────────────

function Section({
  title, icon: Icon, children, accentColor = '#6366f1',
}: {
  title: string
  icon: typeof TrendingUp
  children: React.ReactNode
  accentColor?: string
}) {
  return (
    <div
      className="rounded-2xl border p-5 space-y-4"
      style={{
        background:  'rgba(24,24,27,0.7)',
        borderColor: 'rgba(63,63,70,0.6)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="flex items-center justify-center w-7 h-7 rounded-lg shrink-0"
          style={{ background: `${accentColor}20`, border: `1px solid ${accentColor}35` }}
        >
          <Icon className="h-3.5 w-3.5" style={{ color: accentColor }} />
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-400">
          {title}
        </span>
      </div>
      {children}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function AnalysisResultPage() {
  const { analysisId } = useParams<{ analysisId: string }>()
  const router = useRouter()

  const [analysis, setAnalysis] = useState<FullAnalysisResponse | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  const [saving, setSaving]       = useState(false)
  const [saved, setSaved]         = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/analysis/${analysisId}`)
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? 'Failed to load analysis')
        }
        setAnalysis(await res.json())
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load analysis')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [analysisId])

  async function handleSave() {
    if (!analysis) return
    setSaving(true); setSaveError(null)
    try {
      const res = await fetch('/api/inventory', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          catalogId:       analysis.catalog_id,
          analysisId:      analysis.analysis_id,
          acquisitionCost: analysis.fees.acquisitionCost,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to save')
      }
      const item = await res.json()
      setSaved(true)
      setTimeout(() => router.push(`/inventory/${item.item_id}`), 800)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save to inventory')
      setSaving(false)
    }
  }

  if (loading) return <LoadingSkeleton />

  if (error || !analysis) {
    return (
      <div data-testid="result-error" className="space-y-4 max-w-2xl mx-auto px-4">
        <p className="text-sm text-red-400">{error ?? 'Analysis not found.'}</p>
        <Link href="/analyze" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
          ← Back to search
        </Link>
      </div>
    )
  }

  const { card, comps, fees, grading_scenarios, recommendation, condition_score } = analysis
  const showGrading = grading_scenarios.length > 0 && recommendation.type !== 'INSUFFICIENT_CONFIDENCE'

  return (
    <div data-testid="analysis-result" className="max-w-2xl mx-auto px-4 pb-12 space-y-4">

      {/* ── Header ── */}
      <div className="flex items-center gap-3 pt-1">
        <Link
          href="/analyze"
          className="text-zinc-500 hover:text-zinc-300 transition-colors"
          aria-label="Back to search"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-white truncate">{card.card_name}</h1>
          <p className="text-xs text-zinc-500 truncate">
            {card.set_name}
            {card.year ? ` · ${card.year}` : ''}
            {card.variant ? ` · ${card.variant}` : ''}
          </p>
        </div>
        <span
          className="shrink-0 text-[10px] font-semibold px-2 py-1 rounded-lg uppercase tracking-widest"
          style={{
            background:  'rgba(99,102,241,0.15)',
            border:      '1px solid rgba(99,102,241,0.25)',
            color:       '#a5b4fc',
          }}
        >
          {card.category}
        </span>
      </div>

      {/* ── Recommendation ── */}
      <RecommendationBanner type={recommendation.type} rationale={recommendation.rationale} />

      {/* ── Market data + Net proceeds ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Section title="Recent sales" icon={TrendingUp} accentColor="#60a5fa">
          <CompsSection comps={comps} />
        </Section>

        <Section title="Your take-home" icon={Archive} accentColor="#34d399">
          <FeesBreakdown fees={fees} />
        </Section>
      </div>

      {/* ── Grading scenarios ── */}
      {showGrading && (
        <Section title="Should you send it for grading?" icon={Star} accentColor="#fbbf24">
          <GradingScenarios scenarios={grading_scenarios} />
        </Section>
      )}

      {/* ── Condition score (if entered) ── */}
      {condition_score !== null && (
        <div
          className="rounded-2xl border px-4 py-3 flex items-center justify-between"
          style={{
            background:  'rgba(24,24,27,0.7)',
            borderColor: 'rgba(63,63,70,0.5)',
          }}
        >
          <span className="text-sm text-zinc-400">Your condition score</span>
          <div className="flex items-center gap-2">
            <div className="w-24 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width:      `${(condition_score / 20) * 100}%`,
                  background: condition_score >= 16 ? '#34d399' : condition_score >= 12 ? '#fbbf24' : '#f87171',
                }}
              />
            </div>
            <span data-testid="condition-score" className="text-sm font-semibold text-white tabular-nums">
              {condition_score}<span className="text-zinc-600 font-normal"> / 20</span>
            </span>
          </div>
        </div>
      )}

      {/* ── Save to inventory ── */}
      <div
        className="rounded-2xl border p-4 space-y-3"
        style={{
          background:  'rgba(24,24,27,0.5)',
          borderColor: 'rgba(63,63,70,0.4)',
          borderStyle: 'dashed',
        }}
      >
        {saveError && (
          <div data-testid="save-error" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {saveError}
          </div>
        )}
        <Button
          data-testid="save-to-inventory-button"
          className="w-full gap-2 h-10"
          style={saved ? {} : {
            background: 'rgba(24,24,27,0.9)',
            border:     '1px solid rgba(63,63,70,0.7)',
            color:      '#a1a1aa',
          }}
          onClick={handleSave}
          disabled={saving || saved}
        >
          {saved
            ? <><CheckCircle className="h-4 w-4 text-emerald-400" /><span className="text-emerald-300">Saved to inventory</span></>
            : saving
            ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
            : <><Archive className="h-4 w-4" /> Add to my inventory</>
          }
        </Button>
        <p className="text-[10px] text-zinc-600 text-center">
          Saves this card, condition, and price data to track your collection
        </p>
      </div>

      {/* ── eBay listing generator ── */}
      {recommendation.type !== 'INSUFFICIENT_CONFIDENCE' && (
        <ListingGenerator analysisId={analysisId} cardName={card.card_name} />
      )}

      {/* ── Footer ── */}
      <div className="flex items-center gap-2 text-zinc-600 pt-2">
        <ScanLine className="h-4 w-4" />
        <Link href="/analyze" className="text-sm hover:text-zinc-300 transition-colors">
          Analyze another card
        </Link>
      </div>
    </div>
  )
}
