import { describe, expect, it } from 'vitest';
import { parseConfig, resolveProfile, volumeRootOf } from '../src/config.js';

const valid = {
  recordingsRoot: '/tmp/recordings',
  nas: { enabled: false, host: '', remotePath: '' },
  obs: { url: 'ws://127.0.0.1:4455', password: 'x' },
  atem: { ip: '192.168.1.60' },
  health: { minFreeGB: 50 },
  session: { nameTemplate: '{date}_{time}_{slug}' },
};

describe('config validation', () => {
  it('accepts a valid config and applies defaults', () => {
    const cfg = parseConfig(valid);
    expect(cfg.http.port).toBe(8722);
    expect(cfg.nas.rsyncFlags).toContain('--checksum');
    expect(cfg.atem.enabled).toBe(false);
    expect(cfg.activeProfile).toBe('default');
    expect(cfg.obs.chapterMarkers).toBe(true);
    expect(cfg.companion.enabled).toBe(false);
    expect(cfg.companion.url).toBe('http://127.0.0.1:8000');
  });

  it('expands ~ in recordingsRoot', () => {
    const cfg = parseConfig({ ...valid, recordingsRoot: '~/Recordings' });
    expect(cfg.recordingsRoot).not.toContain('~');
    expect(cfg.recordingsRoot.endsWith('/Recordings')).toBe(true);
  });

  it('rejects missing atem.ip with a readable message', () => {
    const { atem: _drop, ...rest } = valid;
    expect(() => parseConfig(rest)).toThrowError(/atem/);
  });

  it('rejects negative minFreeGB', () => {
    expect(() =>
      parseConfig({ ...valid, health: { minFreeGB: -1 } }),
    ).toThrowError(/minFreeGB/);
  });

  it('rejects nas.enabled=true with empty host', () => {
    expect(() =>
      parseConfig({ ...valid, nas: { enabled: true, host: '', remotePath: '' } }),
    ).toThrowError(/nas/);
  });
});

describe('volumeRootOf', () => {
  it('extracts the volume root from an external path', () => {
    expect(volumeRootOf('/Volumes/T9-Content/RECORDING_SESSIONS')).toBe('/Volumes/T9-Content');
    expect(volumeRootOf('/Volumes/T9-Content')).toBe('/Volumes/T9-Content');
  });

  it('returns null for internal-disk paths', () => {
    expect(volumeRootOf('/Users/x/Recordings')).toBeNull();
    expect(volumeRootOf('/Volumes')).toBeNull();
  });
});

describe('profiles (V2)', () => {
  it('applies profile defaults', () => {
    const cfg = parseConfig({ ...valid, activeProfile: 'podcast', profiles: { podcast: {} } });
    const p = cfg.profiles.podcast!;
    expect(p.autoSwitch.enabled).toBe(false);
    expect(p.autoSwitch.minShotSeconds).toBe(4);
    expect(p.fileTemplate).toBe('{date}_{profile}_take{take}');
    expect(p.atemDefaultCam).toBe(1);
  });

  it('rejects an activeProfile that is not defined', () => {
    expect(() => parseConfig({ ...valid, activeProfile: 'nope' })).toThrowError(
      /activeProfile/,
    );
  });

  it('rejects maxShotSeconds < minShotSeconds', () => {
    expect(() =>
      parseConfig({
        ...valid,
        profiles: { p: { autoSwitch: { minShotSeconds: 10, maxShotSeconds: 5 } } },
      }),
    ).toThrowError(/maxShotSeconds/);
  });

  it('resolveProfile falls back to defaults for "default"', () => {
    const cfg = parseConfig(valid);
    const p = resolveProfile(cfg, 'default');
    expect(p.autoSwitch.cameras).toEqual([1, 2]);
  });
});
