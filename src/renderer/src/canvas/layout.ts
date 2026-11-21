export interface Point {
  x: number
  y: number
}

const COLUMN_GAP = 280
const ROW_GAP = 130

const MAX_ROWS = 6

/**
 * Left-to-right layered layout: each node's column is its shortest distance from a root.
 * Unreachable nodes go in a final column. Tall columns wrap so the diagram stays wide.
 */
export function layeredLayout(
  roots: string[],
  ids: string[],
  edges: { from: string; to: string }[]
): Map<string, Point> {
  const depth = new Map<string, number>(roots.map((id) => [id, 0]))
  const queue = [...roots]
  while (queue.length) {
    const id = queue.shift()!
    for (const e of edges) {
      if (e.from === id && !depth.has(e.to)) {
        depth.set(e.to, depth.get(id)! + 1)
        queue.push(e.to)
      }
    }
  }

  const maxDepth = Math.max(0, ...depth.values())
  const layers = new Map<number, string[]>()
  for (const id of ids) {
    const d = depth.get(id) ?? maxDepth + 1
    layers.set(d, [...(layers.get(d) ?? []), id])
  }

  // Split each layer into columns of at most MAX_ROWS, keeping layers in order.
  const positions = new Map<string, Point>()
  let x = 0
  for (const d of [...layers.keys()].sort((a, b) => a - b)) {
    const layer = layers.get(d)!
    for (let start = 0; start < layer.length; start += MAX_ROWS) {
      const column = layer.slice(start, start + MAX_ROWS)
      column.forEach((id, i) => {
        positions.set(id, { x, y: (i - (column.length - 1) / 2) * ROW_GAP })
      })
      x += COLUMN_GAP
    }
  }
  return positions
}
