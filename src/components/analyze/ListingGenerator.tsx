'use client'

import { useState, useRef } from 'react'
import { Sparkles, Copy, Check, X, Loader2, ExternalLink } from 'lucide-react'

interface ListingGeneratorProps {
  analysisId: string
  cardName:   string
}

interface Listing {
  title:           string
  description:     string
  condition_label: string
}

export function ListingGenerator({ analysisId, cardName }: ListingGeneratorProps) {
  const [phase,   setPhase]   = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [listing, setListing] = useState<Listing | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [copied,  setCopied]  = useState<'title' | 'desc' | null>(null)

  const generate = async () => {
    setPhase('loading')
    setError(null)
    try {
      const res = await fetch('/api/listing-gen', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ analysisId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Generation failed')
      setListing(data)
      setPhase('done')
    } catch (e: any) {
      setError(e.message ?? 'Failed to generate listing')
      setPhase('error')
    }
  }

  const copyText = async (text: string, key: 'title' | 'desc') => {
    await navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  if (phase === 'idle' || phase === 'loading' || phase === 'error') {
    return (
      <div className="space-y-2">
        <button
          onClick={generate}
          disabled={phase === 'loading'}
          className="flex items-center justify-center gap-2 w-full rounded-xl border border-fuchsia-400/20 bg-fuchsia-400/[0.04] px-4 py-2.5 text-sm font-medium text-fuchsia-300 hover:bg-fuchsia-400/[0.08] hover:border-fuchsia-400/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        >
          {phase === 'loading'
            ? <><Loader2 className="h-4 w-4 animate-spin" /> Generating listing…</>
            : <><Sparkles className="h-4 w-4" /> Generate eBay Listing</>
          }
        </button>
        {phase === 'error' && error && (
          <p className="text-xs text-red-400 text-center">{error}</p>
        )}
      </div>
    )
  }

  if (!listing) return null

  return (
    <div className="rounded-xl border border-fuchsia-400/15 bg-fuchsia-400/[0.03] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-fuchsia-400/10">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-fuchsia-400/70" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-fuchsia-400/50">
            eBay Listing · AI Generated
          </span>
        </div>
        <button
          onClick={() => { setPhase('idle'); setListing(null) }}
          className="text-white/20 hover:text-white/50 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="p-4 space-y-3">
        {/* Condition */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-white/25">Condition</span>
          <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-white/60">
            {listing.condition_label}
          </span>
        </div>

        {/* Title */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-widest text-white/25">Title</span>
            <div className="flex items-center gap-2">
              <span className={`text-[10px] tabular-nums ${listing.title.length > 70 ? 'text-amber-400' : 'text-white/20'}`}>
                {listing.title.length}/80
              </span>
              <button
                onClick={() => copyText(listing.title, 'title')}
                className="flex items-center gap-1 text-[10px] text-fuchsia-400/60 hover:text-fuchsia-400 transition-colors"
              >
                {copied === 'title' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied === 'title' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
          <div className="rounded-lg border border-white/8 bg-white/[0.03] p-3 text-sm font-medium text-white/85 leading-snug">
            {listing.title}
          </div>
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-widest text-white/25">Description</span>
            <button
              onClick={() => copyText(listing.description, 'desc')}
              className="flex items-center gap-1 text-[10px] text-fuchsia-400/60 hover:text-fuchsia-400 transition-colors"
            >
              {copied === 'desc' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied === 'desc' ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div className="rounded-lg border border-white/8 bg-white/[0.03] p-3 text-xs text-white/60 leading-relaxed whitespace-pre-wrap">
            {listing.description}
          </div>
        </div>

        {/* Regenerate */}
        <button
          onClick={generate}
          className="flex items-center gap-1.5 text-[10px] text-fuchsia-400/40 hover:text-fuchsia-400/70 transition-colors"
        >
          <Sparkles className="h-3 w-3" />
          Regenerate
        </button>
      </div>
    </div>
  )
}
