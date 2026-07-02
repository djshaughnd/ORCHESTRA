import { describe, expect, it } from 'vitest';
import { buildTakeFilename } from '../src/rename.js';
import { namePartsForNow } from '../src/session.js';

describe('take file renaming', () => {
  const parts = {
    ...namePartsForNow(new Date(2026, 6, 2, 14, 5), 'Ep 12', 'podcast'),
    take: '1',
  };

  it('renames to the profile template, keeping dir and extension', () => {
    const out = buildTakeFilename(
      '{date}_{profile}_take{take}',
      parts,
      '/rec/sess/2026-07-02 20-01-11.mkv',
    );
    expect(out).toBe('/rec/sess/2026-07-02_podcast_take1.mkv');
  });

  it('supports slug in file templates', () => {
    const out = buildTakeFilename('{slug}_take{take}', parts, '/rec/s/raw.mp4');
    expect(out).toBe('/rec/s/ep-12_take1.mp4');
  });

  it('increments naturally with the take counter', () => {
    const out = buildTakeFilename(
      '{date}_take{take}',
      { ...parts, take: '7' },
      '/rec/s/x.mov',
    );
    expect(out).toBe('/rec/s/2026-07-02_take7.mov');
  });
});
