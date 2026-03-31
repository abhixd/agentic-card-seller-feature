'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { RecommendationBanner } from '@/components/analysis/RecommendationBanner'
import { CompsSection } from '@/components/analysis/CompsSection'
import { FeesBreakdown } from '@/components/analysis/FeesBreakdown'
import { GradingScenarios } from '@/components/analysis/GradingScenarios'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ArrowLeft, ScanLine, Archive, CheckCircle, Loader2 } from 'lucide-react'
import type { FullAnalysisResponse } from '@/types/analysis'

const CATEGORY_COLORS: Record<string, 'default' | 'secondary' | 'outline'> = {
  sports: 'default',
  tcg:    'secondary',
  other:  'outline',
}

function LoadingSkeleton() {
  return (
    <div data-testid="result-loading" className="space-y-4 max-w-xl mx-auto">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  )
}

export default function AnalysisResultPage() {
  const { analysisId } = useParams<{ analysisId: string }>()
  const router = useRouter()

  const [analysis, setAnalysis]   = useState<FullAnalysisResponse | null>(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)

  // Save-to-inventory state
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
    setSaving(true)
    setSaveError(null)
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
      // Navigate to inventory detail after short delay
      setTimeout(() => router.push(`/inventory/${item.item_id}`), 800)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save to inventory')
      setSaving(false)
    }
  }

  if (loading) return <LoadingSkeleton />

  if (error || !analysis) {
    return (
      <div data-testid="result-error" className="space-y-4 max-w-xl mx-auto">
        <p className="text-sm text-destructive">{error ?? 'Analysis not found.'}</p>
        <Link href="/analyze" className="text-sm underline text-muted-foreground hover:text-foreground">
          ← Back to search
        </Link>
      </div>
    )
  }

  const { card, comps, fees, grading_scenarios, recommendation, condition_score } = analysis
  const showGrading = grading_scenarios.length > 0 && recommendation.type !== 'INSUFFICIENT_CONFIDENCE'

  return (
    <div data-testid="analysis-result" className="space-y-4 max-w-xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/analyze"
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Back to search"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold truncate">{card.card_name}</h1>
            {card.variant && (
              <Badge variant="outline" className="text-xs shrink-0">{card.variant}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {card.franchise_or_brand} · {card.set_name}
            {card.year ? ` · ${card.year}` : ''}
          </p>
        </div>
        <Badge variant={CATEGORY_COLORS[card.category] ?? 'outline'} className="shrink-0">
          {card.category}
        </Badge>
      </div>

      {/* Recommendation */}
      <RecommendationBanner type={recommendation.type} rationale={recommendation.rationale} />

      {/* Market data + Fees side by side */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground font-medium uppercase tracking-wide">
              Market Data
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CompsSection comps={comps} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground font-medium uppercase tracking-wide">
              Net Proceeds
            </CardTitle>
          </CardHeader>
          <CardContent>
            <FeesBreakdown fees={fees} />
          </CardContent>
        </Card>
      </div>

      {/* Grading scenarios */}
      {showGrading && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground font-medium uppercase tracking-wide">
              Grading Scenarios
            </CardTitle>
          </CardHeader>
          <CardContent>
            <GradingScenarios scenarios={grading_scenarios} />
          </CardContent>
        </Card>
      )}

      {/* Condition summary (if entered) */}
      {condition_score !== null && (
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Condition score</span>
              <span className="font-semibold tabular-nums">{condition_score} / 20</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Save to inventory */}
      <Card className="border-dashed">
        <CardContent className="pt-4 pb-4 space-y-3">
          {saveError && (
            <Alert variant="destructive" data-testid="save-error">
              <AlertDescription className="text-xs">{saveError}</AlertDescription>
            </Alert>
          )}
          <Button
            data-testid="save-to-inventory-button"
            variant={saved ? 'outline' : 'default'}
            className="w-full gap-2"
            onClick={handleSave}
            disabled={saving || saved}
          >
            {saved
              ? <><CheckCircle className="h-4 w-4 text-green-500" /> Saved to inventory</>
              : saving
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
              : <><Archive className="h-4 w-4" /> Save to inventory</>
            }
          </Button>
        </CardContent>
      </Card>

      <Separator />

      {/* Footer */}
      <div className="flex items-center gap-2 text-muted-foreground">
        <ScanLine className="h-4 w-4" />
        <Link href="/analyze" className="text-sm underline hover:text-foreground">
          Analyze another card
        </Link>
      </div>
    </div>
  )
}
