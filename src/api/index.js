// API v2 scaffold (plan F1). Each route module exports (ctx) => [{ method, re, run }]. run receives { m, body, query } and
// returns the JSON body; errors are thrown as httpError and reach the client through server.js's catch. The security gate
// (Host, Origin, session cookie, JSON content type) stays in server.js, so it covers every v2 route the same way.
// server.js calls handle() for GET requests before the static fallback and for POST requests after the JSON body is read.
const MODULES = [require('./run'), require('./runs'), require('./ask'), require('./handoff'), require('./preflight')];

function queryOf(url) {
  try { return Object.fromEntries(new URL(String(url), 'http://x').searchParams); } catch { return {}; }
}

function createApiV2(ctx) {
  const routes = MODULES.flatMap((mod) => mod(ctx));
  // Resolves true when a route answered the request, false when none matched (the caller decides what comes next).
  async function handle(req, res, pathname, body = null) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const out = await r.run({ m, body, query: queryOf(req.url) });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out ?? {}));
      return true;
    }
    return false;
  }
  return { handle, routes };
}

module.exports = { createApiV2 };
