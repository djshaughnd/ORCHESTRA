import type { ProfileConfig } from './config.js';

export interface ScenePlanCommand {
  device: 'amaran' | 'sony';
  target: string;
  action: string;
  value: boolean | number | string | Record<string, number>;
}

export interface ScenePlan {
  dryRun: true;
  profile: string;
  commands: ScenePlanCommand[];
  warnings: string[];
}

/**
 * Convert a validated profile recipe into an inspectable command plan.
 * Phase 1 intentionally has no executor: this is the safety boundary that lets
 * us review what the AI brain would do before any SDK can change hardware.
 */
export function buildScenePlan(profileName: string, profile: ProfileConfig): ScenePlan {
  const commands: ScenePlanCommand[] = [];
  const warnings: string[] = [];
  const recipe = profile.sceneRecipe;

  if (profile.lightingPreset) {
    commands.push({
      device: 'amaran',
      target: 'all',
      action: 'set_preset_by_name',
      value: profile.lightingPreset,
    });
  }

  if (recipe) {
    for (const [fixture, target] of Object.entries(recipe.lighting.fixtures)) {
      if (target.sleep !== undefined) {
        commands.push({ device: 'amaran', target: fixture, action: 'set_sleep', value: target.sleep });
      }
      if (target.cct !== undefined || target.gm !== undefined) {
        commands.push({
          device: 'amaran',
          target: fixture,
          action: 'set_cct',
          value: {
            ...(target.cct !== undefined ? { cct: target.cct } : {}),
            ...(target.gm !== undefined ? { gm: target.gm } : {}),
            ...(target.intensity !== undefined ? { intensity: target.intensity } : {}),
          },
        });
      } else if (target.intensity !== undefined) {
        commands.push({
          device: 'amaran',
          target: fixture,
          action: 'set_intensity',
          value: target.intensity,
        });
      }
    }

    for (const [camera, target] of Object.entries(recipe.cameras)) {
      if (target.whiteBalanceK !== undefined) {
        commands.push({
          device: 'sony',
          target: camera,
          action: 'set_white_balance_kelvin',
          value: target.whiteBalanceK,
        });
      }
      if (target.shutter !== undefined) {
        commands.push({ device: 'sony', target: camera, action: 'set_shutter', value: target.shutter });
      }
      if (target.aperture !== undefined) {
        commands.push({ device: 'sony', target: camera, action: 'set_aperture', value: target.aperture });
      }
      if (target.iso !== undefined) {
        commands.push({ device: 'sony', target: camera, action: 'set_iso', value: target.iso });
      }
    }

    const lightingCcts = new Set(
      Object.values(recipe.lighting.fixtures)
        .map((fixture) => fixture.cct)
        .filter((value): value is number => value !== undefined),
    );
    const cameraWhiteBalances = new Set(
      Object.values(recipe.cameras)
        .map((camera) => camera.whiteBalanceK)
        .filter((value): value is number => value !== undefined),
    );
    if (lightingCcts.size === 1 && cameraWhiteBalances.size === 1) {
      const [lightingCct] = lightingCcts;
      const [cameraWhiteBalance] = cameraWhiteBalances;
      if (lightingCct !== cameraWhiteBalance) {
        warnings.push(
          `lighting CCT ${lightingCct}K does not match camera white balance ${cameraWhiteBalance}K`,
        );
      }
    }
  }

  if (commands.length === 0) warnings.push('profile has no lighting or camera scene recipe');
  return { dryRun: true, profile: profileName, commands, warnings };
}
