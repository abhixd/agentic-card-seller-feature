'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { ArrowLeft, Copy, CheckCheck, Tag, FileText, DollarSign } from 'lucide-react'
import type { ListingDraft } from '@/types/listing'

// ---------------------------------------------------------------------------
// Copy button — shows transient "Copied!" feedback
// ---------------------------------------------------------------------------

function CopyButton({ text, label = 'Copy', testId }: { text: string; label?: string; testId?: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCopy}
      data-testid={testId}
      className="gap-1.5 shrink-0"
    >
      {copied
        ? <><CheckCheck className="h-3.5 w-3.5 text-green-500" /> Copied!</>
        : <><Copy className="h-3.5 w-3.5" /> {label}</>
      }
    </Button>
  )
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div data-testid="draft-loading" className="space-y-4 max-w-2xl mx-auto">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ListingDraftPage() {
  const { itemId } = useParams<{ itemId: string }>()

  const [draft, setDraft]   = useState<ListingDraft | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/listing-draft?itemId=${itemId}`)
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? 'Failed to generate draft')
        }
        setDraft(await res.json())
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to generate draft')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [itemId])

  if (loading) return <LoadingSkeleton />

  if (error || !draft) {
    return (
      <div data-testid="draft-error" className="space-y-4 max-w-2xl mx-auto">
        <p className="text-sm text-destructive">{error ?? 'Draft generation failed.'}</p>
        <Link href={`/inventory/${itemId}`} className="text-sm underline text-muted-foreground hover:text-foreground">
          ← Back to item
        </Link>
      </div>
    )
  }

  // Build the full draft as a single copyable text block
  const fullDraftText = [
    `TITLE:\n${draft.title}`,
    '',
    `SUGGESTED PRICE: $${draft.suggestedPrice?.toFixed(2) ?? 'N/A'}`,
    '',
    `DESCRIPTION:\n${draft.description}`,
  ].join('\n')

  return (
    <div data-testid="listing-draft" className="space-y-4 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href={`/inventory/${itemId}`}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Back to item"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold">Listing Draft</h1>
          <p className="text-sm text-muted-foreground">{draft.card.card_name}</p>
        </div>
        <CopyButton text={fullDraftText} label="Copy all" testId="copy-all-button" />
      </div>

      {/* Suggested Price */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-primary" />
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
                  Suggested Price
                </p>
                <p
                  data-testid="suggested-price"
                  className="text-2xl font-bold tabular-nums"
                >
                  {draft.suggestedPrice !== null
                    ? `$${draft.suggestedPrice.toFixed(2)}`
                    : '—'
                  }
                </p>
              </div>
            </div>
            {draft.compRangeLow !== null && draft.compRangeHigh !== null && (
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Comp range</p>
                <p className="text-sm tabular-nums">
                  ${draft.compRangeLow.toFixed(2)} – ${draft.compRangeHigh.toFixed(2)}
                </p>
              </div>
            )}
          </div>
          {draft.netProceeds !== null && (
            <p className="text-xs text-muted-foreground mt-2">
              Est. net proceeds after fees: ${draft.netProceeds.toFixed(2)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Title */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-1.5 text-muted-foreground font-medium uppercase tracking-wide">
              <Tag className="h-3.5 w-3.5" />
              Listing Title
            </CardTitle>
            <div className="flex items-center gap-2">
              <Badge
                variant={draft.titleCharCount > 80 ? 'destructive' : 'outline'}
                className="text-xs tabular-nums"
                data-testid="title-char-count"
              >
                {draft.titleCharCount} / 80
              </Badge>
              <CopyButton text={draft.title} testId="copy-title-button" />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p
            data-testid="listing-title"
            className="text-sm font-medium leading-relaxed"
          >
            {draft.title}
          </p>
        </CardContent>
      </Card>

      {/* Description */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-1.5 text-muted-foreground font-medium uppercase tracking-wide">
              <FileText className="h-3.5 w-3.5" />
              Description
            </CardTitle>
            <CopyButton text={draft.description} testId="copy-description-button" />
          </div>
        </CardHeader>
        <CardContent>
          <pre
            data-testid="listing-description"
            className="text-xs font-mono whitespace-pre-wrap leading-relaxed bg-muted/40 rounded-lg p-3 overflow-auto max-h-96"
          >
            {draft.description}
          </pre>
        </CardContent>
      </Card>

      <Separator />

      <p className="text-xs text-muted-foreground text-center">
        This draft is generated from canonical card data and market comps.
        Review before posting — adjust pricing and condition notes as needed.
      </p>
    </div>
  )
}
