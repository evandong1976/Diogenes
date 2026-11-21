/** Draggable chat pane width, in px, and its per-viewer persistence. */
export const CHAT_WIDTH = { min: 260, max: 720, initial: 340, step: 16 }
const KEY = 'diogenes.chatWidth'

/** The saved chat width; a per-viewer convenience, so storage failures fall back silently. */
export function savedChatWidth(): number {
  try {
    const n = Number(localStorage.getItem(KEY))
    if (n >= CHAT_WIDTH.min && n <= CHAT_WIDTH.max) return n
  } catch {
    // storage unavailable
  }
  return CHAT_WIDTH.initial
}

export function saveChatWidth(width: number): void {
  try {
    localStorage.setItem(KEY, String(width))
  } catch {
    // storage unavailable
  }
}
