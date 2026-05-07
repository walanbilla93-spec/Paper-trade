// ── Auth middleware — checks X-Auth-Token header ─────────────
// Set AUTH_TOKEN env var in Northflank/Railway.
// If not set, auth is disabled (open — fine for private deployments).
'use strict';

module.exports = function authMiddleware(req, res, next) {
  const token = process.env.AUTH_TOKEN || '';
  if (!token) return next(); // no token configured → open access

  const provided = req.headers['x-auth-token'] || '';
  if (!provided || provided !== token) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
};
