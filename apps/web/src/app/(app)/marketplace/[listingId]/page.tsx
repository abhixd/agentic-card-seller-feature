'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, Star, Flame, TrendingUp, TrendingDown, CheckCircle,
  XCircle, Loader2, MessageSquare, ArrowLeftRight, ChevronDown,
  ChevronUp,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CatalogItem {
  catalog_id:          string
  card_name:           string
  set_name:            string
  card_number:         string | null
  canonical_image_url: string | null
  metadata_json:       Record<string, unknown>
}

interface Listing {
  id:              number
  seller_id:       string
  catalog_id:      string
  title:           string
  condition:       string
  grade:           string | null
  asking_price:    number
  ai_market_price: number | null
  price_delta_pct: number | null
  description:     string | null
  image_urls:      string[]
  accepts_trades:  boolean
  status:          string
  created_at:      string
  seller_username: string
  card_catalog_items: CatalogItem
}

interface Offer {
  id:            number
  listing_id:    number
  buyer_id:      string
  offer_price:   number
  message:       string | null
  status:        string
  counter_price: number | null
  created_at:    string
  buyer_username: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUsd(n: number) {
  return n >= 1000 ? `$${(n / 1000).toFixed(2)}k` : `$${n.toFixed(2)}`
}

function conditionColor(condition: string) {
  if (condition === 'NM') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25'
  if (condition === 'LP') return 'bg-yellow-500/15 text-yellow-400 border-yellow-500/25'
  if (condition === 'MP') return 'bg-orange-500/15 text-orange-400 border-orange-500/25'
  if (condition === 'HP' || condition === 'D') return 'bg-red-500/15 text-red-400 border-red-500/25'
  return 'bg-blue-500/15 text-blue-400 border-blue-500/25'
}

function statusColor(status: string) {
  if (status === 'accepted') return 'text-emerald-400'
  if (status === 'rejected') return 'text-red-400'
  if (status === 'countered') return 'text-yellow-400'
  if (status === 'withdrawn') return 'text-white/30'
  return 'text-white/60'
}

// ── Offer Form ────────────────────────────────────────────────────────────────

function OfferForm({ listing, onOffered }: { listing: Listing; onOffered: () => void }) {
  const [offerPrice, setOfferPrice] = useState('')
  const [message,    setMessage]    = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState('')
  const [success,    setSuccess]    = useState(false)

  const market = listing.ai_market_price

  const quickAmounts = market
    ? [
        { label: `Market (${fmtUsd(market)})`,    value: market },
        { label: `10% off (${fmtUsd(market * 0.9)})`, value: Math.round(market * 0.9 * 100) / 100 },
        { label: `20% off (${fmtUsd(market * 0.8)})`, value: Math.round(market * 0.8 * 100) / 100 },
      ]
    : []

  const offerNum = parseFloat(offerPrice)
  const deltaVsMarket = market && offerNum > 0
    ? ((offerNum - market) / market) * 100
    : null

  const handleSubmit = async () => {
    if (!offerNum || offerNum <= 0) { setError('Enter a valid offer price'); return }
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch(`/api/marketplace/listings/${listing.id}/offers`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ offer_price: offerNum, message: message || undefined }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Failed to send offer'); return }
      setSuccess(true)
      onOffered()
    } finally {
      setSubmitting(false)
    }
  }

