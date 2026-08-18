import { getRecordHandler, listRecordsHandler } from './handlers';

export function registerRoutes(app: any) {
  app.get('/v1/records/:id', getRecordHandler);
  app.get('/v1/records', listRecordsHandler);
  app.get('/healthz', () => new Response('ok'));
}
