import type { LayerColor } from '../map/map-layer'
import type { MapMetric } from './api-types'

const integer = new Intl.NumberFormat('pt-BR')
const decimal = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})
const fine = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const formatCount = (value: number) => integer.format(value)
export const formatPoints = (value: number) => `${decimal.format(value)} p.p.`
export const formatPercent = (value: number) =>
  `${(Math.abs(value) < 1 ? fine : decimal).format(value)} %`
export const formatVotes = (value: number) =>
  `${integer.format(value)} ${value === 1 ? 'voto' : 'votos'}`

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
