import { describe, expect, it } from 'vitest';
import { ProfileSchema } from '../src/config.js';
import { buildScenePlan } from '../src/scene-plan.js';

describe('scene plan safety boundary', () => {
  it('builds an inspectable dry-run with lighting before camera settings', () => {
    const profile = ProfileSchema.parse({
      sceneRecipe: {
        lighting: {
          fixtures: {
            '#1 KEY': { sleep: false, intensity: 450, cct: 5000, gm: 100 },
            'FILL #2': { sleep: false, intensity: 200, cct: 5000, gm: 100 },
          },
        },
        cameras: {
          a7iv: { shutter: '1/60', aperture: 4, iso: 500, whiteBalanceK: 5000 },
        },
      },
    });

    const plan = buildScenePlan('content', profile);
    expect(plan.dryRun).toBe(true);
    expect(plan.warnings).toEqual([]);
    expect(plan.commands[0]).toMatchObject({ device: 'amaran', target: '#1 KEY' });
    expect(plan.commands).toContainEqual({
      device: 'amaran',
      target: '#1 KEY',
      action: 'set_cct',
      value: { cct: 5000, gm: 100, intensity: 450 },
    });
    expect(plan.commands.findIndex((command) => command.device === 'sony')).toBeGreaterThan(
      plan.commands.findLastIndex((command) => command.device === 'amaran'),
    );
    expect(plan.commands).toContainEqual({
      device: 'sony',
      target: 'a7iv',
      action: 'set_iso',
      value: 500,
    });
  });

  it('warns when lighting CCT and camera white balance disagree', () => {
    const profile = ProfileSchema.parse({
      sceneRecipe: {
        lighting: { fixtures: { key: { cct: 5000 } } },
        cameras: { a7iv: { whiteBalanceK: 4300 } },
      },
    });
    expect(buildScenePlan('content', profile).warnings[0]).toMatch(/does not match/);
  });

  it('has no executor and warns for an empty profile', () => {
    const plan = buildScenePlan('default', ProfileSchema.parse({}));
    expect(plan.commands).toEqual([]);
    expect(plan.warnings).toEqual(['profile has no lighting or camera scene recipe']);
  });
});
