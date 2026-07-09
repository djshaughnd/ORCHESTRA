import type { Logger } from 'pino';
import { macNotify, type NotifyFn } from './monitor.js';

export interface FreezeVerdict {
  frozen: boolean;
  frozenMs: number;
}

/**
 * Pure freeze detector — clock-free and deterministic for tests.
 *
 * Fed a hash of the capture's current frame each sample. A live camera feed
 * has sensor noise so consecutive frames hash differently; when the feed
 * freezes or the device drops, the hash stops changing (or reads null) and
 * the "unchanged" duration grows. Frozen once that duration crosses freezeMs.
 */
export class FreezeDetector {
  private lastHash: string | null = null;
  private lastChangeMs = 0;

  constructor(private freezeMs: number) {}

  /** Call when (re)starting monitoring so the freeze clock starts fresh. */
  reset(nowMs: number): void {
    this.lastHash = null;
    this.lastChangeMs = nowMs;
  }

  /**
   * Feed one frame hash. `null` = the frame couldn't be read (device dropped),
   * which counts as "not changing" so the freeze duration keeps growing.
   */
  sample(hash: string | null, nowMs: number): FreezeVerdict {
    if (hash !== null && hash !== this.lastHash) {
      this.lastHash = hash;
      this.lastChangeMs = nowMs;
    }
    const frozenMs = nowMs - this.lastChangeMs;
    return { frozen: frozenMs >= this.freezeMs, frozenMs };
  }
}

export interface CaptureWatchdogOpts {
  /** Returns a hash of the current capture frame, or null if unreadable. */
  grabFrame: () => Promise<string | null>;
  /** Fired once when the feed transitions into a frozen state. */
  onFreeze: (frozenMs: number) => void;
  /** Fired once when a previously-frozen feed recovers. */
  onRecover: () => void;
  /** Optional best-effort recovery action, run once on freeze. */
  recover?: () => Promise<void>;
  pollMs: number;
  freezeSeconds: number;
  log: Logger;
  notify?: NotifyFn;
  now?: () => number;
}

/**
 * Watches the OBS capture source while recording and raises the alarm the
 * moment the feed freezes or drops — so an unattended recording can be
 * trusted. Owns its own ticker (the only place that touches real time),
 * mirroring HealthMonitor/Director. Never throws into the caller.
 */
export class CaptureWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private detector: FreezeDetector;
  private frozen = false;
  private busy = false;
  private notify: NotifyFn;
  private now: () => number;

  constructor(private opts: CaptureWatchdogOpts) {
    this.detector = new FreezeDetector(opts.freezeSeconds * 1000);
    this.notify = opts.notify ?? macNotify;
    this.now = opts.now ?? Date.now;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  start(): void {
    if (this.timer) return;
    this.detector.reset(this.now());
    this.frozen = false;
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs);
    this.opts.log.info({ pollMs: this.opts.pollMs, freezeSeconds: this.opts.freezeSeconds }, 'capture watchdog started');
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.frozen = false;
    this.opts.log.info('capture watchdog stopped');
  }

  private async tick(): Promise<void> {
    if (this.busy) return; // never let a slow grab stack up
    this.busy = true;
    try {
      let hash: string | null;
      try {
        hash = await this.opts.grabFrame();
      } catch {
        hash = null; // unreadable — a strong freeze/disconnect signal
      }
      const verdict = this.detector.sample(hash, this.now());

      if (verdict.frozen && !this.frozen) {
        this.frozen = true;
        const secs = Math.round(verdict.frozenMs / 1000);
        this.opts.log.error({ frozenMs: verdict.frozenMs }, 'CAPTURE FROZEN during recording');
        this.notify('ORCHESTRA capture', `Recording feed frozen ${secs}s — check the ATEM USB capture`);
        try {
          this.opts.onFreeze(verdict.frozenMs);
        } catch (err) {
          this.opts.log.error({ err: (err as Error).message }, 'onFreeze listener failed');
        }
        if (this.opts.recover) {
          try {
            await this.opts.recover();
            this.opts.log.info('capture recovery attempted');
          } catch (err) {
            this.opts.log.warn({ err: (err as Error).message }, 'capture recovery failed');
          }
        }
      } else if (!verdict.frozen && this.frozen) {
        this.frozen = false;
        this.opts.log.info('capture recovered');
        this.notify('ORCHESTRA capture', 'Recording feed live again');
        try {
          this.opts.onRecover();
        } catch (err) {
          this.opts.log.error({ err: (err as Error).message }, 'onRecover listener failed');
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
