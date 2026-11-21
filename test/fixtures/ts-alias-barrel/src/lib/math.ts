export const double = (n: number): number => n * 2

export interface Shape {
  area(): number
}

export class Square implements Shape {
  constructor(private readonly side: number) {}
  area(): number {
    return this.side * this.side
  }
}
