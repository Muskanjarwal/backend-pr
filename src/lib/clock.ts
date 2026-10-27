/** Injected so business rules (hold expiry, cancellation windows) are testable without sleeping. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  constructor(private current: Date = new Date("2030-01-01T00:00:00Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  set(d: Date): void {
    this.current = d;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
