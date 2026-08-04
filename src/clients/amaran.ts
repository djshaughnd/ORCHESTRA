import { createCipheriv, randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import WebSocket from 'ws';

export interface AmaranFixture {
  id: string;
  name: string;
  nodeId: string;
}

export interface AmaranScene {
  id: string;
  name: string;
  fixtures: AmaranFixture[];
  groups: AmaranFixture[];
}

export interface AmaranCctState {
  cct: number;
  intensity: number;
  gm?: number;
}

interface AmaranResponse<T = unknown> {
  code: number;
  message: string;
  type: 'response';
  request_id?: number | string;
  action: string;
  data?: T;
}

interface AmaranEvent {
  type: 'event';
  event: string;
  node_id?: string;
  data?: unknown;
}

export interface AmaranSocket {
  readonly readyState: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: unknown) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  send(data: string): void;
  close(): void;
}

export type AmaranSocketFactory = (url: string) => AmaranSocket;

export interface AmaranClientOptions {
  enabled: boolean;
  url: string;
  secret?: string;
  requestTimeoutMs: number;
  minRequestIntervalMs: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SOCKET_OPEN = 1;

/**
 * Build the short-lived request token required by amaran Desktop OpenAPI v2.
 * The API secret is never placed on the wire. The encrypted timestamp token is
 * valid for ten seconds, so a fresh token is generated for every request.
 */
export function generateAmaranToken(
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  iv: Buffer = randomBytes(12),
): string {
  const key = Buffer.from(secret, 'base64');
  if (key.length !== 32) {
    throw new Error('amaran OpenAPI secret must be a base64-encoded 32-byte key');
  }
  if (iv.length !== 12) throw new Error('amaran token IV must be 12 bytes');

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(Math.floor(nowSeconds)), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function dataToText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data) && data.every(Buffer.isBuffer)) {
    return Buffer.concat(data as Buffer[]).toString('utf8');
  }
  return String(data);
}

function normalizeFixture(value: unknown): AmaranFixture {
  if (!value || typeof value !== 'object') throw new Error('invalid fixture returned by amaran');
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.name !== 'string') {
    throw new Error('invalid fixture returned by amaran');
  }
  const nodeId = typeof item.node_id === 'string' ? item.node_id : item.id;
  return { id: item.id, name: item.name, nodeId };
}

/**
 * Authenticated client for amaran Desktop's local WebSocket API.
 *
 * Requests are serialized and kept at least minRequestIntervalMs apart. The
 * vendor documents a 200 ms device-processing interval; honoring it here keeps
 * scene commands deterministic and prevents intermediate values being dropped.
 */
export class AmaranClient {
  private socket: AmaranSocket | null = null;
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private lastSentAt = 0;
  private requestQueue: Promise<unknown> = Promise.resolve();
  private lastEvent: AmaranEvent | null = null;

  constructor(
    private options: AmaranClientOptions,
    private log: Logger,
    private socketFactory: AmaranSocketFactory = (url) =>
      new WebSocket(url) as unknown as AmaranSocket,
  ) {}

  get isEnabled(): boolean {
    return this.options.enabled;
  }

  get isConnected(): boolean {
    return this.socket?.readyState === SOCKET_OPEN;
  }

  get status(): {
    enabled: boolean;
    connected: boolean;
    url: string;
    lastEvent: { event: string; nodeId?: string } | null;
  } {
    const lastEvent = this.lastEvent
      ? {
          event: this.lastEvent.event,
          ...(this.lastEvent.node_id ? { nodeId: this.lastEvent.node_id } : {}),
        }
      : null;
    return {
      enabled: this.options.enabled,
      connected: this.isConnected,
      url: this.options.url,
      lastEvent,
    };
  }

