import { getRecord } from '../store/records';
import { toWire } from './serialize';

export async function getRecordHandler(req: any) {
  const rec = await getRecord(req.params.id);
  if (!rec) return new Response('not found', { status: 404 });
  return Response.json(toWire(rec));
}

export async function listRecordsHandler(_req: any) {
  // Unbounded scan: this is the slow path everyone complains about.
  return Response.json([]);
}
