import type { Logger } from 'pino';

export interface AtemClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  cut(cameraInput: number): Promise<void>;
  readonly isConnected: boolean;
}

/**
 * Used when atem.enabled = false: Companion drives the ATEM directly and
 * the daemon's /cut + auto-switch are unavailable by design.
 */
export class StubAtemClient implements AtemClient {
  readonly isConnected = false;

  constructor(
    private ip: string,
    private log: Logger,
  ) {}

  async connect(): Promise<void> {
    this.log.info({ ip: this.ip }, 'ATEM control disabled (atem.enabled=false) — Companion drives the ATEM');
  }

  async disconnect(): Promise<void> {
    /* no-op */
  }

  async cut(cameraInput: number): Promise<void> {
    throw new Error(
      `ATEM cut to ${cameraInput} unavailable: set atem.enabled=true in studio.yaml for daemon-driven cuts`,
    );
  }
}

/**
 * Real ATEM control via atem-connection (V2). The library handles its own
 * reconnection; we just track connection state and fail cuts fast when down.
 * Loaded lazily so the daemon boots even if the package is missing while
 * atem.enabled=false.
 */
export class AtemConnectionClient implements AtemClient {
  private atem: import('atem-connection').Atem | null = null;
  private connected = false;

  constructor(
    private ip: string,
    private log: Logger,
  ) {}

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    const { Atem } = await import('atem-connection');
    const atem = new Atem();
    this.atem = atem;
    atem.on('connected', () => {
      this.connected = true;
      this.log.info({ ip: this.ip }, 'ATEM connected');
    });
    atem.on('disconnected', () => {
      this.connected = false;
      this.log.warn('ATEM disconnected — library will auto-reconnect');
    });
    atem.on('error', (e: unknown) => this.log.error({ err: String(e) }, 'ATEM error'));
    await atem.connect(this.ip);
  }

  async disconnect(): Promise<void> {
    if (this.atem) await this.atem.disconnect();
    this.connected = false;
  }

  async cut(cameraInput: number): Promise<void> {
    if (!this.atem || !this.connected) {
      throw new Error('ATEM not connected — cut rejected fast');
    }
    await this.atem.changeProgramInput(cameraInput, 0);
    this.log.info({ cam: cameraInput }, 'ATEM program cut');
  }
}

export function createAtemClient(ip: string, enabled: boolean, log: Logger): AtemClient {
  return enabled ? new AtemConnectionClient(ip, log) : new StubAtemClient(ip, log);
}
