const TOKENS = new Set((process.env.API_TOKENS ?? '').split(',').filter(Boolean));

export function requireToken(req: any, _res: any, next: Function) {
  const header = String(req.headers?.authorization ?? '');
  const token = header.replace(/^Bearer\s+/i, '');
  if (!TOKENS.has(token)) throw new Error('unauthorized');
  next();
}
