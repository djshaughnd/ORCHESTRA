import type { Logger } from 'pino';
import type { BeatReactiveConfig } from './config.js';
import type { CutFn } from './switcher.js';

/**
 * Beat-reactive cinematic director (V3). Fast, music-driven cutting for
 * short-form mixing reels — the "feels like a real edit" engine.
 *
 * Two ideas working together, both from the OBS audio-meter stream ORCHESTRA
 * already receives (no new hardware, no ML):
 *
 *  1. Energy-scaled pacing (audio-reactive): a slow envelope of the level is
 *     mapped to 0..1 "energy". High energy (a drop) → short shots; low energy
 *     (a breakdown/intro) → longer shots. So the cut rate breathes with the set.
 *
 *  2. Onset-synced cuts (beat-aware): a sharp rise of the level above its
 *     rolling baseline is a beat/hit. Once a shot has been held its target
 *     length, the cut waits for the next onset so it lands ON the beat; a short
 *     grace timeout cuts anyway so it never hangs in a quiet passage.
 *
 * Camera choice is weighted by energy: loud → favour the close/action cam,
 * quiet → favour the wide/hero cam. Clock-free and RNG-injectable for tests;
 * cuts can fire from either updateAudioLevel (on a beat) or tick (grace timeout).
 */
export class BeatReactiveEngine {
  private armed = false;
  private currentCam: number | null = null;
  private lastCutAtMs = 0;
  private pausedUntilMs = 0;

  private slowEnvDb: number;
  private lastOnsetMs = -Infinity;
  private energy = 0; // 0..1, from slowEnvDb between floor/ceil
  private started = false;

  constructor(
    private cfg: BeatReactiveConfig,
    private cut: CutFn,
    private log: Logger,
    private rng: () => number = Math.random,
  ) {
    this.slowEnvDb = cfg.energyFloorDb;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  get program(): number | null {
    return this.currentCam;
  }

  /** 0..1 — exposed for /status and the dashboard so the energy is visible. */
  get currentEnergy(): number {
    return this.energy;
  }

  arm(nowMs: number, startCam?: number): void {
    if (this.cfg.cameras.length === 0) {
      this.log.warn('beat-reactive director has no cameras');
      return;
    }
    this.armed = true;
    this.currentCam = startCam ?? this.cfg.wideCam;
    this.lastCutAtMs = nowMs;
    this.pausedUntilMs = 0;
    this.slowEnvDb = this.cfg.energyFloorDb;
    this.lastOnsetMs = -Infinity;
    this.energy = 0;
    this.started = false;
    this.log.info({ startCam: this.currentCam }, 'beat-reactive director ARMED');
  }

  disarm(): void {
    if (this.armed) this.log.info('beat-reactive director DISARMED');
    this.armed = false;
  }

  /** Manual cut takes the shot and pauses auto for a beat, then resumes. */
  noteManualCut(cam: number, nowMs: number): void {
    this.currentCam = cam;
    this.lastCutAtMs = nowMs;
    this.pausedUntilMs = nowMs + this.cfg.overridePauseMs;
    if (this.armed) this.log.info({ cam }, 'manual override — beat director paused');
  }

  /** Target shot length for the current energy: high energy → short shots. */
  private targetShotMs(): number {
    const { minShotMs, maxShotMs } = this.cfg;
    return maxShotMs - this.energy * (maxShotMs - minShotMs);
  }

  /**
   * Fed the audio level (dBFS) for the configured input. Updates the energy
   * envelope, detects onsets, and cuts ON the beat once the shot has been held
   * long enough. Ignores other inputs.
   */
  updateAudioLevel(obsInput: string, db: number, nowMs: number): void {
    if (!this.armed || obsInput !== this.cfg.obsInput) return;

    // First sample seeds the baseline so a cold start isn't a fake onset.
    if (!this.started) {
      this.slowEnvDb = db;
      this.started = true;
    }

    // Onset = this sample is much louder than the ESTABLISHED baseline. Detect
    // BEFORE folding the sample into the envelope, or a snappy envelope would
    // absorb the transient before we ever see it.
    const isOnset =
      db - this.slowEnvDb >= this.cfg.onsetRiseDb &&
      nowMs - this.lastOnsetMs >= this.cfg.refractoryMs;
    if (isOnset) this.lastOnsetMs = nowMs;

    // Now update the slow baseline + derived energy (0..1).
    this.slowEnvDb = this.slowEnvDb + this.cfg.envelopeAlpha * (db - this.slowEnvDb);
    const { energyFloorDb, energyCeilDb } = this.cfg;
    this.energy = clamp01((this.slowEnvDb - energyFloorDb) / (energyCeilDb - energyFloorDb));

    if (nowMs < this.pausedUntilMs) return;
    const held = nowMs - this.lastCutAtMs;
    if (isOnset && held >= this.targetShotMs()) {
      const next = this.pickNext();
      if (next !== null) this.doCut(next, nowMs, 'beat');
    }
  }

  /** Grace timeout: cut even without a clean beat so quiet passages still move. */
  tick(nowMs: number): number | null {
    if (!this.armed || nowMs < this.pausedUntilMs) return null;
    const held = nowMs - this.lastCutAtMs;
    if (held >= this.targetShotMs() + this.cfg.beatGraceMs) {
      const next = this.pickNext();
      if (next !== null) return this.doCut(next, nowMs, 'timeout');
    }
    return null;
  }

  /**
   * Weighted next camera: energy biases toward close (loud) or wide (quiet).
   * Returns null when there is no camera other than the current one.
   */
  private pickNext(): number | null {
    const candidates = this.cfg.cameras.filter((c) => c !== this.currentCam);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;

    const weights = candidates.map((c) => {
      let w = 1;
      if (this.energy >= this.cfg.highEnergy && c === this.cfg.closeupCam) w += 2;
      if (this.energy <= this.cfg.lowEnergy && c === this.cfg.wideCam) w += 2;
      return w;
    });
    const total = weights.reduce((s, w) => s + w, 0);
    let r = this.rng() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i]!;
      if (r <= 0) return candidates[i]!;
    }
    return candidates[candidates.length - 1]!;
  }

  private doCut(cam: number, nowMs: number, reason: 'beat' | 'timeout'): number {
    this.currentCam = cam;
    this.lastCutAtMs = nowMs;
    this.log.info(
      { cam, reason, energy: Number(this.energy.toFixed(2)), shotMs: Math.round(this.targetShotMs()) },
      'beat cut',
    );
    void this.cut(cam).catch((err) =>
      this.log.error({ cam, err: (err as Error).message }, 'beat cut FAILED'),
    );
    return cam;
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