  /** Best-effort boot connection. Studio recording must work without lighting. */
  async start(): Promise<void> {
    if (!this.options.enabled) return;
    try {
      await this.connect();
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'amaran unavailable at boot');
    }
  }

  async connect(): Promise<void> {
    if (!this.options.enabled) throw new Error('amaran integration is disabled');
    if (!this.options.secret) {
      throw new Error('amaran is enabled but its configured secret environment variable is empty');
    }
    // Validate without ever logging or transmitting the secret.
    generateAmaranToken(this.options.secret);
    if (this.isConnected) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = this.socketFactory(this.options.url);
      this.socket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`amaran connection timed out after ${this.options.requestTimeoutMs}ms`));
      }, this.options.requestTimeoutMs);

      socket.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.log.info({ url: this.options.url }, 'connected to amaran Desktop');
        resolve();
      });
      socket.on('message', (data) => this.onMessage(data));
      socket.on('error', (err) => {
        this.log.warn({ err: err.message }, 'amaran WebSocket error');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
      socket.on('close', () => {
        this.socket = null;
        this.rejectPending(new Error('amaran connection closed'));
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('amaran connection closed before opening'));
        }
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async stop(): Promise<void> {
    this.rejectPending(new Error('amaran client stopped'));
    this.socket?.close();
    this.socket = null;
  }

  async getProtocolVersions(): Promise<number[]> {
    return this.request<number[]>('get_protocol_versions');
  }

  async listFixtures(): Promise<AmaranFixture[]> {
    const values = await this.request<unknown[]>('get_fixture_list');
    if (!Array.isArray(values)) throw new Error('invalid fixture list returned by amaran');
    return values.map(normalizeFixture);
  }

  async listDevices(): Promise<AmaranFixture[]> {
    const values = await this.request<unknown[]>('get_device_list');
    if (!Array.isArray(values)) throw new Error('invalid device list returned by amaran');
    return values.map(normalizeFixture);
  }

  async listScenes(): Promise<AmaranScene[]> {
    const values = await this.request<unknown[]>('get_scene_list');
    if (!Array.isArray(values)) throw new Error('invalid scene list returned by amaran');
    return values.map((value) => {
      if (!value || typeof value !== 'object') throw new Error('invalid scene returned by amaran');
      const item = value as Record<string, unknown>;
      if (typeof item.id !== 'string' || typeof item.name !== 'string') {
        throw new Error('invalid scene returned by amaran');
      }
      return {
        id: item.id,
        name: item.name,
        fixtures: Array.isArray(item.fixtures) ? item.fixtures.map(normalizeFixture) : [],
        groups: Array.isArray(item.groups) ? item.groups.map(normalizeFixture) : [],
      };
    });
  }

  async getSleep(nodeId: string): Promise<boolean> {
    const value = await this.request<unknown>('get_sleep', nodeId);
    if (typeof value !== 'boolean') throw new Error('invalid sleep state returned by amaran');
    return value;
  }

  async getCct(nodeId: string): Promise<AmaranCctState> {
    const value = await this.request<unknown>('get_cct', nodeId);
    if (!value || typeof value !== 'object') throw new Error('invalid CCT state returned by amaran');
    const state = value as Record<string, unknown>;
    if (typeof state.cct !== 'number' || typeof state.intensity !== 'number') {
      throw new Error('invalid CCT state returned by amaran');
    }
    return {
      cct: state.cct,
      intensity: state.intensity,
      ...(typeof state.gm === 'number' ? { gm: state.gm } : {}),
    };
  }

  private request<T>(action: string, nodeId?: string, args?: Record<string, unknown>): Promise<T> {
    const operation = this.requestQueue.then(async () => {
      await this.connect();
      const waitMs = Math.max(
        0,
        this.lastSentAt + this.options.minRequestIntervalMs - Date.now(),
      );
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

      const socket = this.socket;
      const secret = this.options.secret;
      if (!socket || socket.readyState !== SOCKET_OPEN || !secret) {
        throw new Error('amaran is not connected');
      }

      const requestId = this.nextRequestId++;
      const payload = {
        version: 2,
        type: 'request',
        client_id: 'orchestra',
        request_id: requestId,
        ...(nodeId ? { node_id: nodeId } : {}),
        action,
        ...(args ? { args } : {}),
        token: generateAmaranToken(secret),
      };

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(String(requestId));
          reject(new Error(`amaran ${action} timed out after ${this.options.requestTimeoutMs}ms`));
        }, this.options.requestTimeoutMs);
        this.pending.set(String(requestId), {
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
        try {
          socket.send(JSON.stringify(payload));
          this.lastSentAt = Date.now();
        } catch (err) {
          clearTimeout(timer);
          this.pending.delete(String(requestId));
          reject(err as Error);
        }
      });
    });
    this.requestQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private onMessage(data: unknown): void {
    let message: AmaranResponse | AmaranEvent;
    try {
      message = JSON.parse(dataToText(data)) as AmaranResponse | AmaranEvent;
    } catch {
      this.log.warn('ignored malformed message from amaran');
      return;
    }
    if (message.type === 'event') {
      this.lastEvent = message;
      return;
    }
    if (message.type !== 'response' || message.request_id === undefined) return;

    const pending = this.pending.get(String(message.request_id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(String(message.request_id));
    if (message.code !== 0) {
      pending.reject(new Error(`amaran ${message.action} failed (${message.code}): ${message.message}`));
      return;
    }
    pending.resolve(message.data);
  }

  private rejectPending(err: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(err);
    }
    this.pending.clear();
  }
}
