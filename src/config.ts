import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Profiles (V2): each profile defines templates, default cam, switching rules
// ---------------------------------------------------------------------------

export const AudioRuleSchema = z.object({
  enabled: z.boolean().default(false),
  // OBS input name whose volume meters drive the closeup rule.
  obsInput: z.string().default('Mic/Aux'),
  closeupCam: z.number().int().positive().default(2),
  thresholdDb: z.number().default(-30),
  sustainMs: z.number().int().positive().default(1500),
});

export const AutoSwitchSchema = z
  .object({
    enabled: z.boolean().default(false),
    cameras: z.array(z.number().int().positive()).min(1).default([1, 2]),
    minShotSeconds: z.number().positive().default(4),
    maxShotSeconds: z.number().positive().default(12),
    overridePauseSeconds: z.number().nonnegative().default(20),
    audio: AudioRuleSchema.default({}),
  })
  .refine((a) => a.maxShotSeconds >= a.minShotSeconds, {
    message: 'maxShotSeconds must be >= minShotSeconds',
    path: ['maxShotSeconds'],
  });

export const ProfileSchema = z.object({
  // Overrides session.nameTemplate when set.
  nameTemplate: z.string().optional(),
  // Recording files are renamed to this on RecordStopped. {take} increments.
  fileTemplate: z.string().default('{date}_{profile}_take{take}'),
  obsSceneCollection: z.string().optional(),
  atemDefaultCam: z.number().int().positive().default(1),
  lightingPreset: z.string().optional(),
  autoSwitch: AutoSwitchSchema.default({}),
});

export type ProfileConfig = z.infer<typeof ProfileSchema>;
export type AutoSwitchConfig = z.infer<typeof AutoSwitchSchema>;

export const DEFAULT_PROFILE: ProfileConfig = ProfileSchema.parse({});

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

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
    // Fire an OBS chapter marker on /session/mark (OBS 30.2+, Hybrid MP4 only).
    // Best-effort: failures are logged, the marker itself always succeeds.
    chapterMarkers: z.boolean().default(true),
  }),
  companion: z
    .object({
      // Push state to Companion custom variables so buttons can change color
      // without polling. Requires Companion Settings -> HTTP API enabled.
      enabled: z.boolean().default(false),
      url: z.string().url().default('http://127.0.0.1:8000'),
    })
    .default({}),
  atem: z.object({
    ip: z.string().min(1),
    // false = Companion drives the ATEM; daemon /cut and auto-switch disabled.
    enabled: z.boolean().default(false),
  }),
  health: z.object({
    minFreeGB: z.number().positive().default(50),
  }),
  session: z.object({
    nameTemplate: z.string().default('{date}_{time}_{slug}'),
  }),
  activeProfile: z.string().default('default'),
  profiles: z.record(ProfileSchema).default({}),
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

/** Look up a profile by name; 'default' (or unknown) falls back to defaults. */
export function resolveProfile(cfg: Config, name: string): ProfileConfig {
  return cfg.profiles[name] ?? DEFAULT_PROFILE;
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
  if (cfg.activeProfile !== 'default' && !cfg.profiles[cfg.activeProfile]) {
    throw new Error(
      `Invalid studio.yaml config: activeProfile "${cfg.activeProfile}" is not defined under profiles.`,
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
