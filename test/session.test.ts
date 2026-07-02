import { describe, expect, it } from 'vitest';
import {
  makeMarker,
  namePartsForNow,
  renderNameTemplate,
  slugify,
} from '../src/session.js';

describe('session name templating', () => {
  it('renders {date}_{time}_{slug}', () => {
    const now = new Date(2026, 6, 2, 14, 5); // 2026-07-02 14:05 local
    const parts = namePartsForNow(now, 'Podcast Ep 12', 'podcast');
    const name = renderNameTemplate('{date}_{time}_{slug}', parts);
    expect(name).toBe('2026-07-02_1405_podcast-ep-12');
  });

  it('supports {profile} in templates', () => {
    const now = new Date(2026, 0, 9, 9, 0);
    const parts = namePartsForNow(now, undefined, 'music');
    expect(renderNameTemplate('{date}_{profile}', parts)).toBe('2026-01-09_music');
  });

  it('unknown placeholders render empty, not literal', () => {
    const parts = namePartsForNow(new Date(2026, 0, 1, 0, 0));
    expect(renderNameTemplate('{date}{bogus}', parts)).toBe('2026-01-01');
  });

  it('slugify handles messy names', () => {
    expect(slugify('  DJ Set!! @ Loft #3 ')).toBe('dj-set-loft-3');
    expect(slugify('***')).toBe('session');
  });
});

describe('marker math', () => {
  it('computes ms since record start', () => {
    const start = new Date('2026-07-02T20:00:00.000Z');
    const now = new Date('2026-07-02T20:03:30.500Z');
    const m = makeMarker(now, start, 'good take');
    expect(m.sinceRecordStartMs).toBe(210_500);
    expect(m.label).toBe('good take');
    expect(m.t).toBe(now.toISOString());
  });

  it('is null when recording has not started', () => {
    const m = makeMarker(new Date(), null);
    expect(m.sinceRecordStartMs).toBeNull();
    expect(m.label).toBeNull();
  });

  it('clamps negative elapsed to 0 (clock weirdness)', () => {
    const start = new Date('2026-07-02T20:00:10.000Z');
    const now = new Date('2026-07-02T20:00:00.000Z');
    expect(makeMarker(now, start).sinceRecordStartMs).toBe(0);
  });
});
