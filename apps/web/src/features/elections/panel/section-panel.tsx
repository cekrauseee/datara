import { LinkIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'

import type { AreaResult } from '../api-types'
import { printedSum, printedTotals, undetermined, unresolvedNote } from '../depth'
import type { ElectionPatch } from '../election-location'
import { formatInteger, formatPercent, MISSING, ratio } from '../format'
import { usePrincipalCode } from '../use-area-list'

/** A section's result: ballot-box report (BU) or a section counted with another one. */
export function isSectionResult(result: AreaResult): boolean {
  return result.area.level === 'section'
}

/**
 * Notes above a section's candidates: the aggregated-section band linking to the principal
 * (code from the zone's section list, never from the ID), the unresolved votables and the
 * undetermined leader. The breadcrumb and the URL stay on the aggregated section.
 */
export function SectionNotes({
  result,
  onPatch,
}: {
  result: AreaResult
  onPatch: (patch: ElectionPatch) => void
}) {
  const note = unresolvedNote(result.unresolvedVotables)
  const unknown = result.state !== 'unavailable' && undetermined(result)
  return (
    <>
      {result.state === 'shared' && (
        <SharedBand
          key={result.resultAreaId}
          zoneId={result.area.parentId}
          principalAreaId={result.resultAreaId}
          onPatch={onPatch}
        />
      )}
      {note && (
        <p className="rounded-md bg-muted/60 px-3 py-2 text-muted-foreground" data-unresolved="">
          {note}
        </p>
      )}
      {unknown && (
        <p className="text-muted-foreground" data-undetermined="">
          Mais votado indeterminado: votos impressos para votáveis sem candidatura verificada podem
          mudar a ordem.
        </p>
      )}
    </>
  )
}

function SharedBand({
  zoneId,
  principalAreaId,
  onPatch,
}: {
  zoneId: string | null
  principalAreaId: string
  onPatch: (patch: ElectionPatch) => void
}) {
  const principal = usePrincipalCode(zoneId, principalAreaId)
  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-border bg-muted/40 px-3 py-2"
      data-shared-section={principalAreaId}
    >
      <p className="font-medium">
        {principal.code
          ? `Votos contados junto com a Seção ${principal.code}`
          : 'Votos contados junto com outra seção'}
      </p>
      <p className="text-muted-foreground">
        Seção agregada: os totais e candidatos abaixo são os da seção principal.
      </p>
      {principal.code && (
        <div>
          <Button
            variant="link"
            size="sm"
            className="h-auto gap-1 p-0"
            onClick={() => onPatch({ section: principal.code })}
            data-principal-link={principal.code}
          >
            <LinkIcon aria-hidden="true" />
            Ver a Seção {principal.code}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Printed totals of a ballot-box report: nominal, legend, blank, null and "no candidate" summing
 * to `totalVotes`; `validVotes` does not exist in a BU.
 */
export function SectionTotals({ result }: { result: AreaResult }) {
  const totals = result.totals
  if (!totals) return null
  const entries = printedTotals(totals)
  const sum = printedSum(entries)
  const turnoutShare = result.summary?.turnout.value ?? ratio(totals.turnout, totals.eligible)
  return (
    <section className="flex flex-col gap-2" aria-label="Totais impressos" data-section-totals="">
      <h3 className="text-sm font-medium">Totais impressos no boletim</h3>
      <dl className="flex flex-col gap-1 tabular-nums">
        <Row label="Eleitorado" value={formatInteger(totals.eligible)} />
        <Row
          label="Comparecimento"
          value={formatInteger(totals.turnout)}
          detail={turnoutShare === null ? null : `${formatPercent(turnoutShare)} do eleitorado`}
        />
        <Row label="Abstenção" value={formatInteger(totals.abstentions)} />
        {entries.map((entry) => (
          <Row
            key={entry.label}
            label={entry.label}
            value={entry.value === null ? MISSING : formatInteger(entry.value)}
            detail={entry.note ?? null}
            missing={entry.value === null}
          />
        ))}
        <Row label="Total de votos" value={formatInteger(totals.totalVotes)} />
        <Row label="Válidos" value={MISSING} detail="indisponível no BU" missing />
      </dl>
      {sum !== null && totals.totalVotes !== null && sum !== totals.totalVotes && (
        <p className="text-muted-foreground" data-printed-mismatch="">
          A soma dos tipos ({formatInteger(sum)}) difere do total impresso.
        </p>
      )}
    </section>
  )
}

function Row({
  label,
  value,
  detail = null,
  missing = false,
}: {
  label: string
  value: string
  detail?: string | null
  missing?: boolean
}) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right" data-total-missing={missing ? '' : undefined}>
        {value}
        {detail && <span className="text-muted-foreground"> · {detail}</span>}
      </dd>
    </div>
  )
}
