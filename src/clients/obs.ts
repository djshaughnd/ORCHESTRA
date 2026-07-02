import OBSWebSocket from 'obs-websocket-js';
import type { Logger } from 'pino';

export interface ObsRecordStatus {
  active: boolean;
  paused: boolean;
  timecode: string;
  bytes: number;
}

/**
 * OBS WebSocket (v5) client wrapper.
 *
 * - Auto-reconnects with exponential backoff (1s -> 30s cap).
 * - Fails fast with a clear error when disconnected — never hangs a request.
 * - On reconnect, emits `reconnected` so callers can reconcile state.
 */
export class ObsClient {
  private obs = new OBSWebSocket();
  private connected = false;
  private stopped = false;
  private backoffMs = 1_000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectListeners: Array<() => void> = [];

  constructor(
    private url: string,
    private password: string,
    private log: Logger,
  ) {
    this.obs.on('ConnectionClosed', () => {
      if (this.connected) this.log.warn('OBS WebSocket connection closed');
      this.connected = false;
      this.scheduleReconnect();
    });
  }

  /** Register a callback fired after every successful (re)connect. */
  onReconnect(fn: () => void): void {
    this.reconnectListeners.push(fn);
  }

  /** Subscribe to raw OBS events (e.g. RecordStateChanged). */
  on(event: string, handler: (data: never) => void): void {
    (this.obs as OBSWebSocket).on(event as never, handler as never);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.tryConnect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      await this.obs.disconnect();
    } catch {
      /* already disconnected */
    }
    this.connected = false;
  }

  private async tryConnect(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.obs.connect(this.url, this.password || undefined);
      this.connected = true;
      this.backoffMs = 1_000;
      this.log.info({ url: this.url }, 'connected to OBS WebSocket');
      for (const fn of this.reconnectListeners) {
        try {
          fn();
        } catch (err) {
          this.log.error({ err }, 'obs reconnect listener failed');
        }
      }
    } catch (err) {
      this.connected = false;
      this.log.warn(
        { err: (err as Error).message, retryInMs: this.backoffMs },
        'OBS connect failed, will retry',
      );
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      void this.tryConnect();
    }, this.backoffMs);
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error('OBS is not connected (WebSocket down) — command rejected fast');
    }
  }

  async call<T = Record<string, unknown>>(
    request: string,
    data?: Record<string, unknown>,
  ): Promise<T> {
    this.assertConnected();
    // obs-websocket-js types are keyed by request name; we keep a generic escape hatch.
    return (await (this.obs.call as unknown as (r: string, d?: unknown) => Promise<unknown>)(
      request,
      data,
    )) as T;
  }

  async getVersion(): Promise<string> {
    const res = await this.call<{ obsVersion: string }>('GetVersion');
    return res.obsVersion;
  }

  async setRecordDirectory(path: string): Promise<void> {
    await this.call('SetRecordDirectory', { recordDirectory: path });
  }

  async startRecord(): Promise<void> {
    await this.call('StartRecord');
  }

  async stopRecord(): Promise<string | null> {
    const res = await this.call<{ outputPath?: string }>('StopRecord');
    return res.outputPath ?? null;
  }

  async getRecordStatus(): Promise<ObsRecordStatus> {
    const res = await this.call<{
      outputActive: boolean;
      outputPaused: boolean;
      outputTimecode: string;
      outputBytes: number;
    }>('GetRecordStatus');
    return {
      active: res.outputActive,
      paused: res.outputPaused,
      timecode: res.outputTimecode,
      bytes: res.outputBytes,
    };
  }
}
