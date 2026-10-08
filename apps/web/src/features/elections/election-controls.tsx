import { OFFICES, isOffice } from './election-location'
import { OFFICE_NAMES } from './election-model'
import type { ElectionSnapshot } from './use-election'
import { navigateElection } from './use-election-location'

const selectClass =
  'h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50'

/**
 * Provisional collection and office controls (module 5 replaces them). Choosing the elections
 * collection writes `collection=elections&office=president`; "Geografia" clears everything.
 */
export function ElectionControls({ election }: { election: ElectionSnapshot }) {
  const { state, offices, contests } = election
  const roundLabel = `${state.round}º turno`
  const available = new Set(offices.map((entry) => entry.office))
  const options = contests
    ? OFFICES.filter((office) => available.has(office) || office === state.office)
    : OFFICES
  return (
    <div className="flex flex-wrap items-center gap-3" data-election-controls="">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Coleção</span>
        <select
          className={selectClass}
          data-election-collection=""
          value={state.collection ?? ''}
          onChange={(event) =>
            navigateElection(
              event.target.value === 'elections'
                ? { collection: 'elections', office: 'president' }
                : { collection: null },
            )
          }
        >
          <option value="">Geografia</option>
          <option value="elections">Eleições 2026 · {roundLabel}</option>
        </select>
      </label>
      {state.collection === 'elections' && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Cargo</span>
          <select
            className={selectClass}
            data-election-office=""
            value={state.office ?? ''}
            onChange={(event) =>
              navigateElection({ office: isOffice(event.target.value) ? event.target.value : null })
            }
          >
            <option value="">Sem cargo</option>
            {options.map((office) => {
              const entry = offices.find((candidate) => candidate.office === office)
              const suffix = !contests
                ? ''
                : !entry
                  ? ' (sem disputa aqui)'
                  : entry.national
                    ? ' (por UF)'
                    : ''
              return (
                <option key={office} value={office}>
                  {OFFICE_NAMES[office]}
                  {suffix}
                </option>
              )
            })}
          </select>
        </label>
      )}
    </div>
  )
}
