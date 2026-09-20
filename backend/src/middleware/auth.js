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
    // A Super Admin outranks every role, so it passes any check — see the
    // note at the bottom of this file. The one place this must NOT apply is a
    // guard that names super_admin itself, and that still works: the role is
    // in allowedRoles there, so the normal path allows it anyway.
    if (req.user && req.user.role === "super_admin") return next();
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "You don't have access to this." });
    }
    next();
  };
}

// Round 148 — `super_admin` is the TOP role, not a sideways one.
//
// Round 146 introduced it as a twelfth role and guarded `/super-admin` with it,
// which had a consequence nobody wanted: promoting an account to super_admin
// took away every Administrator screen, because each one is guarded
// `requireRole("administrator")` / `roles={["administrator"]}` and super_admin
// is not that string. The first real promotion locked the account out of the
// whole app except the access-control page.
//
// So the rule is now explicit and lives in one place: a Super Admin satisfies
// any role check. `requireRole` below lets it through unconditionally, and
// `isAdminLevel` is how the rest of the code asks "is this an administrator?"
// so that question can never again be asked as a bare string compare that
// silently excludes the one role that outranks it.
//
// Note this deliberately does NOT rewrite `req.user.role` to "administrator".
// Masking it that way would make every existing check pass for free, but it
// would also make a future `req.user.role === "super_admin"` silently false —
// a trap worth more than the few edits avoided.
export function isAdminLevel(role) {
  return role === "administrator" || role === "super_admin";
}
