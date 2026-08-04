import type { Logger } from 'pino';
import type { AmaranClient } from './clients/amaran.js';
import type { SceneRecipeConfig } from './config.js';

export interface LightingApplyResult {
  fixture: string;
  ok: boolean;
  error?: string;
  applied?: { sleep?: boolean; cct?: number; intensity?: number; gm?: number };
}

export interface LightingState {
  /** Fixture-name -> what we last successfully pushed. */
  lastApplied: Record<string, LightingApplyResult['applied']>;
  appliedAt: string | null;
  error: string | null;
}

/**
 * Applies a profile's lighting recipe to the amaran fixtures.
 *
 * Recipes address fixtures by their NAME (as shown in amaran Desktop and
 * GET /lighting/discover) — names are stable and human-editable, nodeIds are
 * not. Unknown names are reported, never fatal.
 *
 * Best-effort by contract: lighting must never block or fail a recording.
 * Every error is captured in the result and the returned state.
 */
export class LightingDirector {
  private state: LightingState = { lastApplied: {}, appliedAt: null, error: null };

  constructor(
    private amaran: AmaranClient,
    private log: Logger,
  ) {}

  get snapshot(): LightingState {
    return { lastApplied: { ...this.state.lastApplied }, appliedAt: this.state.appliedAt, error: this.state.error };
  }

  /**
   * Push a scene recipe's lighting block. Returns per-fixture results.
   * Never throws.
   */
  async apply(recipe: SceneRecipeConfig | undefined): Promise<LightingApplyResult[]> {
    const targets = recipe?.lighting?.fixtures ?? {};
    const names = Object.keys(targets);
    if (names.length === 0) return [];

    let fixtures;
    try {
      fixtures = await this.amaran.listFixtures();
    } catch (err) {
      const msg = (err as Error).message;
      this.state.error = msg;
      this.log.warn({ err: msg }, 'lighting: could not list fixtures');
      return names.map((fixture) => ({ fixture, ok: false, error: msg }));
    }

    const byName = new Map(fixtures.map((f) => [f.name, f]));
    const results: LightingApplyResult[] = [];

    for (const name of names) {
      const target = targets[name]!;
      const fixture = byName.get(name);
      if (!fixture) {
        const error = `no amaran fixture named "${name}"`;
        this.log.warn({ fixture: name }, 'lighting: fixture not found');
        results.push({ fixture: name, ok: false, error });
        continue;
      }
      try {
        const applied: NonNullable<LightingApplyResult['applied']> = {};
        // Wake first so colour/intensity land on a live fixture.
        if (target.sleep !== undefined) {
          await this.amaran.setSleep(fixture.nodeId, target.sleep);
          applied.sleep = target.sleep;
        }
        if (target.cct !== undefined || target.intensity !== undefined || target.gm !== undefined) {
          const cctTarget: { cct?: number; intensity?: number; gm?: number } = {};
          if (target.cct !== undefined) cctTarget.cct = target.cct;
          if (target.intensity !== undefined) cctTarget.intensity = target.intensity;
          if (target.gm !== undefined) cctTarget.gm = target.gm;
          const state = await this.amaran.setCct(fixture.nodeId, cctTarget);
          applied.cct = state.cct;
          applied.intensity = state.intensity;
          if (state.gm !== undefined) applied.gm = state.gm;
        }
        this.state.lastApplied[name] = applied;
        results.push({ fixture: name, ok: true, applied });
        this.log.info({ fixture: name, applied }, 'lighting applied');
      } catch (err) {
        const error = (err as Error).message;
        this.log.warn({ fixture: name, err: error }, 'lighting: apply failed');
        results.push({ fixture: name, ok: false, error });
      }
    }

    this.state.appliedAt = new Date().toISOString();
    this.state.error = results.every((r) => r.ok) ? null : 'one or more fixtures failed';
    return results;
  }
}
