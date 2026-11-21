import { format, double, Square } from '@lib/index'
import { format as formatDate } from '@lib/date'
import leftPad from 'left-pad'

export function render(items: number[], when: Date): string {
  const doubled = items.map(double)
  const area = new Square(3).area()
  const title = format(`report ${area}`)
  return leftPad(`${title} ${formatDate(when)} ${doubled.join(',')}`, 40)
}
