import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const ConfigSchema = z.object({
  recordingsRoot: z.string().min(1),
  nas: z.object({
    enabled: z.boolean().default(false),
    host: z.string().default(''),
    remotePath: z.string().default(''),
    rsyncFlags: z.array(z.string()).default(['-a', '--checksum', '--partial']),
  }),
  obs: z.object({
    url: z.string().url().default('ws://127.0.0.1:4455'),
    password: z.string().default(''),
  }),
  atem: z.object({
    ip: z.string().min(1),
  }),
  health: z.object({
    minFreeGB: z.number().positive().default(50),
  }),
  session: z.object({
    nameTemplate: z.string().default('{date}_{time}_{slug}'),
  }),
  http: z
    .object({
      port: z.number().int().positive().default(8722),
      host: z.string().default('127.0.0.1'),
    })
    .default({ port: 8722, host: '127.0.0.1' }),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Expand a leading ~ to the user's home directory. */
export function expandPath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid studio.yaml config. Fix the following and restart:\n${issues}`,
    );
  }
  const cfg = result.data;
  if (cfg.nas.enabled && (!cfg.nas.host || !cfg.nas.remotePath)) {
    throw new Error(
      'Invalid studio.yaml config: nas.enabled is true but nas.host / nas.remotePath are empty.',
    );
  }
  return { ...cfg, recordingsRoot: expandPath(cfg.recordingsRoot) };
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `Config file not found at ${path}. Copy config/studio.example.yaml to config/studio.yaml and edit it.`,
    );
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new Error(`Config file at ${path} is not valid YAML: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}
