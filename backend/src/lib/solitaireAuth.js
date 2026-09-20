// Solitaire's own auth primitives — signing/verifying its session token and
// minting device tokens. Deliberately separate from the main app's
// middleware/auth.js: Solitaire is a self-contained module (see schema.sql's
// "SOLITAIRE MODULE" section and the handoff package's 00_START_HERE.md) —
// a main-app JWT must never be accepted here, and a Solitaire session must
// never be accepted by the main app's requireAuth. Two completely separate
// trust boundaries, on purpose.
import jwt from "jsonwebtoken";
import crypto from "crypto";

const SOLITAIRE_JWT_SECRET = process.env.SOLITAIRE_JWT_SECRET;

// Round 149 — this used to `throw` right here, at import time. That was
// correct about the danger and wrong about the blast radius: importing this
// file is what mounting the module does, so a missing env var took the WHOLE
// backend down — orders, dockets, reports, everyone — over an optional
// plugin nobody may even be using. On a live plant that is a far worse
// outcome than the module being unavailable.
//
// The safety itself is kept exactly: nothing is ever signed or verified with
// an `undefined` secret, because signSolitaireSession and verifySolitaireSession
// below refuse outright, and requireSolitaireConfigured turns that into a
// plain 503 at the edge of the module. So an unconfigured Solitaire is
// unusable and says why, while the rest of the app runs untouched.
export const SOLITAIRE_CONFIGURED = !!SOLITAIRE_JWT_SECRET;

function secretOrThrow() {
  if (!SOLITAIRE_JWT_SECRET) {
    throw new Error(
      "SOLITAIRE_JWT_SECRET env var is required (must be different from the main app's own JWT secret)."
    );
  }
  return SOLITAIRE_JWT_SECRET;
}

// Mount at the top of each Solitaire router, under the plugin gate. A module
// that is switched ON but not configured must say so rather than 500 on every
// call — that is the difference between "somebody forgot an env var" and
// "the app is broken".
export function requireSolitaireConfigured(req, res, next) {
  if (SOLITAIRE_CONFIGURED) return next();
  res.status(503).json({
    error: "This module is enabled but not configured — SOLITAIRE_JWT_SECRET is not set on the backend.",
  });
}

export const SESSION_COOKIE = "solitaire_session";
export const DEVICE_COOKIE = "solitaire_device";
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // one shift
export const DEVICE_MAX_AGE_MS = 5 * 365 * 24 * 60 * 60 * 1000; // effectively "until revoked"

const SESSION_TTL = "12h";

export function signSolitaireSession(account) {
  return jwt.sign(
    { accountId: account.id, role: account.role, username: account.username },
    secretOrThrow(),
    { expiresIn: SESSION_TTL }
  );
}

export function verifySolitaireSession(token) {
  try {
    return jwt.verify(token, secretOrThrow());
  } catch {
    return null;
  }
}

export function generateDeviceToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Shared cookie options. HttpOnly so neither cookie is readable by page JS
// (§2.2 of 02_FUNCTIONAL_SPEC.md: this is a cookie-based lock, not a
// hardware one — HttpOnly at least rules out a same-page script reading
// document.cookie and copying it elsewhere). SOLITAIRE_COOKIE_SECURE=false
// is only for local http development; production must run this over HTTPS.
export function cookieOptions(maxAgeMs) {
  const secure = process.env.SOLITAIRE_COOKIE_SECURE !== "false";
  return {
    httpOnly: true,
    secure,
    // Round 149 — this was "lax", which silently does not work in this app's
    // deployment. The frontend and backend are separate Render services, so
    // every Solitaire call is cross-site, and a browser will not SEND a
    // SameSite=Lax cookie cross-site. The symptom is nasty precisely because
    // it isn't an error: login returns 200, sets the cookie, and the very next
    // request arrives with no session at all.
    //
    // SameSite=None is what permits it, and browsers only accept None on a
    // Secure cookie — hence the pairing. Dropping SameSite protection means
    // CSRF has to be prevented another way, which is what the origin
    // allowlist on the credentialed CORS in index.js is for: only the app's
    // own frontend origin may make a credentialed request at all.
    //
    // Local http development keeps Lax, since None+insecure is simply
    // rejected by the browser and would break the dev flow instead.
    sameSite: secure ? "none" : "lax",
    maxAge: maxAgeMs,
    path: "/",
  };
}
