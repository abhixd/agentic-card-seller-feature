import { Badge } from '@/components/ui/badge'
import type { InventoryStatus } from '@/types/inventory'

const STATUS_CONFIG: Record<InventoryStatus, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  owned:           { label: 'Owned',           variant: 'secondary' },
  listed:          { label: 'Listed',          variant: 'default'   },
  sent_to_grading: { label: 'At Grader',       variant: 'outline'   },
  sold:            { label: 'Sold',            variant: 'outline'   },
}

export function StatusBadge({ status }: { status: InventoryStatus }) {
  const { label, variant } = STATUS_CONFIG[status] ?? { label: status, variant: 'outline' }
  return <Badge variant={variant}>{label}</Badge>
}
