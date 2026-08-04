import { createDecipheriv } from 'node:crypto';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  AmaranClient,
  generateAmaranToken,
  type AmaranSocket,
} from '../src/clients/amaran.js';

const log = pino({ level: 'silent' });
const secret = Buffer.alloc(32, 7).toString('base64');

type Listener = (...args: unknown[]) => void;

function createSocket(
  responder: (request: Record<string, unknown>) => Record<string, unknown>,
): AmaranSocket & { open: () => void; sent: string[] } {
  const listeners = new Map<string, Listener[]>();
  const socket = {
    readyState: 0,
    sent: [] as string[],
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return socket;
    },
    send(data: string) {
      socket.sent.push(data);
      const request = JSON.parse(data) as Record<string, unknown>;
      const response = JSON.stringify(responder(request));
      queueMicrotask(() => listeners.get('message')?.forEach((listener) => listener(response)));
    },
    close() {
      socket.readyState = 3;
      listeners.get('close')?.forEach((listener) => listener());
    },
    open() {
      socket.readyState = 1;
      listeners.get('open')?.forEach((listener) => listener());
    },
  };
  return socket as unknown as AmaranSocket & { open: () => void; sent: string[] };
}

function clientWithSocket(socket: AmaranSocket & { open: () => void }) {
  return new AmaranClient(
    {
      enabled: true,
      url: 'ws://127.0.0.1:12345',
      secret,
      requestTimeoutMs: 100,
      minRequestIntervalMs: 0,
    },
    log,
    () => {
      queueMicrotask(() => socket.open());
      return socket;
    },
  );
}

describe('generateAmaranToken', () => {
  it('encrypts the request timestamp with AES-256-GCM', () => {
    const iv = Buffer.alloc(12, 3);
    const token = Buffer.from(generateAmaranToken(secret, 1_721_234_567, iv), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(secret, 'base64'), token.subarray(0, 12));
    decipher.setAuthTag(token.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(token.subarray(28)), decipher.final()]);
    expect(plaintext.toString()).toBe('1721234567');
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => generateAmaranToken(Buffer.alloc(16).toString('base64'))).toThrow(/32-byte/);
  });
});

describe('AmaranClient read-only discovery', () => {
  it('discovers fixtures without transmitting the API secret', async () => {
    const socket = createSocket((request) => ({
      code: 0,
      message: 'ok',
      version: 2,
      type: 'response',
      request_id: request.request_id,
      action: request.action,
      data: [{ id: 'fixture-1', name: '#1 KEY', node_id: 'fixture-1' }],
    }));
    const client = clientWithSocket(socket);

    await expect(client.listFixtures()).resolves.toEqual([
      { id: 'fixture-1', name: '#1 KEY', nodeId: 'fixture-1' },
    ]);
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).not.toContain(secret);
    expect(JSON.parse(socket.sent[0]!) as Record<string, unknown>).toMatchObject({
      version: 2,
      type: 'request',
      action: 'get_fixture_list',
      client_id: 'orchestra',
    });
    expect(client.status).not.toHaveProperty('secret');
  });

  it('surfaces an API error without leaking credentials', async () => {
    const socket = createSocket((request) => ({
      code: 1002,
      message: 'token expired',
      type: 'response',
      request_id: request.request_id,
      action: request.action,
    }));
    const client = clientWithSocket(socket);
    await expect(client.getProtocolVersions()).rejects.toThrow(/token expired/);
  });

  it('reads CCT state without exposing a write method', async () => {
    const socket = createSocket((request) => ({
      code: 0,
      message: 'ok',
      type: 'response',
      request_id: request.request_id,
      action: request.action,
      data: { cct: 5000, intensity: 200, gm: 100 },
    }));
    const client = clientWithSocket(socket);
    await expect(client.getCct('fixture-1')).resolves.toEqual({
      cct: 5000,
      intensity: 200,
      gm: 100,
    });
  });

  it('does not create a socket while disabled', async () => {
    const factory = vi.fn();
    const client = new AmaranClient(
      {
        enabled: false,
        url: 'ws://127.0.0.1:12345',
        requestTimeoutMs: 100,
        minRequestIntervalMs: 200,
      },
      log,
      factory,
    );
    await expect(client.getProtocolVersions()).rejects.toThrow(/disabled/);
    expect(factory).not.toHaveBeenCalled();
  });
});
