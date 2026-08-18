import { readSegment } from '../queue/log';
import { putRecord } from '../store/records';
import { lookupGeo, lookupOrg } from '../lib/schema';

export async function enrichSegment(segmentId: number, shard: number) {
  const batch = await readSegment(segmentId);
  for (const env of batch) {
    if (hash(env.id) % 8 !== shard) continue;
    const record = {
      ...env,
      geo: await lookupGeo(env.ip),
      org: await lookupOrg(env.accountId),
      enrichedAt: Date.now(),
    };
    await putRecord(record);
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