  if (success) {
    return (
      <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/8 p-4 text-center space-y-1">
        <CheckCircle className="h-5 w-5 text-emerald-400 mx-auto" />
        <p className="text-sm font-semibold text-emerald-300">Offer sent!</p>
        <p className="text-xs text-emerald-400/60">The seller will respond shortly.</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-4">
      <p className="text-xs font-semibold text-white/50 uppercase tracking-widest">Make an Offer</p>

      {/* Quick-tap amounts */}
      {quickAmounts.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {quickAmounts.map(qa => (
            <button
              key={qa.label}
              onClick={() => setOfferPrice(String(qa.value))}
              className={`rounded-lg border py-1.5 px-2 text-[10px] font-semibold text-center transition-all ${
                offerNum === qa.value
                  ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-300'
                  : 'border-white/8 bg-white/[0.03] text-white/40 hover:text-white/60 hover:border-white/15'
              }`}
            >
              {qa.label}
            </button>
          ))}
        </div>
      )}

      {/* Price input */}
      <div className="space-y-1">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30">$</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={offerPrice}
            onChange={e => setOfferPrice(e.target.value)}
            placeholder="0.00"
            className="w-full rounded-xl border border-white/10 bg-white/[0.04] pl-7 pr-4 py-2.5 text-sm text-white/80 placeholder:text-white/25 focus:outline-none focus:border-white/20 transition-all"
          />
        </div>

        {/* Live delta hint */}
        {deltaVsMarket !== null && (
          <p className={`text-[11px] font-medium ${
            Math.abs(deltaVsMarket) <= 5 ? 'text-emerald-400' :
            deltaVsMarket > 20 ? 'text-red-400' :
            deltaVsMarket > 0 ? 'text-yellow-400' : 'text-emerald-400'
          }`}>
            {deltaVsMarket > 0
              ? `+${deltaVsMarket.toFixed(1)}% above market`
              : `${Math.abs(deltaVsMarket).toFixed(1)}% below market`
            }
            {market && ` · Market: ${fmtUsd(market)}`}
          </p>
        )}
        {market && !offerPrice && (
          <p className="text-[11px] text-white/25">Market price: {fmtUsd(market)}</p>
        )}
      </div>

      {/* Message */}
      <textarea
        value={message}
        onChange={e => setMessage(e.target.value)}
        placeholder="Optional message to seller…"
        rows={2}
        className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/70 placeholder:text-white/25 focus:outline-none focus:border-white/20 resize-none transition-all"
      />

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="flex items-center justify-center gap-2 w-full rounded-xl py-2.5 text-sm font-semibold text-white disabled:opacity-50 transition-all btn-primary-glow"
        style={{ background: 'linear-gradient(135deg, #6366f1, #4338ca)' }}
      >
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
        {submitting ? 'Sending…' : 'Send Offer'}
      </button>
    </div>
  )
}

// ── Seller Offers Panel ───────────────────────────────────────────────────────

