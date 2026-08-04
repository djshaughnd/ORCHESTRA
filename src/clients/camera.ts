import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type { CameraSettings } from '../config.js';

const run = promisify(execFile);

export interface CameraState {
  /** Last successful read of the camera's live settings. */
  model: string | null;
  iso: number | null;
  fnumber: number | null;
  shutter: number | null;
  exposureMode: number | null;
  /** ISO 8601 of the last successful read/apply. */
  updatedAt: string | null;
  /** Set when the last operation failed (so the UI can show why). */
  error: string | null;
  /** What the daemon last pushed to the camera (per-profile exposure lock). */
  lastApplied: CameraSettings | null;
}

interface RawResult {
  ok: boolean;
  model?: string;
  cameras?: number;
  settings?: Record<string, number>;
  error?: string;
}

/**
 * Sony camera control (V3) — shells out to the native `orchestra-camera`
 * binary (Camera Remote SDK). Native code stays out of the daemon; this
 * wrapper parses its JSON and keeps the last known state for /status.
 *
 * Every call is best-effort: a missing binary, unplugged camera, or a camera
 * not in PC Remote mode must NEVER break a recording. Failures are recorded
 * in `state.error` and logged, never thrown at the caller.
 */
export class CameraClient {
  private state: CameraState = {
    model: null,
    iso: null,
    fnumber: null,
    shutter: null,
    exposureMode: null,
    updatedAt: null,
    error: null,
    lastApplied: null,
  };

  constructor(
    private binPath: string,
    private enabled: boolean,
    private log: Logger,
    private timeoutMs = 20_000,
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  get snapshot(): CameraState {
    return { ...this.state };
  }

  private async exec(args: string[]): Promise<RawResult | null> {
    try {
      const { stdout } = await run(this.binPath, args, { timeout: this.timeoutMs });
      // The tool can print several JSON lines (set then get) — take the last.
      const lines = stdout.trim().split('\n').filter(Boolean);
      const last = lines[lines.length - 1];
      return last ? (JSON.parse(last) as RawResult) : null;
    } catch (err) {
      const msg = (err as Error).message;
      this.state.error = msg;
      this.log.warn({ err: msg, args }, 'camera command failed');
      return null;
    }
  }

  private absorb(res: RawResult | null): boolean {
    if (!res || !res.ok) {
      this.state.error = res?.error ?? this.state.error ?? 'camera unavailable';
      return false;
    }
    const s = res.settings ?? {};
    this.state = {
      ...this.state,
      model: res.model ?? this.state.model,
      iso: s.iso ?? null,
      fnumber: s.fnumber ?? null,
      shutter: s.shutter ?? null,
      exposureMode: s.exposureMode ?? null,
      updatedAt: new Date().toISOString(),
      error: null,
    };
    return true;
  }

  /**
   * Human-readable decode of the raw SDK values, for the dashboard.
   * fnumber is f-stop x100; shutter is a raw SDK code; exposureMode 0x8053
   * is Movie/Manual on the A7 IV.
   */
  static describe(s: CameraState): { aperture: string; mode: string } {
    const aperture = s.fnumber != null ? `f/${(s.fnumber / 100).toFixed(1)}` : '—';
    const mode =
      s.exposureMode === 0x8053 ? 'Movie M'
      : s.exposureMode === 0x8050 ? 'Movie P'
      : s.exposureMode === 1 ? 'Photo M'
      : s.exposureMode != null ? `mode ${s.exposureMode}` : '—';
    return { aperture, mode };
  }

  /** Read the camera's live settings into state. Returns false on failure. */
  async refresh(): Promise<boolean> {
    if (!this.enabled) return false;
    return this.absorb(await this.exec(['get']));
  }

  /**
   * Push a profile's exposure lock to the camera, then read back what actually
   * took effect. Best-effort — never throws.
   */
  async apply(settings: CameraSettings): Promise<boolean> {
    if (!this.enabled) return false;
    const args = ['set'];
    if (settings.iso != null) args.push('--iso', String(settings.iso));
    if (settings.shutter != null) args.push('--shutter', String(settings.shutter));
    if (settings.fnumber != null) args.push('--fnumber', String(settings.fnumber));
    if (args.length === 1) return false; // nothing to apply

    this.log.info({ settings }, 'applying camera exposure lock');
    const ok = this.absorb(await this.exec(args));
    if (ok) this.state.lastApplied = { ...settings };
    return ok;
  }
}
