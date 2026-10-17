import { readFileSync } from 'node:fs';
import { parseVideos, type Video } from './domain.ts';

export interface InventoryProvider { listVideos(): Video[] }
export class InventoryError extends Error {}
export class FixtureInventoryProvider implements InventoryProvider {
  path: string | URL;
  constructor(path: string | URL) { this.path = path; }
  listVideos(): Video[] {
    try { return parseVideos(JSON.parse(readFileSync(this.path, 'utf8'))); }
    catch { throw new InventoryError('Inventory unavailable: fixture could not be read or validated.'); }
  }
}
