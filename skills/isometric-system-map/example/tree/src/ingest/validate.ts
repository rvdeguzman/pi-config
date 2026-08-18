import { EnvelopeSchema, type Envelope } from '../lib/schema';

export type Verdict =
  | { ok: true; envelope: Envelope }
  | { ok: false; reason: string };

export function validateEnvelope(raw: unknown): Verdict {
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: parsed.error.message };
  if (parsed.data.ts < Date.now() - 86_400_000) {
    return { ok: false, reason: 'envelope older than 24h' };
  }
  return { ok: true, envelope: parsed.data };
}
