'use client'

/**
 * AddToInventoryButton
 *
 * One-click flow:
 *  1. "Add to inventory" — saves instantly with cost=0, no form required
 *  2. After adding → shows "✓ Added" + inline optional "Set cost" input
 *  3. If already in inventory → shows "In your inventory →" link
 *
 * Cost can be set/updated via PATCH after the fact.
 */

import { useState, useEffect, useRef } from 'react'
import { Archive, Check, Loader2, X, ArrowRight, Pencil, RotateCcw } from 'lucide-react'
import Link from 'next/link'

interface Props {
  catalogId: string
  tcgPrice:  number | null
}

export function AddToInventoryButton({ catalogId, tcgPrice }: Props) {
  type Phase = 'checking' | 'idle' | 'saving' | 'done' | 'error'

  const [phase,          setPhase]          = useState<Phase>('checking')
  const [itemId,         setItemId]         = useState<string | null>(null)
  const [savedCost,      setSavedCost]      = useState<number>(0)

  // Inline cost-edit state (post-save)
  const [costOpen,       setCostOpen]       = useState(false)
  const [costDraft,      setCostDraft]      = useState('')
  const [costSaving,     setCostSaving]     = useState(false)
  const costInputRef = useRef<HTMLInputElement>(null)

  // ── Check if already tracked ──────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/inventory')
      .then(r => r.json())
      .then(d => {
        const found = (d.items ?? []).find((i: any) => i.catalog_id === catalogId)
        if (found) {
          setItemId(found.item_id)
          setSavedCost(found.acquisition_cost ?? 0)
          setPhase('done')
        } else {
          setPhase('idle')
        }
      })
      .catch(() => setPhase('idle'))
  }, [catalogId])

  // ── One-click save ────────────────────────────────────────────────────────
  const handleAdd = async () => {
    setPhase('saving')
    try {
      const res = await fetch('/api/inventory', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ catalogId, analysisId: null, acquisitionCost: 0 }),
      })
      if (!res.ok) throw new Error()
      const item = await res.json()
      setItemId(item.item_id)
      setSavedCost(0)
      setPhase('done')
    } catch {
      setPhase('error')
      setTimeout(() => setPhase('idle'), 3000)
    }
  }

  // ── Update cost after save ────────────────────────────────────────────────
  const handleCostSave = async () => {
    if (!itemId) return
    const n = parseFloat(costDraft)
    if (isNaN(n) || n < 0) { setCostOpen(false); return }
    setCostSaving(true)
    try {
      await fetch(`/api/inventory/${itemId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ acquisitionCost: n }),
      })
      setSavedCost(n)
    } catch {}
    setCostSaving(false)
    setCostOpen(false)
  }

  const openCostEdit = () => {
    setCostDraft(savedCost > 0 ? savedCost.toFixed(2) : tcgPrice?.toFixed(2) ?? '')
    setCostOpen(true)
    setTimeout(() => costInputRef.current?.select(), 0)
  }

  // ── States ────────────────────────────────────────────────────────────────

  if (phase === 'checking') {
    return <div className="h-10 w-full rounded-xl bg-white/[0.03] animate-pulse" />
  }

  if (phase === 'error') {
    return (
      <div className="flex items-center gap-2 w-full rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-2.5 text-sm text-red-400">
        <X className="h-4 w-4 shrink-0" />
        Couldn&apos;t save — please try again
      </div>
    )
  }

  if (phase === 'idle') {
    return (
      <button
        onClick={handleAdd}
        className="flex items-center justify-center gap-2 w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-white/20 hover:bg-white/[0.06] transition-all"
      >
        <Archive className="h-4 w-4 shrink-0" />
        Add to inventory
      </button>
    )
  }

  if (phase === 'saving') {
    return (
      <div className="flex items-center justify-center gap-2 w-full rounded-xl border border-white/8 bg-white/[0.025] px-4 py-2.5 text-sm text-muted-foreground/50">
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        Adding…
      </div>
    )
  }

  // ── done: in inventory ────────────────────────────────────────────────────
  return (
    <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] overflow-hidden">

      {/* Main row: In inventory link */}
      <Link
        href={itemId ? `/inventory/${itemId}` : '/inventory'}
        className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-emerald-400/[0.04] transition-colors group"
      >
        <Check className="h-4 w-4 text-emerald-400 shrink-0" />
        <span className="text-sm font-medium text-emerald-300 flex-1">In your inventory</span>
        <ArrowRight className="h-3.5 w-3.5 text-emerald-400/30 group-hover:text-emerald-400/60 transition-colors" />
      </Link>

      {/* Cost row */}
      <div className="border-t border-emerald-400/10 px-4 py-2">
        {costOpen ? (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground/40 shrink-0">Cost $</span>
            <input
              ref={costInputRef}
              type="number" min="0" step="0.01"
              value={costDraft}
              onChange={e => setCostDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCostSave(); if (e.key === 'Escape') setCostOpen(false) }}
              onBlur={handleCostSave}
              className="flex-1 bg-transparent text-sm tabular-nums text-white/80 outline-none border-b border-white/15 focus:border-indigo-400/40 py-0.5 transition-colors min-w-0"
              placeholder={tcgPrice?.toFixed(2) ?? '0.00'}
            />
            {costSaving
              ? <Loader2 className="h-3.5 w-3.5 animate-spin text-white/30 shrink-0" />
              : <button onClick={handleCostSave}><Check className="h-3.5 w-3.5 text-emerald-400/70" /></button>}
            <button onClick={() => setCostOpen(false)}>
              <X className="h-3 w-3 text-white/20 hover:text-white/50 transition-colors" />
            </button>
          </div>
        ) : (
          <button
            onClick={openCostEdit}
            className="flex items-center gap-1.5 w-full text-left group"
          >
            <span className="text-[10px] text-muted-foreground/30 group-hover:text-muted-foreground/50 transition-colors">
              {savedCost > 0
                ? `Acquired for $${savedCost.toFixed(2)}`
                : 'Set acquisition cost (optional)'}
            </span>
            <Pencil className="h-2.5 w-2.5 text-muted-foreground/15 group-hover:text-muted-foreground/40 transition-colors ml-auto" />
            {savedCost > 0 && tcgPrice != null && (
              <span className={`text-[10px] font-medium tabular-nums ${tcgPrice >= savedCost ? 'text-emerald-400/50' : 'text-red-400/50'}`}>
                {tcgPrice >= savedCost ? '+' : ''}{((tcgPrice - savedCost) / savedCost * 100).toFixed(0)}%
              </span>
            )}
          </button>
        )}
      </div>
    </div>
  )
}
