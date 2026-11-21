import { useEffect, useId, useRef, useState } from 'react'

export interface PickerOption {
  value: string
  label: string
  /** Quiet trailing text, e.g. "working". */
  hint?: string
}

interface Props {
  value: string | null
  options: PickerOption[]
  onChange(value: string): void
  /** Accessible name, also the tooltip. */
  label: string
  /** Shown in the trigger when nothing is selected. */
  placeholder?: string
  /** Optional heading inside the menu. */
  heading?: string
  disabled?: boolean
  /** Open above the trigger (for controls at the bottom of a pane). */
  up?: boolean
  className?: string
}

/**
 * An app-styled select: a quiet trigger and a listbox popover. Arrow keys, Home/End, Enter and
 * Escape work as in a native select; clicking outside closes it.
 */
export function Picker({
  value,
  options,
  onChange,
  label,
  placeholder,
  heading,
  disabled,
  up,
  className
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const current = options.find((o) => o.value === value)

  const show = (): void => {
    if (disabled || !options.length) return
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value)
      )
    )
    setOpen(true)
  }
  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }
  const pick = (i: number): void => {
    const o = options[i]
    if (o && o.value !== value) onChange(o.value)
    close(true)
  }

  useEffect(() => {
    if (!open) return
    list.current?.focus()
    const outside = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])

  const onListKey = (e: React.KeyboardEvent): void => {
    const last = options.length - 1
    const move: Record<string, number> = {
      ArrowDown: Math.min(last, active + 1),
      ArrowUp: Math.max(0, active - 1),
      Home: 0,
      End: last
    }
    if (e.key in move) {
      e.preventDefault()
      setActive(move[e.key])
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(active)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className={`picker ${className ?? ''}`} ref={root} data-up={up ? '' : undefined}>
      <button
        ref={trigger}
        type="button"
        className="picker__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? placeholder ?? 'none'}`}
        title={label}
        disabled={disabled}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            show()
          }
        }}
      >
        <span className="picker__value">{current?.label ?? placeholder}</span>
        <svg className="picker__chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 10l5 5 5-5" />
        </svg>
      </button>
      {open && (
        <div className="picker__menu">
          {heading && <div className="picker__heading">{heading}</div>}
          <ul
            ref={list}
            role="listbox"
            tabIndex={-1}
            aria-label={label}
            aria-activedescendant={`${id}-${active}`}
            onKeyDown={onListKey}
          >
            {options.map((o, i) => (
              <li
                key={o.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={o.value === value}
                data-active={i === active ? '' : undefined}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
              >
                <span className="picker__check" aria-hidden="true">
                  {o.value === value ? '✓' : ''}
                </span>
                <span className="picker__label">{o.label}</span>
                {o.hint && <span className="picker__hint">{o.hint}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
