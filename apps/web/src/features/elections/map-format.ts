// Map legend and tooltip labels; number formatting lives in `format.ts`.
import type { LayerColor } from '../map/map-layer'
import type { MapMetric } from './api-types'

export const METRIC_TITLES: Record<MapMetric, string> = {
  leader: 'Mais votado',
  margin: 'Vantagem',
  turnout: 'Comparecimento',
  candidateShare: 'Apoio',
  contribution: 'Contribuição',
  candidateVotes: 'Votos',
}

export const METRIC_UNITS: Record<MapMetric, string> = {
  leader: 'vantagem em p.p.',
  margin: 'p.p.',
  turnout: '%',
  candidateShare: '% dos votos da área',
  contribution: '% dos votos da candidatura',
  candidateVotes: 'votos',
}

/** The class colour composed over `--muted`, as the canvas paints it. */
export function swatchColor(color: LayerColor, alpha: number) {
  const base = typeof color === 'string' ? color : `var(--${color.token})`
  return `color-mix(in srgb, ${base} ${Math.round(alpha * 100)}%, var(--muted))`
}
