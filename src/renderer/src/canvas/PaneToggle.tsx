import { useWorkspace } from './components'

/** Pane-edge glyph in the toolbar icon style: 24px viewBox, stroke 1.8. */
function PaneIcon({ side }: { side: 'left' | 'right' }): React.JSX.Element {
  const x = side === 'left' ? 9 : 15
  return (
    <svg
      className="dg-node__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d={`M${x} 4v16`} />
    </svg>
  )
}

/**
 * Shows or hides a side pane. Lives in the workspace toolbars, so a hidden pane can always be
 * brought back from where the canvas is.
 */
export function PaneToggle({ side }: { side: 'left' | 'inspector' }): React.JSX.Element {
  const { panes } = useWorkspace()
  const open = side === 'left' ? panes.left : panes.inspector
  const name =
    side === 'left' ? (panes.leftTab === 'chat' ? 'design chat' : 'project') : 'inspector'
  const label = `${open ? 'Hide' : 'Show'} ${name}`
  return (
    <button
      type="button"
      className="dg-btn dg-btn--ghost pane-toggle"
      aria-pressed={open}
      aria-label={label}
      title={`${label} (${side === 'left' ? '⌘\\' : '⌘⇧\\'})`}
      onClick={() => (side === 'left' ? panes.setLeft(!open) : panes.setInspector(!open))}
    >
      <PaneIcon side={side === 'left' ? 'left' : 'right'} />
    </button>
  )
}
