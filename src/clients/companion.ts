import type { Logger } from 'pino';

/** Minimal fetch shape so tests can inject a mock. */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

/**
 * Pushes state to Bitfocus Companion custom variables over its HTTP API
 * (Companion Settings -> HTTP API must be enabled).
 *
 * Fire-and-forget by design: never throws, never blocks a caller — Companion
 * being down must never affect the studio. Buttons reference the variables as
 * $(internal:custom_<name>) in feedbacks/triggers to flip colors.
 */
export class CompanionClient {
  constructor(
    private url: string,
    private enabled: boolean,
    private log: Logger,
    private fetchFn: FetchFn = fetch as unknown as FetchFn,
  ) {}

  /** Set a Companion custom variable. No-op when companion.enabled=false. */
  setVariable(name: string, value: string): void {
    if (!this.enabled) return;
    const target = `${this.url.replace(/\/+$/, '')}/api/custom-variable/${encodeURIComponent(name)}/value`;
    void this.fetchFn(target, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: value,
      signal: AbortSignal.timeout(2_000),
    })
      .then((res) => {
        if (!res.ok) {
          this.log.warn({ name, value, status: res.status }, 'companion push rejected');
        }
      })
      .catch((err: Error) => {
        this.log.warn({ name, value, err: err.message }, 'companion push failed');
      });
  }

  /** orchestra_health = "ok" | "fail" — wired to health monitor transitions. */
  pushHealth(ok: boolean): void {
    this.setVariable('orchestra_health', ok ? 'ok' : 'fail');
  }

  /** orchestra_capture = "ok" | "frozen" — wired to capture watchdog transitions. */
  pushCapture(ok: boolean): void {
    this.setVariable('orchestra_capture', ok ? 'ok' : 'frozen');
  }
}
