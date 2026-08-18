import { enrichSegment } from './enrich';

// Replica count is read from the deployment, not hardcoded here.
const REPLICAS = Number(process.env.WORKER_REPLICAS ?? 5);
const SHARD = Number(process.env.WORKER_SHARD ?? 0);

export function startPool() {
  for (let i = 0; i < REPLICAS; i++) {
    setInterval(() => void tick(SHARD), 250 + i * 17);
  }
}

let cursor = 0;
async function tick(shard: number) {
  try {
    await enrichSegment(cursor, shard);
    cursor++;
  } catch (err) {
    // TODO: no dead-letter path; a poisoned segment stalls this shard forever.
    console.error('worker stalled on segment', cursor, err);
  }
}
