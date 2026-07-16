'use client'

/**
 * AnalysisSheet — the full card analysis as an IN-CONTEXT slide-over on the grade page.
 *
 * The old flow navigated to /analyze and lost the graded card (ephemeral state, and the analyze page
 * has its own back-to-search semantics). This never navigates: the sheet slides over the grade result,
 * shows exactly what /analyze/[catalogId] shows (shared CardAnalysisContent), and ✕ / Esc / backdrop
 * returns you to the graded card untouched.
 */
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { CardAnalysisContent } from '@/components/catalog/CardAnalysisContent'

export function AnalysisSheet({ catalogId, title, onClose }: {
  catalogId: string | null
  title?: string | null
  onClose: () => void
}) {
  useEffect(() => {
    if (!catalogId) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'          // lock the page scroll behind the sheet
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [catalogId, onClose])

  if (!catalogId) return null

  return (
    <div className="fixed inset-0 z-[80] flex justify-end bg-black/60" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-3xl flex-col bg-background shadow-2xl animate-in slide-in-from-right duration-200"
      >
        {/* sticky header — always one obvious way back to the graded card */}
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{title || 'Card analysis'}</h2>
            <p className="text-xs text-muted-foreground">price history · PSA-grade pricing · grading advisor</p>
          </div>
          <button
            onClick={onClose}
            className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            aria-label="Close analysis and return to the graded card"
          >
            <X className="h-3.5 w-3.5" /> Back to grade
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
          <CardAnalysisContent catalogId={catalogId} />
        </div>
      </div>
    </div>
  )
}
