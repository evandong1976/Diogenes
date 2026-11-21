import { useEffect, useRef } from 'react'

type Stroke = { x: number; y: number }[]

interface Props {
  /** When false the layer shows its ink but lets clicks through to the diagram. */
  active: boolean
  /** Changing this clears the ink. */
  clearKey: number
  onInkChange(hasInk: boolean): void
}

/** Freehand markup over the canvas. It is part of the captured area sent to Gemini. */
export function DrawLayer({ active, clearKey, onInkChange }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<Stroke[]>([])
  const drawing = useRef(false)

  const redraw = (): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const ratio = window.devicePixelRatio || 1
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--dg-accent').trim() || 'orange'
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const stroke of strokes.current) {
      ctx.beginPath()
      stroke.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
      ctx.stroke()
    }
  }

  // Keep the backing store matched to the element size so ink stays sharp.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => {
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.round(canvas.clientWidth * ratio)
      canvas.height = Math.round(canvas.clientHeight * ratio)
      redraw()
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    strokes.current = []
    redraw()
    onInkChange(false)
    // onInkChange is a setter from the parent; clearing only depends on clearKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearKey])

  const point = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  return (
    <canvas
      ref={canvasRef}
      className="draw-layer"
      data-active={active || undefined}
      onPointerDown={(e) => {
        if (!active) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drawing.current = true
        strokes.current.push([point(e)])
        onInkChange(true)
      }}
      onPointerMove={(e) => {
        if (!drawing.current) return
        strokes.current.at(-1)!.push(point(e))
        redraw()
      }}
      onPointerUp={() => (drawing.current = false)}
      onPointerCancel={() => (drawing.current = false)}
    />
  )
}
