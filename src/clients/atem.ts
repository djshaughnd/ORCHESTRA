import type { Logger } from 'pino';

/**
 * ATEM client — STUB for V1.
 *
 * In V1, all ATEM control goes through Bitfocus Companion. This interface
 * exists so the V2 `atem-connection` implementation drops in without
 * touching the rest of the daemon. The config validates `atem.ip` now so
 * the studio definition is complete from day one.
 */
export interface AtemClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  cut(cameraInput: number): Promise<void>;
  readonly isConnected: boolean;
}

export class StubAtemClient implements AtemClient {
  readonly isConnected = false;

  constructor(
    private ip: string,
    private log: Logger,
  ) {}

  async connect(): Promise<void> {
    this.log.info({ ip: this.ip }, 'ATEM client is a stub in V1 — control via Companion');
  }

  async disconnect(): Promise<void> {
    /* no-op */
  }

  async cut(cameraInput: number): Promise<void> {
    throw new Error(
      `ATEM cut to ${cameraInput} not implemented in V1 — use Companion. (V2: atem-connection)`,
    );
  }
}
