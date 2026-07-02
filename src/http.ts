import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { resolveProfile, type Config } from './config.js';
import { DASHBOARD_HTML } from './dashboard.js';
import type { HealthReport } from './health.js';
import type { HealthMonitor } from './monitor.js';
import { ConflictError, type SessionManager } from './session.js';
import type { Director } from './switcher.js';
import type { AtemClient } from './clients/atem.js';
import type { ObsClient } from './clients/obs.js';

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
  state: StudioState;
  runChecks: () => Promise<HealthReport>;
  log: Logger;
  startedAt: Date;
}

export function buildServer(deps: HttpDeps): FastifyInstance {
  const { cfg, sessions, obs, atem, director, monitor, state, runChecks, log } = deps;
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

  app.post<{ Body: { name?: string; profile?: string } | null }>(
    '/session/start',
    async (req, reply) => {
      const body = req.body ?? {};
      const profileName = body.profile ?? state.activeProfile;
      if (profileName !== 'default' && !cfg.profiles[profileName]) {
        return reply.code(400).send({ error: `Unknown profile "${profileName}"` });
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
      log.info({ sessionId: result.sessionId, cmd: 'session/start' }, 'command ok');
      return result;
    },
  );

  app.post<{ Body: { label?: string } | null }>('/session/mark', async (req) => {
    return sessions.mark(req.body?.label);
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

  // --------------------------------------------------------- health/status

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
      record,
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt.getTime()) / 1000),
    };
  });

  // -------------------------------------------------------------- dashboard

  app.get('/', async (_req, reply) => {
    return reply.type('text/html').send(DASHBOARD_HTML);
  });

  return app;
}
