import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveProfile, volumeRootOf, type Config } from './config.js';
import { createLogger } from './log.js';
import { ObsClient } from './clients/obs.js';
import { createAtemClient } from './clients/atem.js';
import { CompanionClient } from './clients/companion.js';
import { CaptureWatchdog } from './capture-watchdog.js';
import { namePartsForNow, SessionManager } from './session.js';
import { startNasSync } from './jobs/sync.js';
import { buildServer, type StudioState } from './http.js';
import { diskFreeBytesAt, isVolumeMounted, pingHost, runHealthChecks } from './health.js';
import { HealthMonitor } from './monitor.js';
import { buildTakeFilename } from './rename.js';
import { Director, mulToDb } from './switcher.js';

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

  // Recording to an external volume: refuse to boot when it isn't mounted,
  // otherwise mkdir would silently create the folder on the boot disk.
  const recordingVolume = volumeRootOf(cfg.recordingsRoot);
  if (recordingVolume && !(await isVolumeMounted(recordingVolume))) {
    console.error(
      `\n[orchestra] BOOT FAILED\nrecordingsRoot ${cfg.recordingsRoot} is on ${recordingVolume}, but that volume is not mounted. Plug in the drive and restart.\n`,
    );
    process.exit(1);
  }

  const log = createLogger(resolve(repoRoot, 'logs'));
  log.info({ configPath, activeProfile: cfg.activeProfile }, 'orchestra booting');

  if (!existsSync(cfg.recordingsRoot)) {
    mkdirSync(cfg.recordingsRoot, { recursive: true });
    log.info({ recordingsRoot: cfg.recordingsRoot }, 'created recordings root');
  }

  const state: StudioState = { activeProfile: cfg.activeProfile };
  const obs = new ObsClient(cfg.obs.url, cfg.obs.password, log.child({ client: 'obs' }));
  const atem = createAtemClient(cfg.atem.ip, cfg.atem.enabled, log.child({ client: 'atem' }));
  const companion = new CompanionClient(
    cfg.companion.url,
    cfg.companion.enabled,
    log.child({ client: 'companion' }),
  );
  const director = new Director(atem, log.child({ mod: 'director' }));

  // Capture watchdog: only meaningful when a source name is configured.
  const cw = cfg.obs.captureWatchdog;
  const captureWatchdog =
    cw.enabled && cfg.obs.captureSource
      ? new CaptureWatchdog({
          grabFrame: () => obs.getSourceFrameHash(cfg.obs.captureSource!),
          onFreeze: () => companion.pushCapture(false),
          onRecover: () => companion.pushCapture(true),
          pollMs: cw.pollMs,
          freezeSeconds: cw.freezeSeconds,
          log: log.child({ mod: 'capture-watchdog' }),
          ...(cw.autoRecover
            ? { recover: () => obs.reactivateInput(cfg.obs.captureSource!) }
            : {}),
        })
      : null;

  const sessions = new SessionManager(
    cfg.recordingsRoot,
    (profile) => resolveProfile(cfg, profile).nameTemplate ?? cfg.session.nameTemplate,
    obs,
    (sessionPath, sessionId) =>
      startNasSync(cfg, sessionPath, sessionId, log.child({ job: 'nas-sync' })),
    log.child({ mod: 'session' }),
  );

  // ------------------------------------------------------------ OBS events

  obs.on(
    'RecordStateChanged',
    (data: { outputState: string; outputPath?: string }) => {
      log.info({ event: 'RecordStateChanged', ...data }, 'obs event');
      if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
        sessions.noteRecordingStarted();
        captureWatchdog?.start();
      }
      if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
        captureWatchdog?.stop();
      }
      if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED' && data.outputPath) {
        let finalPath = data.outputPath;
        const active = sessions.activeSession;
        if (active) {
          // V2: rename finished takes to the profile's file template.
          try {
            const profile = resolveProfile(cfg, active.profile);
            const take = sessions.nextTakeNumber();
            const parts = {
              ...namePartsForNow(active.startedAt, active.name, active.profile),
              take: String(take),
            };
            const target = buildTakeFilename(profile.fileTemplate, parts, data.outputPath);
            if (target !== data.outputPath && !existsSync(target)) {
              renameSync(data.outputPath, target);
              finalPath = target;
              log.info(
                { sessionId: active.id, from: data.outputPath, to: target },
                'take renamed',
              );
            }
          } catch (err) {
            log.warn(
              { err: (err as Error).message, file: data.outputPath },
              'could not rename take — keeping original filename',
            );
          }
        }
        sessions.noteFileRenamed(data.outputPath, finalPath);
      }
    },
  );

  // Audio-reactive switching: OBS volume meters → director.
  obs.on(
    'InputVolumeMeters',
    (data: { inputs: Array<{ inputName: string; inputLevelsMul: number[][] }> }) => {
      for (const input of data.inputs) {
        if (!input.inputLevelsMul.length) continue;
        const peak = Math.max(
          0,
          ...input.inputLevelsMul.map((ch) => ch[1] ?? ch[0] ?? 0),
        );
        director.audio(input.inputName, mulToDb(peak));
      }
    },
  );

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
  try {
    await atem.connect();
  } catch (err) {
    log.error({ err: (err as Error).message }, 'ATEM connect failed — cuts unavailable until it recovers');
  }

  // ---------------------------------------------------------------- health

  const runChecks = () =>
    runHealthChecks({
      obsVersion: () => obs.getVersion(),
      diskFreeBytes: () => diskFreeBytesAt(cfg.recordingsRoot),
      nasReachable: cfg.nas.enabled ? () => pingHost(cfg.nas.host) : null,
      obsDroppedFrames: () => obs.getStats(),
      volumeMounted: recordingVolume ? () => isVolumeMounted(recordingVolume) : null,
      minFreeGB: cfg.health.minFreeGB,
    });
  const monitor = new HealthMonitor(runChecks, log.child({ mod: 'monitor' }), {
    onTransition: (ok) => companion.pushHealth(ok),
  });

  // ------------------------------------------------------------------ HTTP

  const startedAt = new Date();
  const app = buildServer({
    cfg,
    sessions,
    obs,
    atem,
    director,
    monitor,
    captureWatchdog,
    state,
    runChecks,
    log: log.child({ mod: 'http' }),
    startedAt,
  });
  await app.listen({ port: cfg.http.port, host: cfg.http.host });
  log.info({ port: cfg.http.port, host: cfg.http.host }, 'orchestra ready');

  // Graceful shutdown: NEVER stop a recording on the way out — OBS outlives us.
  const shutdown = async (signal: string) => {
    log.warn({ signal }, 'shutdown requested');
    director.disarm();
    monitor.stop();
    captureWatchdog?.stop();
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
