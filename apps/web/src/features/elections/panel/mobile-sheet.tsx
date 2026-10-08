import { cn } from 'cn'
import { ChevronUpIcon } from 'lucide-react'
import { useId } from 'react'

/**
 * Bottom sheet below `sm`, inside `<main>` (no portal): a 3.5 rem header button with the
 * collapsed summary and a body that expands to 60dvh with internal scrolling. No gestures in this
 * delivery; the grid-rows transition respects reduced motion.
 */
export function MobileSheet({
  label,
  expanded,
  onToggle,
  summary,
  children,
  attributes,
}: {
  label: string
  expanded: boolean
  onToggle: () => void
  summary: React.ReactNode
  children: React.ReactNode
  attributes?: Record<string, string>
}) {
  const contentId = useId()
  return (
    <section
      className="absolute inset-x-0 bottom-0 z-20 flex max-h-[60dvh] flex-col rounded-t-xl border-t bg-card text-xs/relaxed text-card-foreground shadow-[0_-6px_20px_rgba(0,0,0,0.12)]"
      aria-label={label}
      data-mobile-sheet={expanded ? 'expanded' : 'collapsed'}
      {...attributes}
    >
      <button
        type="button"
        className="flex h-14 shrink-0 items-center gap-3 px-5 text-left focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={onToggle}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">{summary}</span>
        <ChevronUpIcon
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 transition-transform motion-reduce:transition-none',
            expanded && 'rotate-180',
          )}
        />
      </button>
      <div
        id={contentId}
        className="grid min-h-0 overflow-hidden transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
        inert={!expanded}
      >
        {/* No padding on the scroll box: with border-box it would keep the collapsed row open. */}
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          <div className="px-5 pb-5">{children}</div>
        </div>
      </div>
    </section>
  )
}
