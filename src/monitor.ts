import { spawn } from 'node:child_process';
import type { Logger } from 'pino';
import type { HealthReport } from './health.js';

export type NotifyFn = (title: string, message: string) => void;

/** macOS notification via osascript. Best-effort, never throws. */
export function macNotify(title: string, message: string): void {
  spawn('osascript', [
    '-e',
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
  ]).on('error', () => {
    /* not macOS or osascript missing — ignore */
  });
}

export interface HealthMonitorOpts {
  notify?: NotifyFn;
  intervalMs?: number;
  /** Fired on every ok-state transition (including the first check). */
  onTransition?: (ok: boolean) => void;
}

/**
 * Health monitor loop (V2): runs checks every intervalMs while a session
 * is armed. Notifies on state TRANSITIONS only (ok→fail, fail→ok) so it
 * never spams. Companion can keep polling GET /health for button color,
 * or receive pushes via onTransition -> CompanionClient.
 */
export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private lastOk: boolean | null = null;
  private notify: NotifyFn;
  private intervalMs: number;
  private onTransition: ((ok: boolean) => void) | null;

  constructor(
    private run: () => Promise<HealthReport>,
    private log: Logger,
    opts: HealthMonitorOpts = {},
  ) {
    this.notify = opts.notify ?? macNotify;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.onTransition = opts.onTransition ?? null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.log.info({ intervalMs: this.intervalMs }, 'health monitor started');
    void this.check();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.lastOk = null;
      this.log.info('health monitor stopped');
    }
  }

  private async check(): Promise<void> {
    let report: HealthReport;
    try {
      report = await this.run();
    } catch (err) {
      // runHealthChecks never throws by contract, but belt and suspenders.
      this.log.error({ err: (err as Error).message }, 'health run failed');
      return;
    }
    if (report.ok !== this.lastOk) {
      try {
        this.onTransition?.(report.ok);
      } catch (err) {
        // A listener must never break the monitor loop.
        this.log.error({ err: (err as Error).message }, 'health transition listener failed');
      }
      if (!report.ok) {
        const failed = Object.entries(report.checks)
          .filter(([, c]) => !c.ok)
          .map(([name, c]) => `${name}: ${c.detail}`)
          .join('; ');
        this.log.error({ failed }, 'HEALTH FAILED during armed session');
        this.notify('ORCHESTRA health', failed || 'health check failed');
      } else if (this.lastOk === false) {
        this.log.info('health recovered');
        this.notify('ORCHESTRA health', 'All checks green again');
      }
    }
    this.lastOk = report.ok;
  }
}
