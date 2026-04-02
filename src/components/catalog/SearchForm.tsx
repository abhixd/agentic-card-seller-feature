'use client'

import { useState, useRef, useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Search, X } from 'lucide-react'

interface SearchFormProps {
  initialQuery?: string
  onSearch: (query: string) => void
  isLoading?: boolean
}

export function SearchForm({ initialQuery = '', onSearch, isLoading = false }: SearchFormProps) {
  const [query, setQuery] = useState(initialQuery)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSearch(query.trim())
  }

  function handleClear() {
    setQuery('')
    onSearch('')
    inputRef.current?.focus()
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2" role="search" aria-label="Card search">
      <div className="relative flex-1">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          ref={inputRef}
          id="card-search-input"
          type="text"
          placeholder="e.g. Charizard, Charizard 151, Pikachu Base Set…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8 pr-8"
          autoComplete="off"
          data-testid="search-input"
        />
        {query && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <Button type="submit" disabled={isLoading || query.trim().length < 2}>
        {isLoading ? 'Searching…' : 'Search'}
      </Button>
    </form>
  )
}
