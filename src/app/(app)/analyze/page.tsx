'use client'

import { useState, useCallback, useEffect, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { SearchForm } from '@/components/catalog/SearchForm'
import { SearchResults, type SortKey } from '@/components/catalog/SearchResults'
import type { CardSearchResult } from '@/types/catalog'

function AnalyzePageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const initialQ = searchParams.get('q') ?? ''

  const [results, setResults]       = useState<CardSearchResult[]>([])
  const [query, setQuery]           = useState(initialQ)
  const [isLoading, setIsLoading]   = useState(!!initialQ)
  const [hasSearched, setHasSearched] = useState(!!initialQ)
  const [sortKey, setSortKey]       = useState<SortKey>('price_desc')

  const runSearch = useCallback(async (q: string) => {
    setQuery(q)
    router.replace(q ? `/analyze?q=${encodeURIComponent(q)}` : '/analyze', { scroll: false })
    if (!q) { setResults([]); setHasSearched(false); return }
    setIsLoading(true)
    setHasSearched(true)
    try {
      const res = await fetch(`/api/catalog/search?q=${encodeURIComponent(q)}`)
      if (!res.ok) throw new Error('Search failed')
      const data = await res.json()
      setResults(data.results ?? [])
    } catch { setResults([]) }
    finally { setIsLoading(false) }
  }, [router])

  // Auto-run on mount if q param present
  useEffect(() => {
    if (initialQ) runSearch(initialQ)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-5 max-w-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analyze Card</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Search for a card to see live pricing, eBay comps, and a sell / grade / hold recommendation.
        </p>
      </div>

      <SearchForm onSearch={runSearch} isLoading={isLoading} initialQuery={initialQ} />

      <SearchResults
        results={results}
        query={query}
        isLoading={isLoading}
        hasSearched={hasSearched}
        sortKey={sortKey}
        onSortChange={setSortKey}
        searchQuery={query}
      />
    </div>
  )
}

export default function AnalyzePage() {
  return (
    <Suspense fallback={<div className="h-10 animate-pulse bg-muted/40 rounded-xl max-w-2xl mx-auto" />}>
      <AnalyzePageContent />
    </Suspense>
  )
}
