import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import type { Logger } from 'pino';
import type { Config } from '../config.js';

const RETRIES = 3;
const RETRY_DELAY_MS = 10_000;

function runRsync(args: string[], log: Logger, sessionId: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => rejectPromise(err));
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`rsync exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
    log.info({ sessionId, cmd: `rsync ${args.join(' ')}` }, 'sync started');
  });
}

/**
 * Fire-and-forget: sync a finished session folder to the NAS.
 * Retries x3 with delay. Logs everything. NEVER blocks the caller —
 * call this without awaiting.
 */
export function startNasSync(cfg: Config, sessionPath: string, sessionId: string, log: Logger): void {
  if (!cfg.nas.enabled) {
    log.info({ sessionId }, 'NAS sync disabled — skipping');
    return;
  }
  const dest = `${cfg.nas.host}:${cfg.nas.remotePath.replace(/\/$/, '')}/${basename(sessionPath)}/`;
  const args = [...cfg.nas.rsyncFlags, `${sessionPath}/`, dest];

  void (async () => {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        await runRsync(args, log, sessionId);
        log.info({ sessionId, dest, attempt }, 'NAS sync complete');
        return;
      } catch (err) {
        log.error(
          { sessionId, attempt, err: (err as Error).message },
          `NAS sync attempt ${attempt}/${RETRIES} failed`,
        );
        if (attempt < RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    log.error({ sessionId, dest }, 'NAS sync FAILED after all retries — session remains on local disk');
  })();
}
