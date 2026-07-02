import type { Logger } from 'pino';
import type { AutoSwitchConfig } from './config.js';
import type { AtemClient } from './clients/atem.js';

export type CutFn = (cam: number) => Promise<void>;

/** OBS volume-meter magnitude (mul) → dBFS. */
export function mulToDb(mul: number): number {
  return mul > 0 ? 20 * Math.log10(mul) : -100;
}

/**
 * Rule-based auto-switching engine (V2). No ML.
 *
 * - Rotation: random next camera after a random shot length in
 *   [minShotSeconds, maxShotSeconds]. Never machine-gun cuts, never
 *   picks the current camera.
 * - Manual override always wins: any manual cut pauses auto mode for
 *   overridePauseSeconds.
 * - Audio rule: sustained level on the configured OBS input favors the
 *   closeup cam (respecting min shot length).
 * - Kill switch: disarm() stops everything instantly.
 *
 * Deterministic + clock-free for tests: callers drive it via tick(nowMs)
 * and can inject the RNG.
 */
export class AutoSwitchEngine {
  private armed = false;
  private currentCam: number | null = null;
  private lastCutAtMs = 0;
  private pausedUntilMs = 0;
  private nextShotMs = 0;
  private audioAboveSinceMs: number | null = null;

  constructor(
    private cfg: AutoSwitchConfig,
    private cut: CutFn,
    private log: Logger,
    private rng: () => number = Math.random,
  ) {}

  get isArmed(): boolean {
    return this.armed;
  }

  get program(): number | null {
    return this.currentCam;
  }

  arm(nowMs: number, startCam?: number): void {
    this.armed = true;
    this.currentCam = startCam ?? this.cfg.cameras[0] ?? null;
    this.lastCutAtMs = nowMs;
    this.pausedUntilMs = 0;
    this.audioAboveSinceMs = null;
    this.rollNextShot();
    this.log.info({ startCam: this.currentCam }, 'auto-switch ARMED');
  }

  /** Kill switch. */
  disarm(): void {
    if (this.armed) this.log.info('auto-switch DISARMED (kill switch)');
    this.armed = false;
  }

  /** Any manual cut (Stream Deck / HTTP) pauses auto mode. */
  noteManualCut(cam: number, nowMs: number): void {
    this.currentCam = cam;
    this.lastCutAtMs = nowMs;
    this.pausedUntilMs = nowMs + this.cfg.overridePauseSeconds * 1000;
    if (this.armed) {
      this.log.info(
        { cam, pauseSeconds: this.cfg.overridePauseSeconds },
        'manual override — auto-switch paused',
      );
    }
  }

  updateAudioLevel(obsInput: string, db: number, nowMs: number): void {
    const a = this.cfg.audio;
    if (!a.enabled || obsInput !== a.obsInput) return;
    if (db >= a.thresholdDb) {
      if (this.audioAboveSinceMs === null) this.audioAboveSinceMs = nowMs;
    } else {
      this.audioAboveSinceMs = null;
    }
  }

  private audioHot(nowMs: number): boolean {
    const a = this.cfg.audio;
    return (
      a.enabled &&
      this.audioAboveSinceMs !== null &&
      nowMs - this.audioAboveSinceMs >= a.sustainMs
    );
  }

  private rollNextShot(): void {
    const { minShotSeconds: min, maxShotSeconds: max } = this.cfg;
    this.nextShotMs = (min + this.rng() * (max - min)) * 1000;
  }

  /** Advance the engine. Returns the camera cut this tick, or null. */
  tick(nowMs: number): number | null {
    if (!this.armed) return null;
    if (nowMs < this.pausedUntilMs) return null;
    const elapsed = nowMs - this.lastCutAtMs;
    if (elapsed < this.cfg.minShotSeconds * 1000) return null;

    // Sustained vocal → favor the closeup, even before the rotation timer.
    if (
      this.audioHot(nowMs) &&
      this.currentCam !== this.cfg.audio.closeupCam &&
      this.cfg.cameras.includes(this.cfg.audio.closeupCam)
    ) {
      return this.doCut(this.cfg.audio.closeupCam, nowMs, 'audio-closeup');
    }

    if (elapsed < this.nextShotMs) return null;
    const candidates = this.cfg.cameras.filter((c) => c !== this.currentCam);
    if (candidates.length === 0) return null;
    const idx = Math.min(candidates.length - 1, Math.floor(this.rng() * candidates.length));
    return this.doCut(candidates[idx]!, nowMs, 'rotation');
  }

  private doCut(cam: number, nowMs: number, reason: string): number {
    this.currentCam = cam;
    this.lastCutAtMs = nowMs;
    this.rollNextShot();
    this.log.info({ cam, reason }, 'auto cut');
    void this.cut(cam).catch((err) =>
      this.log.error({ cam, err: (err as Error).message }, 'auto cut FAILED'),
    );
    return cam;
  }
}

/**
 * Owns the engine lifecycle + the 500ms ticker. The HTTP layer talks to
 * this, never to the engine directly.
 */
export class Director {
  private engine: AutoSwitchEngine | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private atem: AtemClient,
    private log: Logger,
  ) {}

  arm(settings: AutoSwitchConfig, startCam?: number): void {
    this.engine = new AutoSwitchEngine(
      settings,
      (cam) => this.atem.cut(cam),
      this.log,
    );
    this.engine.arm(Date.now(), startCam);
    if (!this.timer) {
      this.timer = setInterval(() => this.engine?.tick(Date.now()), 500);
    }
  }

  disarm(): void {
    this.engine?.disarm();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  noteManualCut(cam: number): void {
    this.engine?.noteManualCut(cam, Date.now());
  }

  audio(obsInput: string, db: number): void {
    this.engine?.updateAudioLevel(obsInput, db, Date.now());
  }

  get status(): { armed: boolean; program: number | null } {
    return {
      armed: this.engine?.isArmed ?? false,
      program: this.engine?.program ?? null,
    };
  }
}
