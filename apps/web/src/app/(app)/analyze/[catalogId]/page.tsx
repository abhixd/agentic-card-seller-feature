'use client'

import { useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { CardAnalysisContent } from '@/components/catalog/CardAnalysisContent'

// NOTE (v2 redesign): this page is the decision-first hero layout. The old
// AnalysisForm / condition-estimator / CardMarket sections were removed —
// the sell/grade/hold analysis flow lives in Portfolio → Sell Intelligence.
// The analysis body itself lives in CardAnalysisContent (shared with the
// grade page's in-context analysis sheet).

export default function CardDetailPage() {
  const { catalogId } = useParams<{ catalogId: string }>()
  const searchParams  = useSearchParams()
  const backQuery     = searchParams.get('q') ?? ''

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

      <CardAnalysisContent catalogId={catalogId} />
    </div>
  )
}
