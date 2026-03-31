import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import type { CardCatalogItem } from '@/types/catalog'

interface CardMetaDisplayProps {
  card: CardCatalogItem
}

const CATEGORY_LABELS: Record<string, string> = {
  sports: 'Sports',
  tcg: 'Trading Card Game',
  other: 'Other',
}

export function CardMetaDisplay({ card }: CardMetaDisplayProps) {
  const meta = card.metadata_json ?? {}

  const fields: { label: string; value: string | number | null | undefined }[] = [
    { label: 'Card Name', value: card.card_name },
    { label: 'Set', value: card.set_name },
    { label: 'Brand / Franchise', value: card.franchise_or_brand },
    { label: 'Year', value: card.year },
    { label: 'Card Number', value: card.card_number },
    { label: 'Variant', value: card.variant },
    { label: 'Category', value: CATEGORY_LABELS[card.category] ?? card.category },
  ]

  // Pull relevant known metadata keys for display
  const metaFields: { label: string; value: string }[] = []
  const knownKeys: Record<string, string> = {
    rarity: 'Rarity',
    hp: 'HP',
    team: 'Team',
    position: 'Position',
    type: 'Type',
    mana_cost: 'Mana Cost',
    color: 'Color',
    note: 'Note',
  }
  for (const [key, label] of Object.entries(knownKeys)) {
    if (meta[key] != null) {
      metaFields.push({ label, value: String(meta[key]) })
    }
  }

  return (
    <div className="space-y-4" data-testid="card-meta-display">
      {card.canonical_image_url && (
        <div className="flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={card.canonical_image_url}
            alt={card.card_name}
            className="max-h-64 object-contain rounded-lg border"
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {fields.map(({ label, value }) =>
          value != null ? (
            <div key={label}>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-sm font-medium">{value}</p>
            </div>
          ) : null
        )}
      </div>

      {metaFields.length > 0 && (
        <>
          <Separator />
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {metaFields.map(({ label, value }) => (
              <div key={label}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-sm font-medium">{value}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
