'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { StatusBadge } from '@/components/inventory/StatusBadge'
import { ListOnEbayButton } from '@/components/ebay/ListOnEbayButton'
import { ArrowLeft, TrendingUp, FileText, Save, ExternalLink, BarChart2, Zap } from 'lucide-react'
import type { InventoryDetail, InventoryStatus } from '@/types/inventory'

const STATUS_OPTIONS: { value: InventoryStatus; label: string }[] = [
  { value: 'owned',           label: 'Owned'       },
  { value: 'listed',          label: 'Listed'      },
  { value: 'sent_to_grading', label: 'At Grader'   },
  { value: 'sold',            label: 'Sold'        },
]

const REC_LABEL: Record<string, string> = {
  SELL_RAW:                'Sell Raw',
  GRADE:                   'Submit for Grading',
  HOLD:                    'Hold',
  INSUFFICIENT_CONFIDENCE: 'Insufficient Data',
}

const CATEGORY_COLORS: Record<string, 'default' | 'secondary' | 'outline'> = {
  sports: 'default',
  tcg:    'secondary',
  other:  'outline',
}

export default function InventoryDetailPage() {
  const { itemId } = useParams<{ itemId: string }>()

  const [item, setItem]       = useState<InventoryDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  // Editable fields
  const [status, setStatus]               = useState<InventoryStatus>('owned')
  const [notes, setNotes]                 = useState('')
  const [acquisitionCost, setAcquisitionCost] = useState('0')

  // Save state
  const [saving, setSaving]       = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // eBay connection status
  const [ebayConnected, setEbayConnected] = useState(false)
  useEffect(() => {
    fetch('/api/ebay/auth/status')
      .then(r => r.json())
      .then(d => setEbayConnected(!!d.connected))
      .catch(() => setEbayConnected(false))
  }, [])

  const loadItem = useCallback(async () => {
    try {
      const res = await fetch(`/api/inventory/${itemId}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Not found')
      }
      const data: InventoryDetail = await res.json()
      setItem(data)
      setStatus(data.status)
      setNotes(data.notes ?? '')
      setAcquisitionCost(String(data.acquisition_cost))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load item')
    } finally {
      setLoading(false)
    }
  }, [itemId])

  useEffect(() => { loadItem() }, [loadItem])

  async function handleSave() {
    setSaving(true)
    setSaveSuccess(false)
    setSaveError(null)
    try {
      const res = await fetch(`/api/inventory/${itemId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          status,
          notes:           notes || null,
          acquisitionCost: parseFloat(acquisitionCost) || 0,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Update failed')
      }
      const updated = await res.json()
      setItem((prev) => prev ? { ...prev, ...updated } : prev)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2500)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div data-testid="detail-loading" className="space-y-4 max-w-xl mx-auto">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    )
  }

  if (error || !item) {
    return (
      <div data-testid="detail-error" className="space-y-4 max-w-xl mx-auto">
        <p className="text-sm text-destructive">{error ?? 'Item not found.'}</p>
        <Link href="/inventory" className="text-sm underline text-muted-foreground hover:text-foreground">
          ← Back to inventory
        </Link>
      </div>
    )
  }

  return (
    <div data-testid="inventory-detail" className="space-y-4 max-w-xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/inventory"
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Back to inventory"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold truncate">{item.card.card_name}</h1>
            {item.card.variant && (
              <Badge variant="outline" className="text-xs shrink-0">{item.card.variant}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {item.card.franchise_or_brand} · {item.card.set_name}
            {item.card.year ? ` · ${item.card.year}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={CATEGORY_COLORS[item.card.category] ?? 'outline'} className="shrink-0">
            {item.card.category}
          </Badge>
          <StatusBadge status={item.status} />
        </div>
      </div>

      {/* View full card stats shortcut */}
      <Link href={`/analyze/${item.catalog_id}`}>
        <Card className="border-primary/20 bg-primary/5 hover:bg-primary/8 transition-colors cursor-pointer">
          <CardContent className="py-3 px-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <BarChart2 className="h-4 w-4 text-primary/70 shrink-0" />
                <span className="font-medium">View prices, chart & full card details</span>
              </div>
              <ArrowLeft className="h-4 w-4 text-muted-foreground rotate-180 shrink-0" />
            </div>
          </CardContent>
        </Card>
      </Link>

      {/* Sell Intelligence shortcut */}
      <Link href={`/inventory/${itemId}/sell`}>
        <Card className="border-emerald-400/20 bg-emerald-400/[0.04] hover:bg-emerald-400/[0.07] transition-colors cursor-pointer">
          <CardContent className="py-3 px-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <Zap className="h-4 w-4 text-emerald-400/70 shrink-0" />
                <div>
                  <span className="font-medium">Sell Intelligence</span>
                  <span className="text-xs text-muted-foreground ml-2">eBay comps · optimal price · AI listing</span>
                </div>
              </div>
              <ArrowLeft className="h-4 w-4 text-muted-foreground rotate-180 shrink-0" />
            </div>
          </CardContent>
        </Card>
      </Link>

      {/* List on eBay */}
      <div className="flex items-center justify-between">
        <ListOnEbayButton
          inventoryItemId={itemId}
          suggestedPrice={item.estimated_market_value ?? null}
          isConnected={ebayConnected}
          currentStatus={status}
        />
      </div>

      {/* Latest analysis summary */}
      {(item.recommendation_type || item.estimated_market_value != null) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground font-medium uppercase tracking-wide flex items-center gap-1.5">
              <TrendingUp className="h-3.5 w-3.5" />
              Latest Analysis
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              {item.recommendation_type && (
                <span className="text-sm font-medium">
                  {REC_LABEL[item.recommendation_type] ?? item.recommendation_type}
                </span>
              )}
              {item.estimated_market_value != null && (
                <span className="text-sm tabular-nums font-semibold">
                  Est. ${item.estimated_market_value.toFixed(2)}
                </span>
              )}
            </div>
            {item.rationale_text && (
              <p className="text-xs text-muted-foreground leading-relaxed">{item.rationale_text}</p>
            )}
            {item.analysis_id && (
              <Link
                href={`/analyze/result/${item.analysis_id}`}
                className="text-xs underline text-muted-foreground hover:text-foreground"
                data-testid="view-analysis-link"
              >
                View full analysis →
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      {/* Edit form */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-1.5">
            <FileText className="h-4 w-4" />
            Details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Status */}
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
              Status
            </label>
            <div className="flex flex-wrap gap-1.5" data-testid="status-selector">
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`status-${opt.value}`}
                  onClick={() => setStatus(opt.value)}
                  className={[
                    'px-3 py-1 text-sm rounded-md border transition-colors',
                    status === opt.value
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground border-border hover:bg-muted',
                  ].join(' ')}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Acquisition cost */}
          <div className="space-y-1.5">
            <label
              htmlFor="acquisition-cost"
              className="text-xs text-muted-foreground font-medium uppercase tracking-wide"
            >
              Acquired For
            </label>
            <div className="relative w-40">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
              <input
                id="acquisition-cost"
                data-testid="acquisition-cost-input"
                type="number"
                min="0"
                step="0.01"
                value={acquisitionCost}
                onChange={(e) => setAcquisitionCost(e.target.value)}
                className="w-full rounded-md border border-input bg-background pl-6 pr-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <label
              htmlFor="notes"
              className="text-xs text-muted-foreground font-medium uppercase tracking-wide"
            >
              Notes
            </label>
            <textarea
              id="notes"
              data-testid="notes-input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes about this card…"
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          {saveError && (
            <Alert variant="destructive" data-testid="save-error">
              <AlertDescription className="text-xs">{saveError}</AlertDescription>
            </Alert>
          )}

          <Button
            data-testid="save-changes-button"
            onClick={handleSave}
            disabled={saving}
            className="gap-2"
          >
            {saving
              ? 'Saving…'
              : saveSuccess
              ? '✓ Saved'
              : <><Save className="h-4 w-4" /> Save changes</>
            }
          </Button>
        </CardContent>
      </Card>

      {/* Create Listing Draft */}
      <Link href={`/inventory/${itemId}/listing`} data-testid="create-listing-link">
        <Card className="border-dashed hover:border-primary/40 transition-colors cursor-pointer">
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ExternalLink className="h-4 w-4 shrink-0" />
              <span>Create listing draft for this card</span>
            </div>
          </CardContent>
        </Card>
      </Link>
    </div>
  )
}
