import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from './config.js';
import { createLogger } from './log.js';
import { ObsClient } from './clients/obs.js';
import { StubAtemClient } from './clients/atem.js';
import { SessionManager } from './session.js';
import { startNasSync } from './jobs/sync.js';
import { buildServer } from './http.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.ORCHESTRA_CONFIG ?? resolve(repoRoot, 'config/studio.yaml');

async function main(): Promise<void> {
  // Fail loudly on bad config, before anything else starts.
  let cfg: Config;
  try {
    cfg = loadConfig(configPath);
  } catch (err) {
    console.error(`\n[orchestra] BOOT FAILED\n${(err as Error).message}\n`);
    process.exit(1);
  }

  const log = createLogger(resolve(repoRoot, 'logs'));
  log.info({ configPath }, 'orchestra booting');

  if (!existsSync(cfg.recordingsRoot)) {
    mkdirSync(cfg.recordingsRoot, { recursive: true });
    log.info({ recordingsRoot: cfg.recordingsRoot }, 'created recordings root');
  }

  const obs = new ObsClient(cfg.obs.url, cfg.obs.password, log.child({ client: 'obs' }));
  const atem = new StubAtemClient(cfg.atem.ip, log.child({ client: 'atem' }));

  const sessions = new SessionManager(
    cfg.recordingsRoot,
    cfg.session.nameTemplate,
    obs,
    (sessionPath, sessionId) => startNasSync(cfg, sessionPath, sessionId, log.child({ job: 'nas-sync' })),
    log.child({ mod: 'session' }),
  );

  // Capture output files + record-start times from OBS events.
  obs.on('RecordStateChanged', (data: { outputState: string; outputPath?: string }) => {
    log.info({ event: 'RecordStateChanged', ...data }, 'obs event');
    if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
      sessions.noteRecordingStarted();
    }
    if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
      sessions.noteOutputFile(data.outputPath);
    }
  });

  // On (re)connect, reconcile in-memory state with reality.
  obs.onReconnect(() => {
    void (async () => {
      try {
        const status = await obs.getRecordStatus();
        log.info({ recordActive: status.active }, 'reconciled OBS record state after (re)connect');
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'could not reconcile OBS state');
      }
    })();
  });

  await obs.start();
  await atem.connect();

  const startedAt = new Date();
  const app = buildServer({ cfg, sessions, obs, log: log.child({ mod: 'http' }), startedAt });
  await app.listen({ port: cfg.http.port, host: cfg.http.host });
  log.info({ port: cfg.http.port, host: cfg.http.host }, 'orchestra ready');

  // Graceful shutdown: NEVER stop a recording on the way out — OBS outlives us.
  const shutdown = async (signal: string) => {
    log.warn({ signal }, 'shutdown requested');
    if (obs.isConnected) {
      try {
        const status = await obs.getRecordStatus();
        if (status.active) {
          log.warn(
            'RECORDING IS STILL ACTIVE — orchestra is exiting but OBS keeps recording. Stop it from OBS or Companion.',
          );
        }
      } catch {
        /* best effort */
      }
    }
    await app.close();
    await obs.stop();
    await atem.disconnect();
    log.info('orchestra stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[orchestra] fatal:', err);
  process.exit(1);
});
