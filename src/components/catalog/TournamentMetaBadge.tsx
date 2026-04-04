'use client'

import { useEffect, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TournamentAppearance {
  tournament_id:   string
  tournament_name: string
  tournament_date: string
  placement:       number | null
  deck_count:      number
  format:          string | null
}

interface TournamentMeta {
  appearances:      TournamentAppearance[]
  totalTournaments: number
  avgPlacement:     number | null
  lastSeen:         string | null
  trending:         boolean
}

interface TournamentMetaBadgeProps {
  catalogId: string
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TournamentMetaBadge({ catalogId }: TournamentMetaBadgeProps) {
  const [meta, setMeta]       = useState<TournamentMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen]       = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/cards/${catalogId}/tournament-meta`)
      .then(r => r.ok ? r.json() : null)
      .then((data: TournamentMeta | null) => {
        if (!cancelled) {
          setMeta(data)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [catalogId])

  // Don't render while loading or when there are fewer than 2 tournaments
  if (loading) return null
  if (!meta || meta.totalTournaments < 2) return null

  const badgeBase =
    'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ' +
    'cursor-pointer select-none transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1'

  const badgeColors = meta.trending
    ? 'bg-amber-100 text-amber-800 hover:bg-amber-200 focus:ring-amber-400 border border-amber-300'
    : 'bg-muted text-muted-foreground hover:bg-muted/80 focus:ring-ring border border-border'

  return (
    <div className="relative inline-block">
      {/* Badge button */}
      <button
        type="button"
        className={`${badgeBase} ${badgeColors}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(o => !o)}
        onBlur={e => {
          // Close if focus moves outside the badge + tooltip
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) {
            setOpen(false)
          }
        }}
      >
        <span aria-hidden="true">🏆</span>
        <span>Meta · {meta.totalTournaments} events</span>
      </button>

      {/* Tooltip / popover */}
      {open && (
        <div
          role="tooltip"
          className={
            'absolute z-50 left-0 top-full mt-1.5 w-64 rounded-lg border bg-popover ' +
            'p-3 shadow-md text-popover-foreground text-xs space-y-2'
          }
        >
          {/* Summary row */}
          <div className="flex items-center justify-between">
            <span className="font-semibold text-sm">Tournament Meta</span>
            {meta.trending && (
              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-amber-700 font-medium text-[10px]">
                Trending
              </span>
            )}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
            {meta.avgPlacement != null && (
              <>
                <span>Avg placement</span>
                <span className="text-foreground font-medium">#{meta.avgPlacement}</span>
              </>
            )}
            {meta.lastSeen && (
              <>
                <span>Last seen</span>
                <span className="text-foreground font-medium">{meta.lastSeen}</span>
              </>
            )}
          </div>

          {/* Recent tournaments */}
          {meta.appearances.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-foreground">Recent tournaments</p>
              <ul className="space-y-0.5">
                {meta.appearances.slice(0, 5).map(a => (
                  <li
                    key={`${a.tournament_id}-${a.placement}`}
                    className="flex items-start justify-between gap-2"
                  >
                    <span className="text-muted-foreground truncate flex-1" title={a.tournament_name}>
                      {a.tournament_name}
                    </span>
                    <span className="text-foreground font-medium shrink-0">
                      {a.placement != null ? `#${a.placement}` : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
