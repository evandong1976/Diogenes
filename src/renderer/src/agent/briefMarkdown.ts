/**
 * The Markdown subset the coding briefs (src/main/workflow/brief.ts) and the agents' replies
 * use: ATX headings, `-`/`*`/`1.` lists nested by indentation, fenced code, paragraphs, and
 * inline `code` and **bold**. Parsed to plain data and
 * rendered as React elements, never as HTML, so brief text cannot inject markup.
 */
export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'para'; text: string }

/** `depth` counts indentation steps (two spaces, or a tab, each). */
export interface ListItem {
  text: string
  depth: number
  ordered: boolean
}

export type Inline = { kind: 'text' | 'code' | 'bold'; text: string }

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let para: string[] = []
  const flush = (): void => {
    if (para.length) blocks.push({ kind: 'para', text: para.join('\n') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      while (++i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i])
      blocks.push({ kind: 'code', lang: fence[1], text: body.join('\n') })
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4,
        text: heading[2].trim()
      })
      continue
    }
    const item = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(line)
    const last = blocks.at(-1)
    if (item) {
      flush()
      const next: ListItem = {
        text: item[3],
        depth: Math.floor(item[1].replace(/\t/g, '  ').length / 2),
        ordered: /\d/.test(item[2])
      }
      if (last?.kind === 'list' && !para.length) last.items.push(next)
      else blocks.push({ kind: 'list', items: [next] })
      continue
    }
    // An indented line right after an item continues it; a blank line ends the list.
    if (last?.kind === 'list' && !para.length && /^\s+\S/.test(line)) {
      last.items[last.items.length - 1].text += ` ${line.trim()}`
      continue
    }
    if (!line.trim()) {
      flush()
      if (last?.kind === 'list') blocks.push({ kind: 'para', text: '' })
    } else para.push(line)
  }
  flush()
  return blocks.filter((b) => b.kind !== 'para' || b.text !== '')
}

/** Inline `code` and **bold**; everything else is text. Unclosed markers stay literal. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let at = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > at) out.push({ kind: 'text', text: text.slice(at, m.index) })
    out.push(m[1] !== undefined ? { kind: 'code', text: m[1] } : { kind: 'bold', text: m[2] })
    at = m.index + m[0].length
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) })
  return out
}
