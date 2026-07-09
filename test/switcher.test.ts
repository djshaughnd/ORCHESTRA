import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AutoSwitchConfig, SequenceCue } from '../src/config.js';
import { AutoSwitchEngine, CueSequenceEngine, mulToDb } from '../src/switcher.js';

const log = pino({ level: 'silent' });

function settings(over: Partial<AutoSwitchConfig> = {}): AutoSwitchConfig {
  return {
    enabled: true,
    cameras: [1, 2, 3],
    minShotSeconds: 4,
    maxShotSeconds: 8,
    overridePauseSeconds: 20,
    audio: {
      enabled: false,
      obsInput: 'Mic/Aux',
      closeupCam: 2,
      thresholdDb: -30,
      sustainMs: 1500,
    },
    ...over,
  };
}

describe('AutoSwitchEngine', () => {
  it('never cuts when not armed', () => {
    const cut = vi.fn(async () => {});
    const engine = new AutoSwitchEngine(settings(), cut, log, () => 0);
    expect(engine.tick(999_999)).toBeNull();
    expect(cut).not.toHaveBeenCalled();
  });

  it('holds the minimum shot length, then rotates to a different cam', () => {
    const cut = vi.fn(async () => {});
    // rng=0 → shot length = minShotSeconds (4s), always picks first candidate.
    const engine = new AutoSwitchEngine(settings(), cut, log, () => 0);
    engine.arm(0, 1);
    expect(engine.tick(3_999)).toBeNull();
    const cam = engine.tick(4_000);
    expect(cam).not.toBeNull();
    expect(cam).not.toBe(1);
    expect(cut).toHaveBeenCalledWith(cam);
  });

  it('waits up to maxShotSeconds when rng is high', () => {
    const engine = new AutoSwitchEngine(settings(), vi.fn(async () => {}), log, () => 0.9999);
    engine.arm(0, 1);
    expect(engine.tick(7_900)).toBeNull(); // < ~8s shot
    expect(engine.tick(8_100)).not.toBeNull();
  });

  it('manual override pauses auto mode for overridePauseSeconds', () => {
    const engine = new AutoSwitchEngine(settings(), vi.fn(async () => {}), log, () => 0);
    engine.arm(0, 1);
    engine.noteManualCut(3, 1_000); // pause until 21_000
    expect(engine.tick(20_999)).toBeNull();
    const cam = engine.tick(21_001);
    expect(cam).not.toBeNull();
    expect(cam).not.toBe(3); // never re-picks current cam
    expect(engine.program).toBe(cam);
  });

  it('kill switch stops everything instantly', () => {
    const engine = new AutoSwitchEngine(settings(), vi.fn(async () => {}), log, () => 0);
    engine.arm(0, 1);
    engine.disarm();
    expect(engine.isArmed).toBe(false);
    expect(engine.tick(100_000)).toBeNull();
  });

  it('sustained audio favors the closeup cam before the rotation timer', () => {
    const cfg = settings({
      audio: { enabled: true, obsInput: 'Mic/Aux', closeupCam: 2, thresholdDb: -30, sustainMs: 1500 },
    });
    // rng=1 → rotation shot length = 8s, so a 4.5s cut must be the audio rule.
    const engine = new AutoSwitchEngine(cfg, vi.fn(async () => {}), log, () => 0.9999);
    engine.arm(0, 1);
    engine.updateAudioLevel('Mic/Aux', -20, 1_000); // above threshold from t=1s
    expect(engine.tick(2_000)).toBeNull(); // min shot not reached
    expect(engine.tick(4_500)).toBe(2); // min shot ok + sustained 3.5s ≥ 1.5s
  });

  it('audio below threshold resets the sustain window', () => {
    const cfg = settings({
      audio: { enabled: true, obsInput: 'Mic/Aux', closeupCam: 2, thresholdDb: -30, sustainMs: 1500 },
    });
    const engine = new AutoSwitchEngine(cfg, vi.fn(async () => {}), log, () => 0.9999);
    engine.arm(0, 1);
    engine.updateAudioLevel('Mic/Aux', -20, 1_000);
    engine.updateAudioLevel('Mic/Aux', -60, 4_000); // dropped below → reset
    expect(engine.tick(4_500)).toBeNull();
  });

  it('ignores audio from other inputs', () => {
    const cfg = settings({
      audio: { enabled: true, obsInput: 'Mic/Aux', closeupCam: 2, thresholdDb: -30, sustainMs: 1500 },
    });
    const engine = new AutoSwitchEngine(cfg, vi.fn(async () => {}), log, () => 0.9999);
    engine.arm(0, 1);
    engine.updateAudioLevel('Desktop Audio', -5, 1_000);
    expect(engine.tick(4_500)).toBeNull();
  });

  it('single camera never cuts', () => {
    const cut = vi.fn(async () => {});
    const engine = new AutoSwitchEngine(settings({ cameras: [1] }), cut, log, () => 0);
    engine.arm(0);
    expect(engine.tick(100_000)).toBeNull();
    expect(cut).not.toHaveBeenCalled();
  });
});

describe('CueSequenceEngine', () => {
  const cues: SequenceCue[] = [
    { cam: 4, holdMs: 10_000, label: 'wide' },
    { cam: 1, holdMs: 8_000, label: 'slider' },
    { cam: 2, holdMs: 6_000, label: 'overhead' },
  ];

  it('cuts through the script in order on schedule, then finishes', () => {
    const cut = vi.fn(async () => {});
    const engine = new CueSequenceEngine(cues, cut, log);
    engine.arm(0);
    expect(engine.program).toBe(4); // first cue fires immediately on arm
    expect(engine.tick(9_999)).toBeNull();
    expect(engine.tick(10_000)).toBe(1);
    expect(engine.tick(17_999)).toBeNull();
    expect(engine.tick(18_000)).toBe(2);
    expect(engine.isDone).toBe(false);
    expect(engine.tick(23_999)).toBeNull();
    expect(engine.tick(24_000)).toBeNull(); // final cue ends, no cam 4 cut
    expect(engine.isDone).toBe(true);
    expect(engine.isArmed).toBe(false);
    expect(cut).toHaveBeenCalledTimes(3);
    expect(cut.mock.calls.map((c) => c[0])).toEqual([4, 1, 2]);
  });

  it('manual cut aborts the sequence rather than pausing it', () => {
    const engine = new CueSequenceEngine(cues, vi.fn(async () => {}), log);
    engine.arm(0);
    engine.noteManualCut(3, 2_000);
    expect(engine.isArmed).toBe(false);
    expect(engine.tick(100_000)).toBeNull(); // stays dead, script never resumes
  });

  it('an empty cue list never arms', () => {
    const cut = vi.fn(async () => {});
    const engine = new CueSequenceEngine([], cut, log);
    engine.arm(0);
    expect(engine.isArmed).toBe(false);
    expect(cut).not.toHaveBeenCalled();
  });
});

describe('mulToDb', () => {
  it('converts OBS meter magnitudes to dBFS', () => {
    expect(mulToDb(1)).toBe(0);
    expect(mulToDb(0.1)).toBeCloseTo(-20, 5);
    expect(mulToDb(0)).toBe(-100);
  });
});
