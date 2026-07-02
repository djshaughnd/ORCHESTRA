import { exec } from 'node:child_process';
import { statfs } from 'node:fs/promises';

export interface CheckResult {
  ok: boolean;
  detail: string;
}

export interface HealthReport {
  ok: boolean;
  checks: Record<string, CheckResult>;
}

export interface HealthDeps {
  /** Returns OBS version string; throws if unreachable. */
  obsVersion: () => Promise<string>;
  /** Returns free bytes at the recordings root; throws on failure. */
  diskFreeBytes: () => Promise<number>;
  /** Returns true if the NAS host answers; throws on failure. Null = NAS disabled. */
  nasReachable: (() => Promise<boolean>) | null;
  /** OBS skipped/total output frames; throws if unreachable. Null = skip check. */
  obsDroppedFrames?: (() => Promise<{ skipped: number; total: number }>) | null;
  minFreeGB: number;
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function runCheck(fn: () => Promise<CheckResult>, timeoutMs: number, label: string): Promise<CheckResult> {
  try {
    return await withTimeout(fn(), timeoutMs, label);
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * Aggregate health. Runs all checks in parallel with per-check timeouts.
 * NEVER throws — failures come back as {ok:false} per check.
 */
export async function runHealthChecks(deps: HealthDeps): Promise<HealthReport> {
  const timeoutMs = deps.timeoutMs ?? 2_000;

  const entries: Array<[string, Promise<CheckResult>]> = [
    [
      'obs',
      runCheck(
        async () => ({ ok: true, detail: `OBS ${await deps.obsVersion()} reachable` }),
        timeoutMs,
        'obs',
      ),
    ],
    [
      'disk',
      runCheck(
        async () => {
          const free = await deps.diskFreeBytes();
          const freeGB = free / 1024 ** 3;
          const ok = freeGB >= deps.minFreeGB;
          return {
            ok,
            detail: `${freeGB.toFixed(1)} GB free (min ${deps.minFreeGB} GB)`,
          };
        },
        timeoutMs,
        'disk',
      ),
    ],
  ];

  if (deps.nasReachable) {
    entries.push([
      'nas',
      runCheck(
        async () => {
          const up = await deps.nasReachable!();
          return { ok: up, detail: up ? 'NAS reachable' : 'NAS not responding' };
        },
        timeoutMs,
        'nas',
      ),
    ]);
  }

  if (deps.obsDroppedFrames) {
    entries.push([
      'obsFrames',
      runCheck(
        async () => {
          const { skipped, total } = await deps.obsDroppedFrames!();
          const ratio = total > 0 ? skipped / total : 0;
          return {
            ok: ratio < 0.05,
            detail: `${skipped}/${total} frames skipped (${(ratio * 100).toFixed(1)}%)`,
          };
        },
        timeoutMs,
        'obsFrames',
      ),
    ]);
  }

  const results = await Promise.all(entries.map(([, p]) => p));
  const checks: Record<string, CheckResult> = {};
  entries.forEach(([name], i) => (checks[name] = results[i]!));
  return { ok: Object.values(checks).every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------
// Default check implementations
// ---------------------------------------------------------------------------

export async function diskFreeBytesAt(path: string): Promise<number> {
  const s = await statfs(path);
  return s.bavail * s.bsize;
}

export function pingHost(host: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    exec(`ping -c 1 -W 2000 ${JSON.stringify(host)}`, { timeout: 2_500 }, (err) =>
      resolvePromise(!err),
    );
  });
}
