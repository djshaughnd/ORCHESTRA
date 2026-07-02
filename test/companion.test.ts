import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { CompanionClient, type FetchFn } from '../src/clients/companion.js';

const log = pino({ level: 'silent' });

function mockFetch(impl?: FetchFn) {
  return vi.fn(impl ?? (async () => ({ ok: true, status: 200 })));
}

/** Let the fire-and-forget promise chain settle. */
const flush = () => new Promise((r) => setImmediate(r));

describe('CompanionClient', () => {
  it('does nothing when disabled', () => {
    const fetchFn = mockFetch();
    const c = new CompanionClient('http://127.0.0.1:8000', false, log, fetchFn);
    c.setVariable('orchestra_health', 'ok');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('POSTs the value to the custom-variable endpoint', () => {
    const fetchFn = mockFetch();
    const c = new CompanionClient('http://127.0.0.1:8000/', true, log, fetchFn);
    c.setVariable('orchestra_health', 'fail');
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/custom-variable/orchestra_health/value',
      expect.objectContaining({ method: 'POST', body: 'fail' }),
    );
  });

  it('pushHealth maps boolean to ok/fail', () => {
    const fetchFn = mockFetch();
    const c = new CompanionClient('http://127.0.0.1:8000', true, log, fetchFn);
    c.pushHealth(true);
    c.pushHealth(false);
    expect(fetchFn.mock.calls[0]?.[1]?.body).toBe('ok');
    expect(fetchFn.mock.calls[1]?.[1]?.body).toBe('fail');
  });

  it('never throws when Companion is unreachable', async () => {
    const fetchFn = mockFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const c = new CompanionClient('http://127.0.0.1:8000', true, log, fetchFn);
    expect(() => c.setVariable('orchestra_health', 'ok')).not.toThrow();
    await flush(); // rejection is swallowed, not unhandled
  });

  it('never throws on a non-2xx response', async () => {
    const fetchFn = mockFetch(async () => ({ ok: false, status: 404 }));
    const c = new CompanionClient('http://127.0.0.1:8000', true, log, fetchFn);
    expect(() => c.setVariable('orchestra_health', 'ok')).not.toThrow();
    await flush();
  });
});
