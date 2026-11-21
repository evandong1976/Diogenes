/** Same name as text.ts#format on purpose. */
export function format(value: Date): string {
  return value.toISOString().slice(0, 10)
}
