import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { BeatReactiveConfig } from '../src/config.js';
import { BeatReactiveEngine } from '../src/beat-director.js';

const log = pino({ level: 'silent' });

function cfg(over: Partial<BeatReactiveConfig> = {}): BeatReactiveConfig {
  return {
    enabled: true,
    cameras: [1, 2, 3],
    wideCam: 1,
    closeupCam: 2,
    obsInput: 'Music',
    minShotMs: 1000,
    maxShotMs: 4000,
    onsetRiseDb: 6,
    refractoryMs: 250,
    beatGraceMs: 400,
    envelopeAlpha: 0.5,
    energyFloorDb: -45,
    energyCeilDb: -12,
    lowEnergy: 0.3,
    highEnergy: 0.6,
    overridePauseMs: 6000,
    ...over,
  };
}

describe('BeatReactiveEngine', () => {
  it('never cuts before the shot has been held its target length, even on a beat', () => {
    const cut = vi.fn(async () => {});
    const e = new BeatReactiveEngine(cfg(), cut, log, () => 0);
    e.arm(0, 1);
    // Loud sustained level -> high energy -> target ~= minShotMs (1000ms).
    for (let t = 0; t <= 500; t += 50) e.updateAudioLevel('Music', -12, t);
    // A big onset at 600ms — but only 600ms held, < 1000ms target.
    e.updateAudioLevel('Music', 0, 600);
    expect(cut).not.toHaveBeenCalled();
  });

  it('cuts ON a beat once the target shot length has elapsed', () => {
    const cut = vi.fn(async () => {});
    const e = new BeatReactiveEngine(cfg(), cut, log, () => 0);
    e.arm(0, 1);
    // Seed high energy (loud) so target shot ~ minShotMs (1000ms).
    for (let t = 0; t <= 1100; t += 50) e.updateAudioLevel('Music', -12, t);
    // Onset after the target has elapsed -> cut lands here.
    e.updateAudioLevel('Music', -2, 1200);
    expect(cut).toHaveBeenCalledTimes(1);
    expect(cut.mock.calls[0]![0]).not.toBe(1); // never the current cam
  });

  it('grace timeout cuts even with no beat (quiet passage still moves)', () => {
    const cut = vi.fn(async () => {});
    const e = new BeatReactiveEngine(cfg(), cut, log, () => 0);
    e.arm(0, 1);
    // Silence-ish, steady low level -> low energy -> target ~ maxShotMs (4000).
    for (let t = 0; t <= 4000; t += 100) e.updateAudioLevel('Music', -45, t);
    expect(e.tick(4300)).toBeNull(); // < 4000 + 400 grace
    expect(e.tick(4500)).not.toBeNull(); // past target+grace -> timeout cut
  });

  it('high energy shortens shots vs low energy (energy-scaled pacing)', () => {
    const cut = vi.fn(async () => {});
    const loud = new BeatReactiveEngine(cfg(), cut, log, () => 0);
    loud.arm(0, 1);
    for (let t = 0; t <= 200; t += 50) loud.updateAudioLevel('Music', -12, t);
    expect(loud.currentEnergy).toBeGreaterThan(0.9);

    const quiet = new BeatReactiveEngine(cfg(), cut, log, () => 0);
    quiet.arm(0, 1);
    for (let t = 0; t <= 200; t += 50) quiet.updateAudioLevel('Music', -45, t);
    expect(quiet.currentEnergy).toBeLessThan(0.1);
  });

  it('manual cut pauses reactive switching for overridePauseMs', () => {
    const cut = vi.fn(async () => {});
    const e = new BeatReactiveEngine(cfg(), cut, log, () => 0);
    e.arm(0, 1);
    e.noteManualCut(3, 1000); // pause until 7000
    expect(e.program).toBe(3);
    // Even a strong beat well past the target shot is ignored while paused.
    for (let t = 1000; t <= 6000; t += 100) e.updateAudioLevel('Music', -12, t);
    e.updateAudioLevel('Music', 0, 6500);
    expect(cut).not.toHaveBeenCalled();
    expect(e.tick(6500)).toBeNull();
  });

  it('ignores audio from other inputs', () => {
    const cut = vi.fn(async () => {});
    const e = new BeatReactiveEngine(cfg(), cut, log, () => 0);
    e.arm(0, 1);
    for (let t = 0; t <= 2000; t += 50) e.updateAudioLevel('Mic/Aux', 0, t);
    expect(cut).not.toHaveBeenCalled();
    expect(e.currentEnergy).toBe(0); // never moved off the seed floor
  });

  it('respects the onset refractory window (no machine-gun on one loud burst)', () => {
    const cut = vi.fn(async () => {});
    const e = new BeatReactiveEngine(cfg({ minShotMs: 100 }), cut, log, () => 0);
    e.arm(0, 1);
    for (let t = 0; t <= 200; t += 50) e.updateAudioLevel('Music', -12, t);
    // Two onsets 100ms apart — refractory is 250ms, so the 2nd is swallowed.
    e.updateAudioLevel('Music', 0, 300);
    e.updateAudioLevel('Music', 0, 400);
    expect(cut).toHaveBeenCalledTimes(1);
  });

  it('single camera never cuts', () => {
    const cut = vi.fn(async () => {});
    const e = new BeatReactiveEngine(cfg({ cameras: [1] }), cut, log, () => 0);
    e.arm(0, 1);
    for (let t = 0; t <= 5000; t += 100) e.updateAudioLevel('Music', -12, t);
    expect(e.tick(5000)).toBeNull();
    expect(cut).not.toHaveBeenCalled();
  });
});
