import { validateEnvelope } from './validate';
import { appendToLog } from '../queue/log';
import { counter } from '../observability/metrics';

const accepted = counter('ingest_accepted_total');
const rejected = counter('ingest_rejected_total');

export async function handleIngest(req: Request): Promise<Response> {
  const body = await req.json();
  const verdict = validateEnvelope(body);
  if (!verdict.ok) {
    rejected.inc();
    return new Response(verdict.reason, { status: 422 });
  }
  // Durable append happens before we acknowledge the caller.
  await appendToLog(verdict.envelope);
  accepted.inc();
  return new Response(null, { status: 202 });
}

export function mountIngest(app: { post: Function }) {
  app.post('/v1/events', handleIngest);
}
