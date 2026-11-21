import { useRef } from 'react'
import { CHAT_WIDTH, saveChatWidth } from './chatWidth'

const clamp = (n: number): number =>
  Math.round(Math.min(CHAT_WIDTH.max, Math.max(CHAT_WIDTH.min, n)))

/**
 * The draggable divider on the left pane's right edge. Arrow keys nudge it, Home/End jump to the
 * limits, double-click resets. CSS also caps the width so the canvas keeps room.
 */
export function PaneResizer({
  width,
  onWidth,
  onDragging
}: {
  width: number
  onWidth(width: number): void
  onDragging(dragging: boolean): void
}): React.JSX.Element {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const commit = (n: number): void => {
    const next = clamp(n)
    onWidth(next)
    saveChatWidth(next)
  }
  return (
    <div
      className="leftpane__resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize design chat"
      aria-valuenow={width}
      aria-valuemin={CHAT_WIDTH.min}
      aria-valuemax={CHAT_WIDTH.max}
      title="Drag to resize · double-click to reset"
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        // Start from the rendered width, which CSS may have capped.
        const rendered = e.currentTarget.parentElement?.getBoundingClientRect().width ?? width
        drag.current = { x: e.clientX, width: rendered }
        onDragging(true)
      }}
      onPointerMove={(e) => {
        if (drag.current) onWidth(clamp(drag.current.width + e.clientX - drag.current.x))
      }}
      onPointerUp={(e) => {
        if (!drag.current) return
        commit(drag.current.width + e.clientX - drag.current.x)
        drag.current = null
        onDragging(false)
      }}
      onPointerCancel={() => {
        drag.current = null
        onDragging(false)
      }}
      onDoubleClick={() => commit(CHAT_WIDTH.initial)}
      onKeyDown={(e) => {
        const next: Record<string, number> = {
          ArrowLeft: width - CHAT_WIDTH.step,
          ArrowRight: width + CHAT_WIDTH.step,
          Home: CHAT_WIDTH.min,
          End: CHAT_WIDTH.max
        }
        if (!(e.key in next)) return
        e.preventDefault()
        commit(next[e.key])
      }}
    />
  )
}
