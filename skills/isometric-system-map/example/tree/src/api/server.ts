import { registerRoutes } from './routes';
import { requireToken } from '../auth/gate';
import { mountIngest } from '../ingest/gateway';

export function createServer() {
  const app = makeApp();
  app.use(requireToken);
  mountIngest(app);
  registerRoutes(app);
  return app;
}

function makeApp(): any {
  return { use() {}, get() {}, post() {} };
}
