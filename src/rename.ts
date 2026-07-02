import { dirname, extname, join } from 'node:path';
import { renderNameTemplate, type NameParts } from './session.js';

/**
 * Build the final filename for a finished take, keeping the original
 * extension and directory. e.g.
 *   template "{date}_{profile}_take{take}" + "/x/2026-07-02 20-01-11.mkv"
 *   → "/x/2026-07-02_podcast_take1.mkv"
 */
export function buildTakeFilename(
  template: string,
  parts: NameParts & { take: string },
  originalPath: string,
): string {
  const ext = extname(originalPath);
  const name = renderNameTemplate(template, parts);
  return join(dirname(originalPath), `${name}${ext}`);
}
