import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

import type { Metric } from '../election-location'
import { navigateElection } from '../use-election-location'

const FOCUS_METRICS = [
  { value: 'votes', label: 'Votos' },
  { value: 'share', label: 'Apoio' },
  { value: 'contribution', label: 'Contribuição' },
] as const satisfies readonly { value: Metric; label: string }[]

/**
 * Map metric of the focused candidate. Support is the default with a candidate, so it writes no
 * `metric` token; votes and contribution do.
 */
export function MetricToggle({ metric }: { metric: Metric }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-muted-foreground">Métrica do mapa</p>
      <ToggleGroup
        aria-label="Métrica"
        variant="outline"
        size="sm"
        spacing={0}
        value={[metric]}
        onValueChange={(values) => {
          const next = FOCUS_METRICS.find((item) => item.value === values[0])
          if (next) navigateElection({ metric: next.value })
        }}
        data-focus-metric={metric}
      >
        {FOCUS_METRICS.map((item) => (
          <ToggleGroupItem key={item.value} value={item.value}>
            {item.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}
