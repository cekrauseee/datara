import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'

import type { ApiClientError } from '../api-client'
import { errorMessage } from './panel-model'

/** Placeholder with the heights of the ready panel: title, coverage, N rows and totals. */
export function PanelSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true" data-panel-skeleton="">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-3 w-full" />
      <ul className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-3 w-full" />
        ))}
      </div>
    </div>
  )
}

/** Error card: the selectors, the map, the search and the breadcrumb keep working around it. */
export function PanelError({ error, onRetry }: { error: ApiClientError; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"
      data-election-error={error.code}
    >
      <p className="font-medium">Resultados indisponíveis</p>
      <p className="text-muted-foreground">{errorMessage(error)}</p>
      {error.requestId && (
        <p className="text-[0.625rem] text-muted-foreground">
          Requisição <span className="font-mono">{error.requestId}</span>
        </p>
      )}
      <div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Tentar novamente
        </Button>
      </div>
    </div>
  )
}

export function PanelEmpty({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: React.ReactNode
}) {
  return (
    <Empty className="border p-4" data-panel-empty="">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children}
    </Empty>
  )
}

/** Notices of the composer (unknown area, missing office…) and of the selectors. */
export function PanelNotices({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) return null
  return (
    <ul
      className="flex list-disc flex-col gap-1 rounded-md bg-muted/60 py-2 pr-2 pl-6 text-muted-foreground"
      data-election-warnings=""
    >
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  )
}
