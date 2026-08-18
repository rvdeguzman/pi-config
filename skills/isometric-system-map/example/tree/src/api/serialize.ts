import type { Record } from '../store/records';

export function toWire(rec: Record) {
  return {
    id: rec.id,
    ts: rec.ts,
    account: rec.accountId,
    geo: rec.geo ?? null,
    org: rec.org ?? null,
  };
}
