import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pino, transport, type Logger, type TransportTargetOptions } from 'pino';

export function createLogger(logsDir: string): Logger {
  mkdirSync(logsDir, { recursive: true });
  const logFile = resolve(logsDir, 'orchestra.log');

  const targets: TransportTargetOptions[] = [
    { target: 'pino/file', options: { destination: logFile, mkdir: true }, level: 'info' },
  ];
  // Pretty console only when attached to a TTY (dev). Under launchd, file only.
  if (process.stdout.isTTY) {
    targets.push({ target: 'pino-pretty', options: { colorize: true }, level: 'info' });
  } else {
    targets.push({ target: 'pino/file', options: { destination: 1 }, level: 'warn' });
  }

  return pino({ level: 'info' }, transport({ targets }));
}
