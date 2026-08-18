import type { Envelope } from '../lib/schema';

export interface Record extends Envelope { geo?: string; org?: string; enrichedAt: number }

const generations = ['current', 'daily', 'weekly', 'archive'];

export async function putRecord(rec: Record): Promise<void> {
  await write('current', rec);
}

export async function getRecord(id: string): Promise<Record | null> {
  for (const gen of generations) {
    const hit = await read(gen, id);
    if (hit) return hit;
  }
  return null;
}

export async function compact(from: string, to: string): Promise<number> {
  const moved = await roll(from, to);
  return moved;
}

async function write(_gen: string, _rec: Record) {}
async function read(_gen: string, _id: string): Promise<Record | null> { return null; }
async function roll(_a: string, _b: string): Promise<number> { return 0; }
