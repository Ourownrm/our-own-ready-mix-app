import jwt from "jsonwebtoken";

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in to continue." });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Belt-and-suspenders (round 119): customer-portal sessions are signed
    // with their own CUSTOMER_JWT_SECRET (see routes/customerPortal.js), so
    // in normal operation they'd fail verification above and never reach
    // here. This check only matters in the one misconfiguration case where
    // CUSTOMER_JWT_SECRET is unset and silently falls back to this same
    // JWT_SECRET — without it, a customer's access-code session would pass
    // straight through as a staff session on any route that checks nothing
    // more than "is this person signed in" (requireAuth with no
    // requireRole after it, e.g. most of routes/masterData.js), exposing
    // staff-only master data to a customer. Reject it explicitly so that
    // misconfiguration fails safe instead of quietly working.
    if (payload && payload.type === "customer") {
      return res.status(401).json({ error: "Sign in to continue." });
    }
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Your session expired. Sign in again." });
  }
}

// Usage: requireRole('manager', 'administrator')
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "You don't have access to this." });
    }
    next();
  };
}
