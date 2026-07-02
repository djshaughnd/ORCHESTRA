import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthReport } from '../src/health.js';
import { HealthMonitor } from '../src/monitor.js';

const log = pino({ level: 'silent' });

const green: HealthReport = { ok: true, checks: { obs: { ok: true, detail: 'up' } } };
const red: HealthReport = { ok: false, checks: { obs: { ok: false, detail: 'down' } } };

describe('HealthMonitor transitions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires onTransition on state changes only, notify on fail/recover only', async () => {
    const reports = [green, red, red, green];
    let i = 0;
    const run = vi.fn(async () => reports[Math.min(i++, reports.length - 1)]!);
    const notify = vi.fn();
    const transitions: boolean[] = [];

    const m = new HealthMonitor(run, log, {
      notify,
      intervalMs: 1_000,
      onTransition: (ok) => transitions.push(ok),
    });
    m.start();
    await vi.advanceTimersByTimeAsync(0); // initial check: green
    await vi.advanceTimersByTimeAsync(1_000); // red — transition + notify
    await vi.advanceTimersByTimeAsync(1_000); // red again — no transition
    await vi.advanceTimersByTimeAsync(1_000); // green — recovery
    m.stop();

    expect(transitions).toEqual([true, false, true]);
    expect(notify).toHaveBeenCalledTimes(2); // fail + recover, no spam
    expect(notify.mock.calls[0]?.[1]).toContain('obs: down');
  });

  it('a throwing transition listener never breaks the loop', async () => {
    const reports = [green, red];
    let i = 0;
    const run = vi.fn(async () => reports[Math.min(i++, reports.length - 1)]!);
    const notify = vi.fn();

    const m = new HealthMonitor(run, log, {
      notify,
      intervalMs: 1_000,
      onTransition: () => {
        throw new Error('listener boom');
      },
    });
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    m.stop();

    expect(run).toHaveBeenCalledTimes(2); // loop kept running
    expect(notify).toHaveBeenCalledTimes(1); // fail notification still fired
  });
});
