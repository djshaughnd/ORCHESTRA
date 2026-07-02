import { describe, expect, it } from 'vitest';
import { runHealthChecks } from '../src/health.js';

const GB = 1024 ** 3;

describe('health aggregation', () => {
  it('all green when everything passes', async () => {
    const report = await runHealthChecks({
      obsVersion: async () => '30.2.3',
      diskFreeBytes: async () => 200 * GB,
      nasReachable: async () => true,
      minFreeGB: 50,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.obs?.ok).toBe(true);
    expect(report.checks.disk?.ok).toBe(true);
    expect(report.checks.nas?.ok).toBe(true);
  });

  it('fails overall when disk is below threshold', async () => {
    const report = await runHealthChecks({
      obsVersion: async () => '30.2.3',
      diskFreeBytes: async () => 10 * GB,
      nasReachable: null,
      minFreeGB: 50,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.disk?.ok).toBe(false);
    expect(report.checks.disk?.detail).toContain('10.0 GB');
  });

  it('skips nas check when disabled', async () => {
    const report = await runHealthChecks({
      obsVersion: async () => '30.2.3',
      diskFreeBytes: async () => 100 * GB,
      nasReachable: null,
      minFreeGB: 50,
    });
    expect(report.checks.nas).toBeUndefined();
  });

  it('never throws — a throwing check becomes ok:false', async () => {
    const report = await runHealthChecks({
      obsVersion: async () => {
        throw new Error('OBS is not connected');
      },
      diskFreeBytes: async () => 100 * GB,
      nasReachable: null,
      minFreeGB: 50,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.obs?.detail).toContain('not connected');
  });

  it('enforces per-check timeout', async () => {
    const report = await runHealthChecks({
      obsVersion: () => new Promise(() => {}), // hangs forever
      diskFreeBytes: async () => 100 * GB,
      nasReachable: null,
      minFreeGB: 50,
      timeoutMs: 50,
    });
    expect(report.checks.obs?.ok).toBe(false);
    expect(report.checks.obs?.detail).toContain('timed out');
    expect(report.checks.disk?.ok).toBe(true);
  });
});
