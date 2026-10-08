import { useLayoutEffect, useRef, type ReactNode } from 'react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

import type { MapHover } from './map-canvas'
import { areaLabel } from './map-data'
import { tooltipPosition } from './map-geometry'

export function MapTooltip({
  hover,
  children,
}: {
  hover: NonNullable<MapHover>
  /** Data detail under the place name, such as the election leader. */
  children?: ReactNode
}) {
  const card = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = card.current
    const parent = element?.parentElement
    if (!element || !parent) return
    const position = tooltipPosition(
      hover.x,
      hover.y,
      parent.clientWidth,
      parent.clientHeight,
      element.offsetWidth,
      element.offsetHeight,
    )
    element.style.left = `${position.left}px`
    element.style.top = `${position.top}px`
  }, [hover, children])

  return (
    <Card
      ref={card}
      size="sm"
      role="tooltip"
      className="pointer-events-none absolute w-max shadow-lg"
      style={{ maxWidth: 'min(16rem, calc(100% - 24px))' }}
    >
      <CardHeader className="[container-type:normal]">
        <CardTitle>{hover.area.name}</CardTitle>
        <CardDescription>
          {areaLabel(hover.area)} · {hover.area.stateAbbr}
        </CardDescription>
      </CardHeader>
      {children && <CardContent>{children}</CardContent>}
    </Card>
  )
}
