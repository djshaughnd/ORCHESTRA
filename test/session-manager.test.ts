import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, SessionManager, type ObsForSession } from '../src/session.js';

function mockObs(overrides: Partial<ObsForSession> = {}): ObsForSession {
  return {
    isConnected: true,
    setRecordDirectory: vi.fn(async () => {}),
    startRecord: vi.fn(async () => {}),
    stopRecord: vi.fn(async () => '/tmp/out.mkv'),
    getRecordStatus: vi.fn(async () => ({ active: true })),
    ...overrides,
  };
}

const tpl = (t: string) => () => t;

describe('SessionManager state machine', () => {
  let root: string;
  const log = pino({ level: 'silent' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orchestra-test-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('start creates folder, sets OBS record dir, returns id+path', async () => {
    const obs = mockObs();
    const sync = vi.fn();
    const mgr = new SessionManager(root, tpl('{date}_{time}_{slug}'), obs, sync, log);
    const { sessionId, path } = await mgr.start('Test Take', 'podcast');
    expect(sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(path.startsWith(root)).toBe(true);
    expect(obs.setRecordDirectory).toHaveBeenCalledWith(path);
  });

  it('resolves the name template per profile', async () => {
    const resolver = vi.fn(() => '{profile}_{slug}');
    const mgr = new SessionManager(root, resolver, mockObs(), vi.fn(), log);
    const { path } = await mgr.start('jam', 'music');
    expect(resolver).toHaveBeenCalledWith('music');
    expect(path.endsWith('music_jam')).toBe(true);
  });

  it('409s on double start', async () => {
    const mgr = new SessionManager(root, tpl('{slug}'), mockObs(), vi.fn(), log);
    await mgr.start('a');
    await expect(mgr.start('b')).rejects.toBeInstanceOf(ConflictError);
  });

  it('mark without session throws ConflictError', () => {
    const mgr = new SessionManager(root, tpl('{slug}'), mockObs(), vi.fn(), log);
    expect(() => mgr.mark('x')).toThrowError(ConflictError);
  });

  it('take counter increments per finished take', async () => {
    const mgr = new SessionManager(root, tpl('{slug}'), mockObs(), vi.fn(), log);
    expect(mgr.nextTakeNumber()).toBe(0); // no session
    await mgr.start('a');
    expect(mgr.nextTakeNumber()).toBe(1);
    expect(mgr.nextTakeNumber()).toBe(2);
  });

  it('end stops active recording, writes manifest before firing sync, clears session', async () => {
    const obs = mockObs();
    const order: string[] = [];
    const sync = vi.fn((sessionPath: string) => {
      // Manifest must already exist when sync fires (crash-safety).
      const manifest = JSON.parse(readFileSync(join(sessionPath, 'session.json'), 'utf8'));
      expect(manifest.sessionId).toBeTruthy();
      order.push('sync');
    });
    const mgr = new SessionManager(root, tpl('{slug}'), obs, sync, log);
    await mgr.start('ep1');
    mgr.mark('intro');
    const manifest = await mgr.end();
    order.push('returned');

    expect(obs.stopRecord).toHaveBeenCalled();
    expect(manifest.markers).toHaveLength(1);
    expect(manifest.files).toContain('/tmp/out.mkv');
    expect(order).toEqual(['sync', 'returned']);
    expect(mgr.activeSession).toBeNull();
  });

  it('end succeeds even when OBS is down (stop failure never blocks)', async () => {
    const obs = mockObs({
      isConnected: false,
      getRecordStatus: vi.fn(async () => {
        throw new Error('down');
      }),
    });
    const mgr = new SessionManager(root, tpl('{slug}'), obs, vi.fn(), log);
    await mgr.start('ep2');
    const manifest = await mgr.end();
    expect(manifest.endedAt).toBeTruthy();
    expect(mgr.activeSession).toBeNull();
  });

  it('stopRecord always attempts and never throws', async () => {
    const obs = mockObs({
      stopRecord: vi.fn(async () => {
        throw new Error('not recording');
      }),
    });
    const mgr = new SessionManager(root, tpl('{slug}'), obs, vi.fn(), log);
    // No session active — still attempts, still resolves.
    await expect(mgr.stopRecord()).resolves.toBeNull();
    expect(obs.stopRecord).toHaveBeenCalled();
  });
});
