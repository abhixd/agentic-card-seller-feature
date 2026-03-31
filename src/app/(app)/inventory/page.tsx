'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/inventory/StatusBadge'
import { Archive, TrendingUp, ChevronRight } from 'lucide-react'
import type { InventoryListItem } from '@/types/inventory'

const REC_LABEL: Record<string, string> = {
  SELL_RAW:               'Sell Raw',
  GRADE:                  'Grade',
  HOLD:                   'Hold',
  INSUFFICIENT_CONFIDENCE: 'Low Confidence',
}

function EmptyState() {
  return (
    <div
      data-testid="inventory-empty"
      className="flex flex-col items-center justify-center gap-3 py-16 text-center"
    >
      <Archive className="h-10 w-10 text-muted-foreground/40" />
      <div>
        <p className="font-medium text-muted-foreground">No cards in inventory yet</p>
        <p className="text-sm text-muted-foreground mt-0.5">
          Analyze a card and save it to start tracking your collection.
        </p>
      </div>
      <Link
        href="/analyze"
        className="mt-2 text-sm font-medium underline hover:text-foreground transition-colors"
      >
        Analyze a card
      </Link>
    </div>
  )
}

export default function InventoryPage() {
  const [items, setItems]   = useState<InventoryListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/inventory')
        if (!res.ok) throw new Error('Failed to load inventory')
        const data = await res.json()
        setItems(data.items)
      } catch {
        setError('Could not load inventory.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">Inventory</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Your saved cards, analysis history, and status tracking.
        </p>
      </div>

      {loading && (
        <div data-testid="inventory-loading" className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      )}

      {!loading && error && (
        <p data-testid="inventory-error" className="text-sm text-destructive">{error}</p>
      )}

      {!loading && !error && items.length === 0 && <EmptyState />}

      {!loading && !error && items.length > 0 && (
        <div data-testid="inventory-list" className="space-y-2">
          {items.map((item) => (
            <Link key={item.item_id} href={`/inventory/${item.item_id}`}>
              <Card
                data-testid="inventory-item"
                className="hover:border-primary/40 transition-colors cursor-pointer"
              >
                <CardContent className="py-3 px-4">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-sm truncate">{item.card.card_name}</p>
                        {item.card.variant && (
                          <span className="text-xs text-muted-foreground">({item.card.variant})</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {item.card.franchise_or_brand} · {item.card.set_name}
                        {item.card.year ? ` · ${item.card.year}` : ''}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {item.estimated_market_value != null && (
                        <div className="text-right hidden sm:block">
                          <p className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
                            <TrendingUp className="h-3 w-3" />
                            Est.
                          </p>
                          <p className="text-sm font-semibold tabular-nums">
                            ${item.estimated_market_value.toFixed(2)}
                          </p>
                        </div>
                      )}
                      {item.recommendation_type && (
                        <span className="text-xs text-muted-foreground hidden md:block">
                          {REC_LABEL[item.recommendation_type] ?? item.recommendation_type}
                        </span>
                      )}
                      <StatusBadge status={item.status} />
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
