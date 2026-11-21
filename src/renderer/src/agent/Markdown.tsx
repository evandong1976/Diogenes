import { useMemo } from 'react'
import { parseInline, parseMarkdown, type ListItem } from './briefMarkdown'

function Text({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {parseInline(text).map((part, i) =>
        part.kind === 'code' ? (
          <code key={i}>{part.text}</code>
        ) : part.kind === 'bold' ? (
          <strong key={i}>{part.text}</strong>
        ) : (
          part.text
        )
      )}
    </>
  )
}

/** Items at `depth`, each with the deeper items that follow it nested inside. */
function List({ items, depth }: { items: ListItem[]; depth: number }): React.JSX.Element {
  const groups: { item: ListItem; children: ListItem[] }[] = []
  for (const item of items) {
    if (item.depth <= depth || !groups.length) groups.push({ item, children: [] })
    else groups[groups.length - 1].children.push(item)
  }
  const Tag = groups[0]?.item.ordered ? 'ol' : 'ul'
  return (
    <Tag>
      {groups.map(({ item, children }, i) => (
        <li key={i}>
          <Text text={item.text} />
          {children.length > 0 && <List items={children} depth={depth + 1} />}
        </li>
      ))}
    </Tag>
  )
}

/**
 * Renders Markdown with the app's type; see briefMarkdown.ts for the subset. `plain` drops the
 * panel, for agent replies inside the chat transcript.
 */
export function Markdown({
  source,
  plain
}: {
  source: string
  plain?: boolean
}): React.JSX.Element {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className={plain ? 'md md--plain' : 'md'}>
      {blocks.map((b, i) => {
        if (b.kind === 'heading') {
          const Tag = `h${b.level}` as const
          return (
            <Tag key={i}>
              <Text text={b.text} />
            </Tag>
          )
        }
        if (b.kind === 'list')
          return <List key={i} items={b.items} depth={Math.min(...b.items.map((x) => x.depth))} />
        if (b.kind === 'code')
          return (
            <pre key={i} className="coding__pre" data-lang={b.lang || undefined}>
              {b.text}
            </pre>
          )
        return (
          <p key={i}>
            <Text text={b.text} />
          </p>
        )
      })}
    </div>
  )
}
