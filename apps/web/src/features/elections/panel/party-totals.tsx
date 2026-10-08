import type { AreaResult } from '../api-types'
import { formatInteger, MISSING } from '../format'
import type { PartyInfo } from './panel-model'

type PartyVote = AreaResult['parties'][number]

function sum(party: PartyVote): number | null {
  if (party.nominalVotes === null && party.legendVotes === null) return null
  return (party.nominalVotes ?? 0) + (party.legendVotes ?? 0)
}

/**
 * "Votos por partido" of a proportional contest: the party label comes from the candidate rows
 * loaded so far (`parties[]` only carries the number); the rest is shown as "Partido nº N".
 */
export function PartyTotals({
  parties,
  dictionary,
}: {
  parties: readonly PartyVote[]
  dictionary: ReadonlyMap<string, PartyInfo>
}) {
  if (parties.length === 0) return null
  const rows = parties
    .map((party) => ({ party, total: sum(party) }))
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1))
  return (
    <section className="flex flex-col gap-2" aria-label="Votos por partido" data-party-totals="">
      <h3 className="text-sm font-medium">Votos por partido</h3>
      <table className="w-full text-xs tabular-nums">
        <thead className="text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 text-left font-normal">
              Partido
            </th>
            <th scope="col" className="py-1 text-right font-normal">
              Nominais
            </th>
            <th scope="col" className="py-1 text-right font-normal">
              Legenda
            </th>
            <th scope="col" className="py-1 text-right font-normal">
              Soma
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ party, total }) => (
            <tr key={party.partyNumber} className="border-t border-border/60">
              <th scope="row" className="py-1 text-left font-normal">
                {dictionary.get(party.partyNumber)?.label ?? `Partido nº ${party.partyNumber}`}
              </th>
              <td className="py-1 text-right">{formatInteger(party.nominalVotes)}</td>
              <td className="py-1 text-right">{formatInteger(party.legendVotes)}</td>
              <td className="py-1 text-right">{total === null ? MISSING : formatInteger(total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
