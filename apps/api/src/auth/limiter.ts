import { Injectable } from '@nestjs/common';

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

/** In-memory sign-in throttle keyed by (IP, username). Per process; resets on restart. */
@Injectable()
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  blocked(key: string): boolean {
    return this.recent(key).length >= MAX_FAILURES;
  }

  fail(key: string): void {
    if (this.failures.size > 10_000) for (const k of this.failures.keys()) if (!this.recent(k).length) this.failures.delete(k);
    this.failures.set(key, [...this.recent(key), Date.now()]);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const since = Date.now() - WINDOW_MS;
    return (this.failures.get(key) ?? []).filter((t) => t > since);
  }
}
