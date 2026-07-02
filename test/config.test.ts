import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

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
