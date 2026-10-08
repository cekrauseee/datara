import { useEffect } from 'react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

import { isOffice, OFFICES, type OfficeKey } from './election-location'
import { EDITION, OFFICE_NAMES } from './election-model'
import type { ElectionSnapshot } from './use-election'
import { navigateElection } from './use-election-location'
import { useMediaQuery } from './use-media-query'

/** Short office labels for the segmented control. */
export const OFFICE_SHORT_NAMES: Record<OfficeKey, string> = {
  president: 'Presidente',
  governor: 'Governador',
  senator: 'Senador',
  'federal-deputy': 'Dep. federal',
  'state-deputy': 'Dep. estadual',
  'district-deputy': 'Dep. distrital',
  council: 'Conselho',
}

const COLLECTION_ITEMS = (year: number, round: number) => [
  { value: 'geography', label: 'Geografia' },
  { value: 'elections', label: `Eleições ${year} · ${round}º turno` },
]

/**
 * Collection selector (Geografia · Eleições) and the office control inside the collection, Brazil
 * only. The collection is derived from the URL state of module 3 (`collection` + `office`):
 * choosing "Eleições" writes `office=president`; pressing the selected office again clears the
 * office and keeps the collection open; "Geografia" clears everything. An office that the new
 * area does not contest is removed from the URL with a notice.
 */
export function CollectionSelector({
  election,
  areaName,
  onOfficeCleared,
}: {
  election: ElectionSnapshot
  /** Name of the selected geography, for the notice. */
  areaName: string
  onOfficeCleared: (message: string) => void
}) {
  const { state, offices, contests } = election
  const collection = state.collection === 'elections' ? 'elections' : 'geography'
  const year = election.edition?.year ?? EDITION.year
  const desktop = useMediaQuery('(min-width: 40rem)')
  const office = election.office

  const unavailable =
    !!contests && !!election.areaId && !!office && !election.contest && !election.national
  useEffect(() => {
    if (!unavailable || !office) return
    onOfficeCleared(`Sem disputa de ${OFFICE_NAMES[office]} em ${areaName}; cargo desmarcado.`)
    navigateElection({ office: null }, true)
  }, [unavailable, office, areaName, onOfficeCleared])

  const available = offices.map((entry) => entry.office)
  const options: OfficeKey[] = contests
    ? office && !available.includes(office)
      ? [...available, office]
      : available
    : [...OFFICES]
  const nationalOffices = new Set(
    offices.filter((entry) => entry.national).map((entry) => entry.office),
  )
  const selectOffice = (value: unknown) =>
    navigateElection({ office: isOffice(value) ? value : null })

  return (
    <div className="flex flex-wrap items-center gap-3" data-election-controls="">
      <Select
        items={COLLECTION_ITEMS(year, state.round)}
        value={collection}
        onValueChange={(value) =>
          navigateElection(
            value === 'elections'
              ? { collection: 'elections', office: 'president' }
              : { collection: null },
          )
        }
      >
        <SelectTrigger
          aria-label="Coleção"
          className="h-10 px-3 text-sm"
          data-election-collection={collection === 'elections' ? 'elections' : ''}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          {COLLECTION_ITEMS(year, state.round).map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {collection === 'elections' &&
        (desktop ? (
          <ToggleGroup
            aria-label="Cargo"
            variant="outline"
            spacing={0}
            value={office ? [office] : []}
            onValueChange={(values) => selectOffice(values[0])}
            data-election-office={office ?? ''}
          >
            {options.map((key) => (
              <ToggleGroupItem
                key={key}
                value={key}
                className="h-10 px-3"
                disabled={!contests}
                title={nationalOffices.has(key) ? `${OFFICE_NAMES[key]} por UF` : OFFICE_NAMES[key]}
              >
                {OFFICE_SHORT_NAMES[key]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : (
          <Select
            items={options.map((key) => ({ value: key, label: OFFICE_NAMES[key] }))}
            value={office}
            onValueChange={selectOffice}
            disabled={!contests}
          >
            <SelectTrigger
              aria-label="Cargo"
              className="h-10 px-3 text-sm"
              data-election-office={office ?? ''}
            >
              <SelectValue placeholder="Cargo" />
            </SelectTrigger>
            <SelectContent align="start">
              {options.map((key) => (
                <SelectItem key={key} value={key}>
                  {OFFICE_NAMES[key]}
                  {nationalOffices.has(key) ? ' · por UF' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
    </div>
  )
}
