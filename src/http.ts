import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { resolveProfile, volumeRootOf, type Config } from './config.js';
import { isVolumeMounted } from './health.js';
import { DASHBOARD_HTML } from './dashboard.js';
import type { HealthReport } from './health.js';
import type { HealthMonitor } from './monitor.js';
import { ConflictError, type SessionManager } from './session.js';
import type { Director } from './switcher.js';
import type { AtemClient } from './clients/atem.js';
import type { ObsClient } from './clients/obs.js';
import type { CaptureWatchdog } from './capture-watchdog.js';
import type { CameraClient } from './clients/camera.js';
import type { AmaranClient } from './clients/amaran.js';
import type { LightingDirector } from './lighting.js';
import { buildScenePlan } from './scene-plan.js';

export interface StudioState {
  activeProfile: string;
}

export interface HttpDeps {
  cfg: Config;
  sessions: SessionManager;
  obs: ObsClient;
  atem: AtemClient;
  director: Director;
  monitor: HealthMonitor;
  captureWatchdog: CaptureWatchdog | null;
  camera: CameraClient;
  amaran: AmaranClient;
  lighting: LightingDirector;
  state: StudioState;
  runChecks: () => Promise<HealthReport>;
  log: Logger;
  startedAt: Date;
}

export function buildServer(deps: HttpDeps): FastifyInstance {
  const {
    cfg,
    sessions,
    obs,
    atem,
    director,
    monitor,
    captureWatchdog,
    camera,
    amaran,
    lighting,
    state,
    runChecks,
    log,
  } = deps;
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ConflictError) {
      void reply.code(409).send({ error: err.message });
      return;
    }
    log.error({ err: err.message }, 'http error');
    void reply.code(500).send({ error: err.message });
  });

  // -------------------------------------------------------------- sessions

  type OpenResult =
    | { ok: true; sessionId: string; path: string }
    | { ok: false; code: number; error: string };

  /**
   * Shared session-open flow used by /session/start and /go: validate the
   * profile, guard the recording volume, switch OBS scene collection, then
   * start the session + health monitor. Throws ConflictError on double-start
   * (handled by the global error handler as a 409).
   */
  async function openSession(body: { name?: string; profile?: string }): Promise<OpenResult> {
    const profileName = body.profile ?? state.activeProfile;
    if (profileName !== 'default' && !cfg.profiles[profileName]) {
      return { ok: false, code: 400, error: `Unknown profile "${profileName}"` };
    }

    // Never start a session onto an unplugged external drive — mkdir would
    // silently land on the boot disk at the volume's mountpoint path.
    const recordingVolume = volumeRootOf(cfg.recordingsRoot);
    if (recordingVolume && !(await isVolumeMounted(recordingVolume))) {
      return {
        ok: false,
        code: 503,
        error: `Recording volume ${recordingVolume} is not mounted — plug in the drive`,
      };
    }
    const profile = resolveProfile(cfg, profileName);

    // Best-effort: switch OBS scene collection per profile before pointing
    // the record directory (collection switches can reset output settings).
    if (profile.obsSceneCollection && obs.isConnected) {
      try {
        await obs.call('SetCurrentSceneCollection', {
          sceneCollectionName: profile.obsSceneCollection,
        });
      } catch (err) {
        log.warn(
          { err: (err as Error).message, collection: profile.obsSceneCollection },
          'could not switch OBS scene collection',
        );
      }
    }

    const result = await sessions.start(body.name, profileName);
    monitor.start();
    return { ok: true, ...result };
  }

  app.post<{ Body: { name?: string; profile?: string } | null }>(
    '/session/start',
    async (req, reply) => {
      const r = await openSession(req.body ?? {});
      if (!r.ok) return reply.code(r.code).send({ error: r.error });
      log.info({ sessionId: r.sessionId, cmd: 'session/start' }, 'command ok');
      return { sessionId: r.sessionId, path: r.path };
    },
  );

  // One-button macro: open session -> start recording -> (optional) run a
  // scripted cinematic sequence. The "walk in, hit one button" path.
  app.post<{
    Body: {
      name?: string;
      profile?: string;
      sequence?: string;
      reactive?: boolean;
      record?: boolean;
    } | null;
  }>('/go', async (req, reply) => {
    const body = req.body ?? {};
    const profileName = body.profile ?? state.activeProfile;
    const profile = resolveProfile(cfg, profileName);
    const seqName = body.sequence;
    const reactive = body.reactive === true;

    // Validate switching intent up-front so /go is all-or-nothing on bad input.
    if (seqName && reactive) {
      return reply.code(400).send({ error: 'Pass either sequence or reactive, not both' });
    }
    if ((seqName || reactive) && !cfg.atem.enabled) {
      return reply
        .code(400)
        .send({ error: 'atem.enabled=false in studio.yaml — cannot auto-switch' });
    }
    if (seqName && !profile.sequences[seqName]) {
      return reply
        .code(404)
        .send({ error: `Unknown sequence "${seqName}" for profile "${profileName}"` });
    }
    if (reactive && !profile.beatReactive.enabled) {
      return reply
        .code(400)
        .send({ error: `beatReactive.enabled=false for profile "${profileName}"` });
    }

    const r = await openSession(body);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });

    // Open every mode on its home shot: cut to the profile's default cam
    // before recording starts. Best-effort — never blocks the session.
    if (cfg.atem.enabled && atem.isConnected) {
      try {
        await atem.cut(profile.atemDefaultCam);
      } catch (err) {
        log.warn(
          { err: (err as Error).message, cam: profile.atemDefaultCam },
          'could not cut to profile default cam on /go',
        );
      }
    }

    // Light the scene first so the camera meters against the final look.
    if (profile.sceneRecipe) {
      await lighting.apply(profile.sceneRecipe);
    }

    // Push the profile's exposure lock so the camera stops auto-ISO grain.
    // Best-effort and awaited before record so the take starts locked.
    if (profile.cameraLock) {
      await camera.apply(profile.cameraLock);
    }

    const record = body.record !== false; // defaults to true
    if (record) {
      try {
        await sessions.startRecord();
      } catch (err) {
        return reply.code(503).send({
          ok: false,
          sessionId: r.sessionId,
          path: r.path,
          error: `Session started but recording failed: ${(err as Error).message}`,
        });
      }
    }
    if (reactive) director.armReactive(profile.beatReactive);
    else if (seqName) director.runSequence(profile.sequences[seqName]!);

    log.info(
      { sessionId: r.sessionId, sequence: seqName ?? null, reactive, record, cmd: 'go' },
      'command ok',
    );
    return { ok: true, sessionId: r.sessionId, path: r.path, recording: record, ...director.status };
  });

  app.post<{ Body: { label?: string } | null }>('/session/mark', async (req) => {
    const marker = sessions.mark(req.body?.label);
    // Best-effort OBS chapter marker (30.2+ Hybrid MP4). Only while recording;
    // must never fail or delay the marker itself.
    if (cfg.obs.chapterMarkers && obs.isConnected && sessions.activeSession?.recordStartedAt) {
      obs.createRecordChapter(req.body?.label ?? undefined).catch((err: Error) => {
        log.warn(
          { err: err.message },
          'OBS chapter marker failed (needs OBS 30.2+ recording Hybrid MP4)',
        );
      });
    }
    return marker;
  });

  app.post('/session/end', async () => {
    const manifest = await sessions.end();
    monitor.stop();
    director.disarm();
    return manifest;
  });

  app.post('/record/start', async () => {
    await sessions.startRecord();
    return { ok: true };
  });

  // Stop must ALWAYS attempt, regardless of session state — never 409.
  app.post('/record/stop', async () => {
    const outputPath = await sessions.stopRecord();
    return { ok: true, outputPath };
  });

  // ------------------------------------------------------------------ cuts

  app.post<{ Params: { cam: string } }>('/cut/:cam', async (req, reply) => {
    const cam = Number.parseInt(req.params.cam, 10);
    if (!Number.isInteger(cam) || cam < 1) {
      return reply.code(400).send({ error: `Invalid camera "${req.params.cam}"` });
    }
    director.noteManualCut(cam);
    try {
      await atem.cut(cam);
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
    log.info({ cam, cmd: 'cut' }, 'command ok');
    return { ok: true, cam };
  });

  // ----------------------------------------------------------- auto-switch

  app.post('/auto/arm', async (_req, reply) => {
    const profile = resolveProfile(cfg, state.activeProfile);
    if (!cfg.atem.enabled) {
      return reply
        .code(400)
        .send({ error: 'atem.enabled=false in studio.yaml — daemon cannot cut' });
    }
    if (!profile.autoSwitch.enabled) {
      return reply.code(400).send({
        error: `autoSwitch.enabled=false for profile "${state.activeProfile}" in studio.yaml`,
      });
    }
    director.arm(profile.autoSwitch, profile.atemDefaultCam);
    return { ok: true, ...director.status };
  });

  // Kill switch — always succeeds.
  app.post('/auto/disarm', async () => {
    director.disarm();
    return { ok: true, ...director.status };
  });

  // ---------------------------------------------------------- sequences

  app.post<{ Params: { name: string } }>('/sequence/:name/run', async (req, reply) => {
    if (!cfg.atem.enabled) {
      return reply
        .code(400)
        .send({ error: 'atem.enabled=false in studio.yaml — daemon cannot cut' });
    }
    const profile = resolveProfile(cfg, state.activeProfile);
    const cues = profile.sequences[req.params.name];
    if (!cues) {
      return reply.code(404).send({
        error: `Unknown sequence "${req.params.name}" for profile "${state.activeProfile}"`,
      });
    }
    director.runSequence(cues);
    log.info(
      { sequence: req.params.name, cues: cues.length, cmd: 'sequence/run' },
      'command ok',
    );
    return { ok: true, ...director.status };
  });

  app.get('/sequences', async () => {
    const profile = resolveProfile(cfg, state.activeProfile);
    return { active: state.activeProfile, available: Object.keys(profile.sequences) };
  });

  // Beat-reactive director: fast, music-driven cutting off the OBS audio meters.
  app.post('/reactive/arm', async (_req, reply) => {
    if (!cfg.atem.enabled) {
      return reply
        .code(400)
        .send({ error: 'atem.enabled=false in studio.yaml — daemon cannot cut' });
    }
    const profile = resolveProfile(cfg, state.activeProfile);
    if (!profile.beatReactive.enabled) {
      return reply.code(400).send({
        error: `beatReactive.enabled=false for profile "${state.activeProfile}" in studio.yaml`,
      });
    }
    director.armReactive(profile.beatReactive);
    log.info({ cmd: 'reactive/arm' }, 'command ok');
    return { ok: true, ...director.status };
  });

  // -------------------------------------------------------------- profiles

  app.get('/profiles', async () => ({
    active: state.activeProfile,
    available: ['default', ...Object.keys(cfg.profiles)],
  }));

  app.post<{ Params: { name: string } }>('/profile/:name', async (req, reply) => {
    const { name } = req.params;
    if (name !== 'default' && !cfg.profiles[name]) {
      return reply.code(404).send({ error: `Unknown profile "${name}"` });
    }
    state.activeProfile = name;
    log.info({ profile: name }, 'active profile changed');
    return { ok: true, active: name };
  });

  // ---------------------------------------------------- scene / lighting v1

  // Read-only by design. Phase 1 cannot send set_* commands to any fixture.
  app.get('/lighting/status', async () => amaran.status);

  app.get('/lighting/discover', async (_req, reply) => {
    if (!amaran.isEnabled) {
      return reply.code(503).send({ error: 'amaran integration is disabled' });
    }
    try {
      const protocolVersions = await amaran.getProtocolVersions();
      const fixtures = await amaran.listFixtures();
      const devices = await amaran.listDevices();
      const scenes = await amaran.listScenes();
      return { ok: true, protocolVersions, fixtures, devices, scenes };
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'amaran discovery failed');
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { nodeId: string } }>('/lighting/fixture/:nodeId/state', async (req, reply) => {
    if (!amaran.isEnabled) {
      return reply.code(503).send({ error: 'amaran integration is disabled' });
    }
    try {
      const fixture = (await amaran.listFixtures()).find(
        (item) => item.nodeId === req.params.nodeId,
      );
      if (!fixture) return reply.code(404).send({ error: 'Unknown amaran fixture' });
      const sleep = await amaran.getSleep(fixture.nodeId);
      const cct = await amaran.getCct(fixture.nodeId);
      return { ok: true, fixture, sleep, ...cct };
    } catch (err) {
      log.warn(
        { nodeId: req.params.nodeId, err: (err as Error).message },
        'amaran fixture state read failed',
      );
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  app.get<{ Querystring: { profile?: string } }>('/scene/plan', async (req, reply) => {
    const profileName = req.query.profile ?? state.activeProfile;
    if (profileName !== 'default' && !cfg.profiles[profileName]) {
      return reply.code(404).send({ error: `Unknown profile "${profileName}"` });
    }
    return buildScenePlan(profileName, resolveProfile(cfg, profileName));
  });

  // --------------------------------------------------------- health/status

  // ------------------------------------------------------------------ camera

  // Read the camera's live settings (Sony SDK). Also refreshes /status.
  app.get('/camera', async (_req, reply) => {
    if (!camera.isEnabled) {
      return reply.code(400).send({ error: 'camera.enabled=false in studio.yaml' });
    }
    await camera.refresh();
    return camera.snapshot;
  });

  // Push an exposure lock by hand (same path /go uses per profile).
  app.post<{ Body: { iso?: number; fnumber?: number; shutter?: number } | null }>(
    '/camera/apply',
    async (req, reply) => {
      if (!camera.isEnabled) {
        return reply.code(400).send({ error: 'camera.enabled=false in studio.yaml' });
      }
      const body = req.body ?? {};
      if (body.iso == null && body.fnumber == null && body.shutter == null) {
        return reply.code(400).send({ error: 'pass at least one of iso/fnumber/shutter' });
      }
      const ok = await camera.apply(body);
      return reply.code(ok ? 200 : 503).send({ ok, ...camera.snapshot });
    },
  );

  // Apply a profile's lighting recipe by hand (same path /go uses).
  app.post<{ Params: { name: string } }>('/lighting/apply/:name', async (req, reply) => {
    if (!cfg.amaran.enabled) {
      return reply.code(400).send({ error: 'amaran.enabled=false in studio.yaml' });
    }
    const { name } = req.params;
    if (name !== 'default' && !cfg.profiles[name]) {
      return reply.code(404).send({ error: `Unknown profile "${name}"` });
    }
    const profile = resolveProfile(cfg, name);
    if (!profile.sceneRecipe) {
      return reply.code(400).send({ error: `Profile "${name}" has no sceneRecipe` });
    }
    const results = await lighting.apply(profile.sceneRecipe);
    return { ok: results.every((r) => r.ok), profile: name, results };
  });

  // Full signal chain — where resolution is won or lost, end to end.
  app.get('/signal-chain', async () => {
    const out: Record<string, unknown> = {};
    out.camera = camera.isEnabled ? camera.snapshot : null;
    out.atem = { connected: atem.isConnected, program: director.status.program, maxResolution: '1920x1080 (hardware limit)' };
    if (obs.isConnected) {
      try {
        const v = await obs.getVideoInfo();
        const scene = await obs.getCurrentScene();
        const src = cfg.obs.captureSource
          ? await obs.getSourceDimensions(scene, cfg.obs.captureSource).catch(() => null)
          : null;
        const encoder = await obs.getRecordEncoder();
        const upscale = src && src.width ? Number((v.baseHeight / src.height).toFixed(2)) : null;
        out.obs = {
          scene, encoder,
          captureSource: cfg.obs.captureSource,
          sourceResolution: src ? `${src.width}x${src.height}` : null,
          canvas: `${v.baseWidth}x${v.baseHeight}`,
          output: `${v.outputWidth}x${v.outputHeight}`,
          fps: v.fps,
          verticalUpscale: upscale,
          warning: upscale && upscale > 1.05
            ? `output is ${upscale}x the source — upscaling loses sharpness`
            : null,
        };
      } catch (err) {
        out.obs = { error: (err as Error).message };
      }
    } else {
      out.obs = { error: 'OBS not connected' };
    }
    return out;
  });

  app.get('/health', async () => runChecks());

  app.get('/status', async () => {
    const session = sessions.activeSession;
    let record: { active: boolean; timecode?: string } = { active: false };
    if (obs.isConnected) {
      try {
        const s = await obs.getRecordStatus();
        record = { active: s.active, timecode: s.timecode };
      } catch {
        /* leave default */
      }
    }
    return {
      session: session
        ? {
            id: session.id,
            name: session.name,
            profile: session.profile,
            path: session.path,
            startedAt: session.startedAt.toISOString(),
            takes: session.takes,
            markers: session.markers.length,
            files: session.files,
          }
        : null,
      profile: state.activeProfile,
      auto: director.status,
      obsConnected: obs.isConnected,
      atemConnected: atem.isConnected,
      amaran: amaran.status,
      record,
      capture: captureWatchdog
        ? { watching: captureWatchdog.isRunning, frozen: captureWatchdog.isFrozen }
        : null,
      camera: camera.isEnabled ? camera.snapshot : null,
      lighting: cfg.amaran.enabled ? lighting.snapshot : null,
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt.getTime()) / 1000),
    };
  });

  // -------------------------------------------------------------- dashboard

  app.get('/', async (_req, reply) => {
    return reply.type('text/html').send(DASHBOARD_HTML);
  });

  return app;
}
