import type { Logger } from 'pino';
import type { AutoSwitchConfig, BeatReactiveConfig, SequenceCue } from './config.js';
import type { AtemClient } from './clients/atem.js';
import { BeatReactiveEngine } from './beat-director.js';

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
 * Scripted cinematic cue engine (V2.5). Plays a fixed, ordered cut list —
 * e.g. a 90s DJ mixing reel: wide → slider → overhead → rear-screen cutaway
 * — instead of AutoSwitchEngine's random rotation. Same clock-free,
 * tick(nowMs)-driven shape so it's deterministic to test.
 *
 * Unlike AutoSwitchEngine, a manual cut ABORTS the sequence rather than
 * pausing it: resuming a timed script after an unplanned interruption
 * doesn't make sense, so "manual always wins" here means "manual ends it."
 */
export class CueSequenceEngine {
  private armed = false;
  private index = -1;
  private cueStartedAtMs = 0;
  private finished = false;

  constructor(
    private cues: SequenceCue[],
    private cut: CutFn,
    private log: Logger,
  ) {}

  get isArmed(): boolean {
    return this.armed;
  }

  get program(): number | null {
    return this.index >= 0 && this.index < this.cues.length ? this.cues[this.index]!.cam : null;
  }

  get isDone(): boolean {
    return this.finished;
  }

  get cueIndex(): number {
    return this.index;
  }

  arm(nowMs: number): void {
    if (this.cues.length === 0) {
      this.log.warn('cue sequence has no cues — nothing to run');
      return;
    }
    this.armed = true;
    this.finished = false;
    this.index = -1;
    this.advance(nowMs);
    this.log.info({ cues: this.cues.length }, 'cue sequence ARMED');
  }

  disarm(): void {
    if (this.armed) this.log.info('cue sequence DISARMED');
    this.armed = false;
  }

  /** Any manual cut aborts the script — resuming the timing makes no sense. */
  noteManualCut(_cam: number, _nowMs: number): void {
    if (this.armed) this.log.info('manual override — cue sequence aborted');
    this.armed = false;
  }

  /** No-op — cue sequences are scripted, not audio-reactive. Kept for a
   *  uniform interface with AutoSwitchEngine so Director can treat either
   *  engine the same way. */
  updateAudioLevel(_obsInput: string, _db: number, _nowMs: number): void {
    /* scripted sequences ignore audio */
  }

  private advance(nowMs: number): number | null {
    this.index += 1;
    if (this.index >= this.cues.length) {
      this.finished = true;
      this.armed = false;
      this.log.info('cue sequence complete');
      return null;
    }
    const cue = this.cues[this.index]!;
    this.cueStartedAtMs = nowMs;
    this.log.info({ cam: cue.cam, label: cue.label, holdMs: cue.holdMs }, 'sequence cut');
    void this.cut(cue.cam).catch((err) =>
      this.log.error({ cam: cue.cam, err: (err as Error).message }, 'sequence cut FAILED'),
    );
    return cue.cam;
  }

  /** Advance the engine. Returns the camera cut this tick, or null. */
  tick(nowMs: number): number | null {
    if (!this.armed) return null;
    const cue = this.cues[this.index];
    if (!cue) return null;
    if (nowMs - this.cueStartedAtMs < cue.holdMs) return null;
    return this.advance(nowMs);
  }
}

type SwitchEngine = AutoSwitchEngine | CueSequenceEngine | BeatReactiveEngine;

/**
 * Owns the engine lifecycle + the 500ms ticker. The HTTP layer talks to
 * this, never to the engine directly. Rotation mode and sequence mode are
 * mutually exclusive — starting one tears down the other, matching the
 * "single active controller, kill switch always works" design.
 */
export class Director {
  private engine: SwitchEngine | null = null;
  private mode: 'rotation' | 'sequence' | 'reactive' | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private atem: AtemClient,
    private log: Logger,
  ) {}

  arm(settings: AutoSwitchConfig, startCam?: number): void {
    this.engine = new AutoSwitchEngine(settings, (cam) => this.atem.cut(cam), this.log);
    this.mode = 'rotation';
    this.engine.arm(Date.now(), startCam);
    this.startTicker();
  }

  /** Run a scripted cinematic cue list (e.g. a timed multi-cam reel). */
  runSequence(cues: SequenceCue[]): void {
    this.engine = new CueSequenceEngine(cues, (cam) => this.atem.cut(cam), this.log);
    this.mode = 'sequence';
    this.engine.arm(Date.now());
    this.startTicker();
  }

  /** Arm the beat-reactive director (music-driven fast cutting). */
  armReactive(settings: BeatReactiveConfig, startCam?: number): void {
    this.engine = new BeatReactiveEngine(settings, (cam) => this.atem.cut(cam), this.log);
    this.mode = 'reactive';
    this.engine.arm(Date.now(), startCam);
    this.startTicker();
  }

  private startTicker(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.engine?.tick(Date.now());
      // A finished (non-looping) sequence tears itself down so /status
      // reflects "idle" instead of "armed" forever after the last cue.
      if (this.engine instanceof CueSequenceEngine && this.engine.isDone) this.disarm();
    }, 500);
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

  get status(): {
    armed: boolean;
    program: number | null;
    mode: 'rotation' | 'sequence' | 'reactive' | null;
    cueIndex?: number;
    energy?: number;
  } {
    return {
      armed: this.engine?.isArmed ?? false,
      program: this.engine?.program ?? null,
      mode: this.engine?.isArmed ? this.mode : null,
      ...(this.engine instanceof CueSequenceEngine ? { cueIndex: this.engine.cueIndex } : {}),
      ...(this.engine instanceof BeatReactiveEngine
        ? { energy: Number(this.engine.currentEnergy.toFixed(2)) }
        : {}),
    };
  }
}
