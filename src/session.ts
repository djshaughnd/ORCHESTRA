import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'session';
}

export interface NameParts {
  date: string; // YYYY-MM-DD
  time: string; // HHmm
  slug: string;
  profile: string;
  take?: string;
}

export function renderNameTemplate(template: string, parts: NameParts): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = (parts as unknown as Record<string, string | undefined>)[key];
    return v ?? '';
  });
}

export function namePartsForNow(now: Date, name?: string, profile?: string): NameParts {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}${pad(now.getMinutes())}`,
    slug: slugify(name ?? 'session'),
    profile: profile ?? 'default',
  };
}

export interface Marker {
  t: string;
  sinceRecordStartMs: number | null;
  label: string | null;
}

/** Marker math: elapsed ms since record start, or null if not recording yet. */
export function makeMarker(now: Date, recordStartedAt: Date | null, label?: string): Marker {
  return {
    t: now.toISOString(),
    sinceRecordStartMs: recordStartedAt ? Math.max(0, now.getTime() - recordStartedAt.getTime()) : null,
    label: label ?? null,
  };
}

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

export interface SessionManifest {
  sessionId: string;
  name: string;
  profile: string;
  path: string;
  startedAt: string;
  endedAt: string | null;
  recordStartedAt: string | null;
  takes: number;
  markers: Marker[];
  files: string[];
}

export interface ActiveSession {
  id: string;
  name: string;
  profile: string;
  path: string;
  startedAt: Date;
  recordStartedAt: Date | null;
  takes: number;
  markers: Marker[];
  files: string[];
}

/** The subset of ObsClient that SessionManager needs (mockable in tests). */
export interface ObsForSession {
  readonly isConnected: boolean;
  setRecordDirectory(path: string): Promise<void>;
  startRecord(): Promise<void>;
  stopRecord(): Promise<string | null>;
  getRecordStatus(): Promise<{ active: boolean }>;
}

export interface SyncJob {
  (sessionPath: string, sessionId: string): void;
}

export class ConflictError extends Error {}

export class SessionManager {
  private active: ActiveSession | null = null;

  constructor(
    private recordingsRoot: string,
    private resolveNameTemplate: (profile: string) => string,
    private obs: ObsForSession,
    private syncJob: SyncJob,
    private log: Logger,
  ) {}

  get activeSession(): ActiveSession | null {
    return this.active;
  }

  /** Called by the OBS event handler when a recording starts. */
  noteRecordingStarted(): void {
    if (this.active && !this.active.recordStartedAt) {
      this.active.recordStartedAt = new Date();
    }
  }

  noteOutputFile(path: string | null | undefined): void {
    if (this.active && path && !this.active.files.includes(path)) {
      this.active.files.push(path);
      this.log.info({ sessionId: this.active.id, file: path }, 'recording file captured');
    }
  }

  /** Increment and return the take counter (used for file renaming). */
  nextTakeNumber(): number {
    if (!this.active) return 0;
    return ++this.active.takes;
  }

  async start(name?: string, profile?: string): Promise<{ sessionId: string; path: string }> {
    if (this.active) {
      throw new ConflictError(`Session ${this.active.id} already active — end it first`);
    }
    const parts = namePartsForNow(new Date(), name, profile);
    const template = this.resolveNameTemplate(parts.profile);
    const folderName = renderNameTemplate(template, parts);
    const path = resolve(this.recordingsRoot, folderName);
    mkdirSync(path, { recursive: true });

    await this.obs.setRecordDirectory(path);

    const session: ActiveSession = {
      id: randomUUID(),
      name: name ?? parts.slug,
      profile: parts.profile,
      path,
      startedAt: new Date(),
      recordStartedAt: null,
      takes: 0,
      markers: [],
      files: [],
    };
    this.active = session;
    this.log.info({ sessionId: session.id, path, profile: session.profile }, 'session started');
    return { sessionId: session.id, path };
  }

  mark(label?: string): Marker {
    if (!this.active) throw new ConflictError('No active session');
    const marker = makeMarker(new Date(), this.active.recordStartedAt, label);
    this.active.markers.push(marker);
    this.log.info({ sessionId: this.active.id, marker }, 'marker added');
    return marker;
  }

  async startRecord(): Promise<void> {
    if (!this.active) throw new ConflictError('No active session — start one first');
    await this.obs.startRecord();
    this.active.recordStartedAt = new Date();
    this.log.info({ sessionId: this.active.id }, 'record started');
  }

  /** Stop must ALWAYS attempt, even in weird state. Never throws on "not recording". */
  async stopRecord(): Promise<string | null> {
    const sessionId = this.active?.id ?? null;
    try {
      const outputPath = await this.obs.stopRecord();
      this.noteOutputFile(outputPath);
      this.log.info({ sessionId, outputPath }, 'record stopped');
      return outputPath;
    } catch (err) {
      this.log.warn({ sessionId, err: (err as Error).message }, 'stopRecord attempt failed');
      return null;
    }
  }

  /**
   * End the session. Crash-safe ordering:
   *  1. stop recording (best-effort, never blocks on weird state)
   *  2. write manifest to disk
   *  3. fire-and-forget NAS sync
   *  4. clear active session
   */
  async end(): Promise<SessionManifest> {
    if (!this.active) throw new ConflictError('No active session');
    const session = this.active;

    // 1. Stop recording if running — but never let a stop failure block ending.
    try {
      const status = this.obs.isConnected ? await this.obs.getRecordStatus() : { active: false };
      if (status.active) {
        const outputPath = await this.obs.stopRecord();
        this.noteOutputFile(outputPath);
      }
    } catch (err) {
      this.log.warn(
        { sessionId: session.id, err: (err as Error).message },
        'could not stop recording during session end — continuing anyway',
      );
    }

    // 2. Manifest written BEFORE sync starts.
    const manifest: SessionManifest = {
      sessionId: session.id,
      name: session.name,
      profile: session.profile,
      path: session.path,
      startedAt: session.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      recordStartedAt: session.recordStartedAt?.toISOString() ?? null,
      takes: session.takes,
      markers: session.markers,
      files: session.files,
    };
    writeFileSync(join(session.path, 'session.json'), JSON.stringify(manifest, null, 2));
    this.log.info({ sessionId: session.id }, 'manifest written');

    // 3. Fire-and-forget sync.
    try {
      this.syncJob(session.path, session.id);
    } catch (err) {
      this.log.error({ sessionId: session.id, err }, 'failed to launch sync job');
    }

    // 4. Clear.
    this.active = null;
    this.log.info({ sessionId: session.id }, 'session ended');
    return manifest;
  }
}
