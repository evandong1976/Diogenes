export interface Point {
  x: number
  y: number
}

const COLUMN_GAP = 280
const ROW_GAP = 130

/**
 * Left-to-right layered layout: each state's column is its shortest distance from the
 * initial state. Unreachable states go in a final column. Rows are centred per column.
 */
export function layeredLayout(
  initialId: string,
  ids: string[],
  edges: { from: string; to: string }[]
): Map<string, Point> {
  const depth = new Map<string, number>([[initialId, 0]])
  const queue = [initialId]
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
  const columns = new Map<number, string[]>()
  for (const id of ids) {
    const d = depth.get(id) ?? maxDepth + 1
    columns.set(d, [...(columns.get(d) ?? []), id])
  }

  const positions = new Map<string, Point>()
  for (const [d, column] of columns) {
    column.forEach((id, i) => {
      positions.set(id, { x: d * COLUMN_GAP, y: (i - (column.length - 1) / 2) * ROW_GAP })
    })
  }
  return positions
}
