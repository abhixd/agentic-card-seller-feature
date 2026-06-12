'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Plus, X, Check } from 'lucide-react'

interface AddToInventoryButtonProps {
  catalogId: string
  cardName: string
  price?: number | null
}

type ButtonState = 'idle' | 'open' | 'loading' | 'success' | 'error'

export function AddToInventoryButton({ catalogId, cardName, price }: AddToInventoryButtonProps) {
  const [state, setState] = useState<ButtonState>('idle')
  const [acquisitionCost, setAcquisitionCost] = useState<string>(
    price != null ? price.toFixed(2) : ''
  )
  const [notes, setNotes] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [showTooltip, setShowTooltip] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Close popover when clicking outside
  useEffect(() => {
    if (state !== 'open') return
    function handleClick(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setState('idle')
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [state])

  const openPopover = useCallback(() => {
    setAcquisitionCost(price != null ? price.toFixed(2) : '')
    setNotes('')
    setErrorMsg(null)
    setState('open')
    setShowTooltip(false)
  }, [price])

  const closePopover = useCallback(() => {
    setState('idle')
    setErrorMsg(null)
  }, [])

  const handleSubmit = useCallback(async () => {
    setState('loading')
    setErrorMsg(null)

    const costVal = acquisitionCost.trim() === '' ? null : parseFloat(acquisitionCost)
    const notesVal = notes.trim() === '' ? null : notes.trim()

    try {
      const res = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          catalogId,
          acquisitionCost: costVal,
          notes: notesVal,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? 'Failed to add to inventory')
      }
      setState('success')
      setTimeout(() => setState('idle'), 2000)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong')
      setState('error')
    }
  }, [acquisitionCost, notes, catalogId])

  // Trigger button appearance
  const isSuccess = state === 'success'
  const isOpen = state === 'open' || state === 'loading' || state === 'error'

  return (
    <div className="relative">
      {/* Trigger button */}
      <div className="relative inline-block">
        <button
          ref={triggerRef}
          onClick={isOpen ? closePopover : openPopover}
          onMouseEnter={() => !isOpen && setState !== undefined && setShowTooltip(true)}
          onMouseLeave={() => setShowTooltip(false)}
          aria-label="Add to inventory"
          className={[
            'relative flex items-center justify-center w-7 h-7 rounded-full border transition-all duration-150',
            isSuccess
              ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
              : isOpen
              ? 'bg-white/10 border-white/20 text-white'
              : 'bg-white/5 hover:bg-white/10 border-white/10 text-muted-foreground hover:text-foreground',
          ].join(' ')}
        >
          {isSuccess ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
        </button>

        {/* Tooltip */}
        {showTooltip && !isOpen && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 rounded-md bg-black/90 border border-white/10 text-xs text-white whitespace-nowrap pointer-events-none z-50">
            Add to inventory
          </div>
        )}
      </div>

      {/* Popover */}
      {isOpen && (
        <div
          ref={popoverRef}
          className="absolute right-0 bottom-full mb-2 w-64 rounded-xl bg-black/90 backdrop-blur-md border border-white/10 shadow-2xl z-50 p-3 space-y-2.5"
          style={{ minWidth: '240px' }}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-medium text-white leading-snug line-clamp-2 flex-1">
              {cardName}
            </p>
            <button
              onClick={closePopover}
              className="shrink-0 text-white/40 hover:text-white/80 transition-colors"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Acquisition cost */}
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider text-white/50 font-medium">
              Acquisition Cost
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={acquisitionCost}
              onChange={(e) => setAcquisitionCost(e.target.value)}
              placeholder="$0.00"
              className="w-full rounded-lg bg-white/5 border border-white/10 text-white text-sm px-2.5 py-1.5 placeholder:text-white/20 focus:outline-none focus:border-white/25 focus:bg-white/8 transition-colors"
            />
          </div>

          {/* Notes */}
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider text-white/50 font-medium">
              Notes
            </label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. bought at local shop"
              className="w-full rounded-lg bg-white/5 border border-white/10 text-white text-sm px-2.5 py-1.5 placeholder:text-white/20 focus:outline-none focus:border-white/25 focus:bg-white/8 transition-colors"
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            />
          </div>

          {/* Error */}
          {state === 'error' && errorMsg && (
            <p className="text-xs text-red-400">{errorMsg}</p>
          )}

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={state === 'loading'}
            className="w-full rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 text-white text-xs font-medium py-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {state === 'loading' ? 'Adding…' : 'Add to Inventory'}
          </button>
        </div>
      )}
    </div>
  )
}
