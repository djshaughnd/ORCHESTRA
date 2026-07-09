import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureWatchdog, FreezeDetector } from '../src/capture-watchdog.js';

const log = pino({ level: 'silent' });

describe('FreezeDetector', () => {
  it('reports live while frame hashes keep changing', () => {
    const d = new FreezeDetector(4000);
    d.reset(0);
    expect(d.sample('a', 1000).frozen).toBe(false);
    expect(d.sample('b', 2000).frozen).toBe(false);
    expect(d.sample('c', 6000).frozen).toBe(false); // changed at 6000, clock resets
  });

  it('reports frozen once the hash stops changing for freezeMs', () => {
    const d = new FreezeDetector(4000);
    d.reset(0);
    d.sample('a', 1000); // last change at 1000
    expect(d.sample('a', 4000).frozen).toBe(false); // 3s unchanged
    expect(d.sample('a', 5000).frozen).toBe(true); // 4s unchanged -> frozen
    expect(d.sample('a', 5000).frozenMs).toBe(4000);
  });

  it('treats an unreadable frame (null) as not-changing', () => {
    const d = new FreezeDetector(4000);
    d.reset(0);
    d.sample('a', 1000);
    expect(d.sample(null, 5000).frozen).toBe(true); // device dropped -> frozen
  });

  it('recovers when the hash changes again', () => {
    const d = new FreezeDetector(4000);
    d.reset(0);
    d.sample('a', 1000);
    expect(d.sample('a', 5000).frozen).toBe(true);
    expect(d.sample('b', 5500).frozen).toBe(false); // new frame -> live again
  });
});

describe('CaptureWatchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires onFreeze once on transition and onRecover when the feed returns', async () => {
    // Frame sequence: two live frames, then stuck, then live again.
    const frames = ['a', 'b', 'x', 'x', 'x', 'x', 'c'];
    let i = 0;
    const grabFrame = vi.fn(async () => frames[Math.min(i++, frames.length - 1)] ?? null);
    const onFreeze = vi.fn();
    const onRecover = vi.fn();
    const notify = vi.fn();

    const wd = new CaptureWatchdog({
      grabFrame,
      onFreeze,
      onRecover,
      pollMs: 1000,
      freezeSeconds: 3,
      log,
      notify,
    });
    wd.start();

    // Advance 7 polls (~7s). Stuck 'x' begins at poll 3; frozen after 3s of no change.
    for (let p = 0; p < 7; p++) await vi.advanceTimersByTimeAsync(1000);
    wd.stop();

    expect(onFreeze).toHaveBeenCalledTimes(1);
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalled();
  });

  it('runs the recover hook on freeze when provided', async () => {
    const grabFrame = vi.fn(async () => 'stuck');
    const recover = vi.fn(async () => {});
    const wd = new CaptureWatchdog({
      grabFrame,
      onFreeze: vi.fn(),
      onRecover: vi.fn(),
      recover,
      pollMs: 1000,
      freezeSeconds: 2,
      log,
      notify: vi.fn(),
    });
    wd.start();
    for (let p = 0; p < 4; p++) await vi.advanceTimersByTimeAsync(1000);
    wd.stop();
    expect(recover).toHaveBeenCalledTimes(1); // once, on the freeze transition
  });

  it('a throwing grabFrame is treated as a freeze signal, never crashes the loop', async () => {
    const grabFrame = vi.fn(async () => {
      throw new Error('device gone');
    });
    const onFreeze = vi.fn();
    const wd = new CaptureWatchdog({
      grabFrame,
      onFreeze,
      onRecover: vi.fn(),
      pollMs: 1000,
      freezeSeconds: 2,
      log,
      notify: vi.fn(),
    });
    wd.start();
    for (let p = 0; p < 4; p++) await vi.advanceTimersByTimeAsync(1000);
    wd.stop();
    expect(onFreeze).toHaveBeenCalledTimes(1);
    expect(grabFrame).toHaveBeenCalled();
  });
});
