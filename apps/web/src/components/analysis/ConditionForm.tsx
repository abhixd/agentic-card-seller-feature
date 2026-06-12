'use client'

import type { ConditionRatings } from '@/types/analysis'

const DIMENSIONS: {
  key: keyof Omit<ConditionRatings, 'notes'>
  label: string
  hint: string
}[] = [
  { key: 'corners_rating', label: 'Corners',   hint: 'Dings, bends, or fraying on all 4 corners' },
  { key: 'edges_rating',   label: 'Edges',     hint: 'Chipping or roughness along all 4 edges' },
  { key: 'surface_rating', label: 'Surface',   hint: 'Scratches, print lines, or staining front/back' },
  { key: 'centering_rating', label: 'Centering', hint: 'Left-right and front-back centering' },
]

const RATING_LABELS: Record<number, string> = {
  1: 'Poor',
  2: 'Fair',
  3: 'Good',
  4: 'VG',
  5: 'Mint',
}

interface Props {
  value: ConditionRatings
  onChange: (value: ConditionRatings) => void
}

export function ConditionForm({ value, onChange }: Props) {
  const total = value.corners_rating + value.edges_rating + value.surface_rating + value.centering_rating

  function setRating(key: keyof Omit<ConditionRatings, 'notes'>, n: number) {
    onChange({ ...value, [key]: n })
  }

  function setNotes(notes: string) {
    onChange({ ...value, notes: notes || undefined })
  }

  return (
    <div className="space-y-4" data-testid="condition-form">
      {DIMENSIONS.map(({ key, label, hint }) => (
        <div key={key} className="space-y-1">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium">{label}</span>
              <span className="text-xs text-muted-foreground ml-2">{hint}</span>
            </div>
            <span className="text-xs text-muted-foreground">
              {RATING_LABELS[value[key]]}
            </span>
          </div>
          <div className="flex gap-1.5" data-testid={`condition-rating-${key}`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                data-testid={`rating-${key}-${n}`}
                onClick={() => setRating(key, n)}
                className={[
                  'flex-1 py-1.5 text-sm font-medium rounded border transition-colors',
                  value[key] === n
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background border-border text-muted-foreground hover:bg-muted',
                ].join(' ')}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between text-sm pt-1">
        <span className="text-muted-foreground">Total score</span>
        <span className="font-semibold tabular-nums">{total} / 20</span>
      </div>

      <div className="space-y-1">
        <label className="text-sm text-muted-foreground" htmlFor="condition-notes">
          Notes (optional)
        </label>
        <textarea
          id="condition-notes"
          data-testid="condition-notes"
          value={value.notes ?? ''}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Any additional condition observations…"
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
    </div>
  )
}
