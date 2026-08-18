import { readFile, appendFile } from 'node:fs/promises';
import type { Envelope } from '../lib/schema';

const SEGMENT_BYTES = 64 * 1024 * 1024;

export interface Segment { id: number; path: string; bytes: number }

let head: Segment = { id: 0, path: 'data/log/000000.seg', bytes: 0 };

export async function appendToLog(env: Envelope): Promise<number> {
  const line = JSON.stringify(env) + '\n';
  if (head.bytes + line.length > SEGMENT_BYTES) head = await roll(head);
  await appendFile(head.path, line);
  head.bytes += line.length;
  return head.id;
}

export async function readSegment(id: number): Promise<Envelope[]> {
  const raw = await readFile(`data/log/${String(id).padStart(6, '0')}.seg`, 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function roll(prev: Segment): Promise<Segment> {
  return { id: prev.id + 1, path: `data/log/${String(prev.id + 1).padStart(6, '0')}.seg`, bytes: 0 };
}
