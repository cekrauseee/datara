import type { AreaResult } from '../api-types'
import { formatInteger, formatPercent, MISSING, ratio, sourceKindLabel } from '../format'

type Entry = { label: string; value: number | null; detail?: string | null }

/**
 * Totals of the result as a definition list; a `null` total is "not reported by the source",
 * never zero. The Senate note explains the doubled `totalVotes`.
 */
export function TotalsBlock({
  result,
  seats,
}: {
  result: Pick<AreaResult, 'totals' | 'summary' | 'provenance'>
  seats: number | null
}) {
  const totals = result.totals
  if (!totals) return null
  const turnoutShare = result.summary?.turnout.value ?? ratio(totals.turnout, totals.eligible)
  const abstentionShare = ratio(totals.abstentions, totals.eligible)
  const missingTitle = `não informado pela fonte (${sourceKindLabel(result.provenance?.sourceKind)})`
  const entries: Entry[] = [
    { label: 'Eleitorado', value: totals.eligible },
    {
      label: 'Comparecimento',
      value: totals.turnout,
      detail: turnoutShare === null ? null : `${formatPercent(turnoutShare)} do eleitorado`,
    },
    {
      label: 'Abstenção',
      value: totals.abstentions,
      detail: abstentionShare === null ? null : `${formatPercent(abstentionShare)} do eleitorado`,
    },
    { label: 'Válidos', value: totals.validVotes },
    { label: 'Nominais', value: totals.nominalVotes },
    { label: 'Legenda', value: totals.legendVotes },
    { label: 'Brancos', value: totals.blankVotes },
    { label: 'Nulos', value: totals.nullVotes },
    { label: 'Sem candidato', value: totals.noCandidateVotes },
  ]
  return (
    <section className="flex flex-col gap-2" aria-label="Totais" data-totals="">
      <h3 className="text-sm font-medium">Totais</h3>
      <dl className="flex flex-col gap-1 tabular-nums">
        {entries.map((entry) => (
          <div key={entry.label} className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{entry.label}</dt>
            <dd className="text-right">
              {entry.value === null ? (
                <span title={missingTitle} data-total-missing="">
                  {MISSING}
                </span>
              ) : (
                formatInteger(entry.value)
              )}
              {entry.value !== null && entry.detail && (
                <span className="text-muted-foreground"> · {entry.detail}</span>
              )}
            </dd>
          </div>
        ))}
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Seções</dt>
          <dd className="text-right">
            {totals.sectionsCounted === null && totals.sectionsTotal === null ? (
              <span title={missingTitle} data-total-missing="">
                {MISSING}
              </span>
            ) : (
              `${formatInteger(totals.sectionsCounted)} de ${formatInteger(totals.sectionsTotal)}`
            )}
          </dd>
        </div>
      </dl>
      {seats === 2 && (
        <p className="text-muted-foreground">
          Cada eleitor vota em dois nomes; o total de votos soma dois por eleitor.
        </p>
      )}
      <p className="text-muted-foreground">Um traço (—) indica dado não informado pela fonte.</p>
    </section>
  )
}