function SellerOffersPanel({ listingId }: { listingId: number }) {
  const [offers,   setOffers]   = useState<Offer[]>([])
  const [loading,  setLoading]  = useState(true)
  const [acting,   setActing]   = useState<number | null>(null)
  const [counterInputs, setCounterInputs] = useState<Record<number, string>>({})
  const [showCounter,   setShowCounter]   = useState<number | null>(null)

  const loadOffers = async () => {
    const res  = await fetch(`/api/marketplace/listings/${listingId}/offers`)
    const data = await res.json()
    setOffers(data.offers ?? [])
    setLoading(false)
  }

  useEffect(() => { loadOffers() }, [listingId])

  const act = async (offerId: number, status: string, counterPrice?: number) => {
    setActing(offerId)
    await fetch(`/api/marketplace/listings/${listingId}/offers/${offerId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status, counter_price: counterPrice }),
    })
    setActing(null)
    setShowCounter(null)
    loadOffers()
  }

  if (loading) return <div className="h-8 bg-white/[0.03] rounded-xl animate-pulse" />

  if (offers.length === 0) {
    return (
      <p className="text-xs text-white/25 text-center py-4">No offers yet.</p>
    )
  }

  return (
    <div className="space-y-2">
      {offers.map(offer => (
        <div key={offer.id} className="rounded-xl border border-white/8 bg-white/[0.02] p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold tabular-nums text-white/85">{fmtUsd(offer.offer_price)}</p>
              <p className="text-[10px] text-white/30">{offer.buyer_username}</p>
            </div>
            <span className={`text-[10px] font-semibold capitalize ${statusColor(offer.status)}`}>
              {offer.status}
            </span>
          </div>

          {offer.message && (
            <p className="text-xs text-white/40 italic">&quot;{offer.message}&quot;</p>
          )}
          {offer.counter_price && (
            <p className="text-xs text-yellow-400/80">Counter: {fmtUsd(offer.counter_price)}</p>
          )}

          {offer.status === 'pending' && (
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => act(offer.id, 'accepted')}
                disabled={acting === offer.id}
                className="flex items-center gap-1 px-3 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-xs font-semibold hover:bg-emerald-500/25 transition-colors disabled:opacity-50"
              >
                <CheckCircle className="h-3 w-3" />
                Accept
              </button>
              <button
                onClick={() => act(offer.id, 'rejected')}
                disabled={acting === offer.id}
                className="flex items-center gap-1 px-3 py-1 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-semibold hover:bg-red-500/20 transition-colors disabled:opacity-50"
              >
                <XCircle className="h-3 w-3" />
                Reject
              </button>
              <button
                onClick={() => setShowCounter(showCounter === offer.id ? null : offer.id)}
                disabled={acting === offer.id}
                className="flex items-center gap-1 px-3 py-1 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-xs font-semibold hover:bg-yellow-500/20 transition-colors"
              >
                {showCounter === offer.id ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                Counter
              </button>
            </div>
          )}

          {showCounter === offer.id && (
            <div className="flex items-center gap-2 pt-1">
              <div className="relative flex-1">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30 text-xs">$</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={counterInputs[offer.id] ?? ''}
                  onChange={e => setCounterInputs(prev => ({ ...prev, [offer.id]: e.target.value }))}
                  placeholder="Counter price"
                  className="w-full rounded-lg border border-white/10 bg-white/[0.04] pl-6 pr-3 py-1.5 text-xs text-white/70 placeholder:text-white/25 focus:outline-none"
                />
              </div>
              <button
                onClick={() => {
                  const cp = parseFloat(counterInputs[offer.id] ?? '')
                  if (cp > 0) act(offer.id, 'countered', cp)
                }}
                disabled={acting === offer.id}
                className="px-3 py-1.5 rounded-lg bg-yellow-500/15 border border-yellow-500/25 text-yellow-400 text-xs font-semibold hover:bg-yellow-500/25 transition-colors disabled:opacity-50"
              >
                Send
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ListingDetailPage({ params }: { params: Promise<{ listingId: string }> }) {
  const { listingId } = use(params)
  const router = useRouter()

  const [listing,    setListing]    = useState<Listing | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [isWanted,   setIsWanted]   = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [offersRefresh, setOffersRefresh] = useState(0)

  useEffect(() => {
    fetch(`/api/marketplace/listings/${listingId}`)
      .then(r => (r.ok ? r.json() : null))
      // guard: a 404/500 or shapeless payload falls through to "Listing not found."
      .then(data => { setListing(data && data.id ? data : null); setLoading(false) })
      .catch(() => setLoading(false))

    // Get current user
    fetch('/api/profile/me').then(r => r.json()).then(d => setCurrentUserId(d?.id ?? null)).catch(() => {})
  }, [listingId])

  useEffect(() => {
    if (!listing) return
    fetch('/api/wantlist')
      .then(r => r.json())
      .then(d => {
        const ids = new Set((d.items ?? []).map((i: { card_catalog_items: { catalog_id: string } }) => i.card_catalog_items.catalog_id))
        setIsWanted(ids.has(listing.catalog_id))
      })
      .catch(() => {})
  }, [listing])

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto space-y-4 pb-12">
        <div className="h-6 w-24 bg-white/[0.04] rounded-lg animate-pulse" />
        <div className="grid md:grid-cols-2 gap-6">
          <div className="aspect-[3/4] bg-white/[0.03] rounded-2xl animate-pulse" />
          <div className="space-y-4">
            <div className="h-8 bg-white/[0.04] rounded-xl animate-pulse" />
            <div className="h-16 bg-white/[0.03] rounded-xl animate-pulse" />
            <div className="h-32 bg-white/[0.03] rounded-xl animate-pulse" />
          </div>
        </div>
      </div>
    )
  }

  if (!listing) {
    return (
      <div className="max-w-4xl mx-auto text-center py-20">
        <p className="text-white/40">Listing not found.</p>
        <Link href="/marketplace" className="text-indigo-400 text-sm mt-3 inline-block">Back to Marketplace</Link>
      </div>
    )
  }

  const card       = listing.card_catalog_items
  const delta      = listing.price_delta_pct
  const market     = listing.ai_market_price
  const imgSrc     = listing.image_urls?.[0] ?? card?.canonical_image_url ?? null
  const isSeller   = currentUserId === listing.seller_id
  const isDeal     = delta !== null && delta < -5
  const isHot      = delta !== null && delta < -20
  const isHigh     = delta !== null && delta > 20

  const meta = card.metadata_json as Record<string, unknown>
  const rarity = (meta?.rarity as string) ?? null
  const year   = (meta?.year   as string | number) ?? null

  return (
    <div className="max-w-4xl mx-auto space-y-5 pb-12">

      {/* Back */}
      <Link href="/marketplace" className="inline-flex items-center gap-1.5 text-white/30 hover:text-white/60 text-sm transition-colors">
        <ArrowLeft className="h-4 w-4" />
        Marketplace
      </Link>

      <div className="grid md:grid-cols-2 gap-6">

        {/* Left: Card image */}
        <div className="space-y-3">
          <div className="relative rounded-2xl border border-white/8 bg-white/[0.02] overflow-hidden aspect-[3/4]">
            {imgSrc ? (
              <Image src={imgSrc} alt={card.card_name} fill className="object-contain p-4" unoptimized />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <div
                  style={{
                    width: 120, height: 168, borderRadius: 12,
                    background: 'radial-gradient(circle at 30% 30%, #6366f1 0%, #4f46e5 40%, #2e1065 100%)',
                    border: '1px solid rgba(99,102,241,0.35)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <span style={{ fontSize: 48, fontWeight: 700, color: 'rgba(255,255,255,0.9)' }}>
                    {card.card_name.charAt(0)}
                  </span>
                </div>
              </div>
            )}

            {isHot && (
              <div className="absolute top-3 left-3 flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-bold">
                <Flame className="h-3.5 w-3.5" />
                HOT DEAL
              </div>
            )}
          </div>

          {/* Card details */}
          <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3 space-y-1.5">
            <p className="text-[10px] uppercase tracking-widest text-white/25 font-semibold">Card Details</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-white/30">Set</span>
              <span className="text-white/70 text-right">{card.set_name}</span>
              {card.card_number && <>
                <span className="text-white/30">Number</span>
                <span className="text-white/70 text-right">#{card.card_number}</span>
              </>}
              {rarity && <>
                <span className="text-white/30">Rarity</span>
                <span className="text-white/70 text-right">{rarity}</span>
              </>}
              {year && <>
                <span className="text-white/30">Year</span>
                <span className="text-white/70 text-right">{year}</span>
              </>}
            </div>
          </div>
        </div>

        {/* Right: Listing info + offer form */}
        <div className="space-y-4">

          {/* Title + badges */}
          <div className="space-y-2">
            <div className="flex items-start gap-2 flex-wrap">
              <h1 className="text-xl font-bold tracking-tight text-white/90 flex-1">{card.card_name}</h1>
              {isWanted && (
                <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-rose-500/15 border border-rose-500/25 text-rose-300 text-xs font-semibold shrink-0">
                  <Star className="h-3 w-3 fill-current" />
                  On your wantlist
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center px-2.5 py-1 rounded-full border text-xs font-semibold ${conditionColor(listing.condition)}`}>
                {listing.grade ?? listing.condition}
              </span>
              {listing.accepts_trades && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-indigo-500/25 bg-indigo-500/10 text-indigo-300 text-xs font-semibold">
                  <ArrowLeftRight className="h-3 w-3" />
                  Trades accepted
                </span>
              )}
            </div>
          </div>

          {/* Price block */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-2">
            <p className="text-3xl font-bold tabular-nums text-white">{fmtUsd(listing.asking_price)}</p>

            {market && (
              <div className="space-y-1">
                <p className="text-xs text-white/35">
                  TCGPlayer market: <span className="text-white/60 font-medium">{fmtUsd(market)}</span>
                </p>
                {delta !== null && (
                  <p className={`text-xs font-semibold flex items-center gap-1 ${
                    Math.abs(delta) <= 5 ? 'text-emerald-400' :
                    isDeal ? 'text-emerald-400' : isHigh ? 'text-red-400' : 'text-yellow-400'
                  }`}>
                    {isDeal
                      ? <><TrendingDown className="h-3.5 w-3.5" />{Math.abs(delta).toFixed(1)}% below market — great deal</>
                      : isHigh
                        ? <><TrendingUp className="h-3.5 w-3.5" />{delta.toFixed(1)}% above market</>
                        : <>At market price</>
                    }
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Description */}
          {listing.description && (
            <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
              <p className="text-[10px] uppercase tracking-widest text-white/25 font-semibold mb-2">Description</p>
              <p className="text-sm text-white/55 leading-relaxed">{listing.description}</p>
            </div>
          )}

          {/* Seller info */}
          <div className="flex items-center justify-between rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-white/25 font-semibold">Seller</p>
              <p className="text-sm text-white/70 font-medium">{listing.seller_username}</p>
            </div>
            <p className="text-[10px] text-white/20">
              Listed {new Date(listing.created_at).toLocaleDateString()}
            </p>
          </div>

          {/* Offer form (buyers only) or offers panel (seller) */}
          {listing.status === 'active' && !isSeller && (
            <OfferForm listing={listing} onOffered={() => setOffersRefresh(r => r + 1)} />
          )}

          {listing.status !== 'active' && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-center">
              <p className="text-sm text-white/40 font-medium capitalize">{listing.status}</p>
              <p className="text-xs text-white/20 mt-1">This listing is no longer active.</p>
            </div>
          )}

          {isSeller && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-white/50 uppercase tracking-widest">Offers Received</p>
                <Link
                  href={`/marketplace/${listing.id}/edit`}
                  className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  Edit listing
                </Link>
              </div>
              <SellerOffersPanel key={offersRefresh} listingId={listing.id} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
