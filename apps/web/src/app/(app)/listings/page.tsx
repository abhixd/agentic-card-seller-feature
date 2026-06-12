'use client'

import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ExternalLink, RefreshCw, ShoppingCart,
  Eye, TrendingUp, Package, Loader2,
} from 'lucide-react'
import { toast } from 'sonner'

// ── Types ──────────────────────────────────────────────────────────────────────

interface CatalogItem {
  card_name:           string
  franchise_or_brand:  string
  set_name:            string | null
  year:                number | null
  card_number:         string | null
  canonical_image_url: string | null
}

interface EbayListing {
  listing_id:           string
  ebay_item_id:         string | null
  list_price:           number
  condition:            string
  status:               'active' | 'sold' | 'ended' | 'error'
  ebay_url:             string | null
  impressions:          number
  views:                number
  transactions:         number
  analytics_updated_at: string | null
  listed_at:            string
  inventory_items: {
    acquisition_cost:   number | null
    card_catalog_items: CatalogItem | null
  } | null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; className: string }> = {
  active: { label: 'Active',  className: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  sold:   { label: 'Sold',    className: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  ended:  { label: 'Ended',   className: 'bg-white/10 text-white/40 border-white/10' },
  error:  { label: 'Error',   className: 'bg-red-500/20 text-red-400 border-red-500/30' },
}

function fmt(n: number | null) {
  if (n === null) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({
  label, value, icon: Icon, sub, grad,
}: {
  label: string; value: string | number; icon: React.ElementType
  sub?: string; grad: [string, string]
}) {
  return (
    <div
      className="rounded-xl p-4 border border-white/[0.07]"
      style={{ background: 'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%)' }}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-white/40">{label}</p>
          <p className="text-2xl font-bold text-white mt-0.5">{value}</p>
          {sub && <p className="text-xs text-white/25 mt-0.5">{sub}</p>}
        </div>
        <div
          className="h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: `linear-gradient(135deg, ${grad[0]}22, ${grad[1]}18)`, border: `1px solid ${grad[0]}30` }}
        >
          <Icon className="h-5 w-5" style={{ color: grad[0] }} />
        </div>
      </div>
    </div>
  )
}

// ── Listing Card ──────────────────────────────────────────────────────────────

function ListingCard({ listing }: { listing: EbayListing }) {
  const cat    = listing.inventory_items?.card_catalog_items
  const meta   = STATUS_META[listing.status] ?? STATUS_META.active
  const profit = listing.inventory_items?.acquisition_cost != null
    ? listing.list_price - listing.inventory_items.acquisition_cost
    : null

  return (
    <div
      className="rounded-xl border border-white/[0.07] p-4 overflow-hidden"
      style={{ background: 'linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.015) 100%)' }}
    >
      <div className="flex gap-3">
        {cat?.canonical_image_url ? (
          <img
            src={cat.canonical_image_url}
            alt={cat.card_name}
            className="h-20 w-14 object-cover rounded-lg border border-white/10 flex-shrink-0"
          />
        ) : (
          <div className="h-20 w-14 rounded-lg border border-white/10 bg-white/5 flex items-center justify-center flex-shrink-0">
            <Package className="h-6 w-6 text-white/20" />
          </div>
        )}

        <div className="flex-1 min-w-0 space-y-2">
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold text-sm text-white truncate">{cat?.card_name ?? 'Unknown Card'}</p>
              <p className="text-xs text-white/40 truncate">
                {[cat?.franchise_or_brand, cat?.set_name, cat?.card_number ? `#${cat.card_number}` : null]
                  .filter(Boolean).join(' · ')}
              </p>
            </div>
            <Badge variant="outline" className={`shrink-0 text-xs ${meta.className}`}>
              {meta.label}
            </Badge>
          </div>

          {/* Price */}
          <div className="flex items-center gap-3 text-sm">
            <span className="font-bold text-white">{fmt(listing.list_price)}</span>
            {profit !== null && (
              <span className={`text-xs ${profit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {profit >= 0 ? '+' : ''}{fmt(profit)} margin
              </span>
            )}
          </div>

          {/* Analytics */}
          <div className="flex items-center gap-3 text-xs text-white/30">
            <span className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              {listing.views.toLocaleString()} views
            </span>
            <span className="flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              {listing.impressions.toLocaleString()} impressions
            </span>
            {listing.transactions > 0 && (
              <span className="flex items-center gap-1 text-emerald-400 font-medium">
                {listing.transactions} sold
              </span>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-white/25">Listed {fmtDate(listing.listed_at)}</span>
            {listing.ebay_url && (
              <a
                href={listing.ebay_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
              >
                <ExternalLink className="h-3 w-3" />
                View on eBay
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Section label ─────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold text-white/30 uppercase tracking-widest px-1">
      {children}
    </p>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ListingsPage() {
  const [listings,           setListings]           = useState<EbayListing[]>([])
  const [loading,            setLoading]            = useState(true)
  const [refreshing,         setRefreshing]         = useState(false)
  const [analyticsRefreshed, setAnalyticsRefreshed] = useState(false)

  const fetchListings = useCallback(async (refresh = false) => {
    try {
      const res = await fetch(`/api/ebay/listings${refresh ? '?refresh=1' : ''}`)
      if (!res.ok) {
        const err = await res.json()
        if (err.error === 'Unauthorized') { window.location.href = '/login'; return }
        throw new Error(err.error)
      }
      const data = await res.json()
      setListings(data.listings ?? [])
      if (data.analyticsRefreshed) {
        setAnalyticsRefreshed(true)
        toast.success('Analytics refreshed from eBay')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load listings')
    }
  }, [])

  useEffect(() => { fetchListings().finally(() => setLoading(false)) }, [fetchListings])

  async function handleRefresh() {
    setRefreshing(true)
    setAnalyticsRefreshed(false)
    await fetchListings(true)
    setRefreshing(false)
  }

  const active = listings.filter(l => l.status === 'active')
  const past   = listings.filter(l => l.status !== 'active')
  const totalViews       = listings.reduce((s, l) => s + l.views, 0)
  const totalImpressions = listings.reduce((s, l) => s + l.impressions, 0)

  return (
    <div
      className="min-h-screen px-4 py-6 sm:px-6 space-y-6 max-w-2xl"
      style={{ color: 'white' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, #10b981, #047857)', boxShadow: '0 2px 10px rgba(16,185,129,0.4)' }}
          >
            <ShoppingCart className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">eBay Listings</h1>
            <p className="text-xs text-white/30">Monitor your active listings and analytics</p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing || loading}
          className="gap-2 bg-white/5 hover:bg-white/10 border border-white/10 text-white/60 hover:text-white text-xs"
        >
          {refreshing
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <RefreshCw className="h-3.5 w-3.5" />
          }
          {refreshing ? 'Refreshing…' : 'Refresh Analytics'}
        </Button>
      </div>

      {/* Stats */}
      {!loading && listings.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Active"      value={active.length}                icon={ShoppingCart} grad={['#10b981','#047857']} />
          <StatCard label="Sold"        value={listings.filter(l=>l.status==='sold').length} icon={TrendingUp} grad={['#3b82f6','#1d4ed8']} />
          <StatCard
            label="Total Views"
            value={totalViews.toLocaleString()}
            icon={Eye}
            grad={['#8b5cf6','#6d28d9']}
            sub={analyticsRefreshed ? 'Last 30 days · just updated' : 'Last 30 days'}
          />
          <StatCard label="Impressions" value={totalImpressions.toLocaleString()} icon={TrendingUp} grad={['#f59e0b','#b45309']} />
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="rounded-xl border border-white/[0.07] p-4">
              <div className="flex gap-3">
                <Skeleton className="h-20 w-14 rounded-lg bg-white/5" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4 bg-white/5" />
                  <Skeleton className="h-3 w-1/2 bg-white/5" />
                  <Skeleton className="h-3 w-1/3 bg-white/5" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && listings.length === 0 && (
        <div
          className="rounded-xl border border-white/[0.07] py-14 text-center"
          style={{ background: 'linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.015) 100%)' }}
        >
          <ShoppingCart className="h-10 w-10 text-white/15 mx-auto mb-3" />
          <p className="font-medium text-white/40">No eBay listings yet</p>
          <p className="text-sm text-white/25 mt-1">
            Go to an inventory card and click <strong className="text-white/40">List on eBay</strong> to get started.
          </p>
          <Link href="/inventory">
            <Button className="mt-5 bg-white/5 hover:bg-white/10 border border-white/10 text-white/50 hover:text-white text-sm">
              Go to Inventory
            </Button>
          </Link>
        </div>
      )}

      {/* Active listings */}
      {active.length > 0 && (
        <div className="space-y-3">
          <SectionLabel>Active ({active.length})</SectionLabel>
          {active.map(l => <ListingCard key={l.listing_id} listing={l} />)}
        </div>
      )}

      {/* Past listings */}
      {past.length > 0 && (
        <div className="space-y-3">
          <SectionLabel>Past Listings</SectionLabel>
          {past.map(l => <ListingCard key={l.listing_id} listing={l} />)}
        </div>
      )}
    </div>
  )
}
