import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { diskFreeBytesAt, pingHost, runHealthChecks } from './health.js';
import { ConflictError, type SessionManager } from './session.js';
import type { ObsClient } from './clients/obs.js';

export interface HttpDeps {
  cfg: Config;
  sessions: SessionManager;
  obs: ObsClient;
  log: Logger;
  startedAt: Date;
}

export function buildServer(deps: HttpDeps): FastifyInstance {
  const { cfg, sessions, obs, log } = deps;
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ConflictError) {
      void reply.code(409).send({ error: err.message });
      return;
    }
    log.error({ err: err.message }, 'http error');
    void reply.code(500).send({ error: err.message });
  });

  app.post<{ Body: { name?: string; profile?: string } | null }>(
    '/session/start',
    async (req) => {
      const body = req.body ?? {};
      const result = await sessions.start(body.name, body.profile);
      log.info({ sessionId: result.sessionId, cmd: 'session/start' }, 'command ok');
      return result;
    },
  );

  app.post<{ Body: { label?: string } | null }>('/session/mark', async (req) => {
    const marker = sessions.mark(req.body?.label);
    return marker;
  });

  app.post('/session/end', async () => {
    const manifest = await sessions.end();
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

  app.get('/health', async () => {
    return runHealthChecks({
      obsVersion: () => obs.getVersion(),
      diskFreeBytes: () => diskFreeBytesAt(cfg.recordingsRoot),
      nasReachable: cfg.nas.enabled ? () => pingHost(cfg.nas.host) : null,
      minFreeGB: cfg.health.minFreeGB,
    });
  });

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
            markers: session.markers.length,
            files: session.files,
          }
        : null,
      obsConnected: obs.isConnected,
      record,
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt.getTime()) / 1000),
    };
  });

  return app;
}
