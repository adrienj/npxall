/**
 * Structured access logging for the API and MCP servers.
 *
 * Before this existed the servers logged nothing per request: the only per-request
 * output was `[cache] Installed <pkg>` on a cache miss. That makes an abuse audit
 * impossible, because a cache hit is invisible, the same line appears whether the
 * package was called once or a million times, and nothing records who asked, what
 * they asked for, or whether it was rejected.
 *
 * This is a public endpoint that installs and executes arbitrary npm packages for
 * unauthenticated callers, so the access log is the only forensic record there is.
 *
 * One JSON object per line, so the log greps and pipes into jq without a parser.
 */

/** Cap on the logged URL so one hostile request cannot flood the log. */
const MAX_PATH_CHARS = 300;

/**
 * Best-effort client IP.
 *
 * The servers sit behind Traefik, so the socket address is the proxy. The left-most
 * entry of X-Forwarded-For is the client as reported by the proxy. It is spoofable by
 * anything upstream of the proxy, so treat it as a hint for correlation, not identity.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || '-';
}

/**
 * Express middleware that logs one line per completed request.
 *
 * @param {string} service - 'api' or 'mcp', so both services can share a log stream
 * @returns {import('express').RequestHandler}
 */
export function requestLogger(service) {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();

    // 'finish' rather than wrapping res.end: it fires once, after the status code is
    // final, including on the error paths.
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const url = req.originalUrl || req.url || '';

      console.log(JSON.stringify({
        t: new Date().toISOString(),
        svc: service,
        ip: clientIp(req),
        method: req.method,
        path: url.length > MAX_PATH_CHARS ? `${url.slice(0, MAX_PATH_CHARS)}...[truncated]` : url,
        status: res.statusCode,
        ms: Math.round(durationMs),
      }));
    });

    next();
  };
}
