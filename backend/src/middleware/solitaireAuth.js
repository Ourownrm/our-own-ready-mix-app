// Solitaire's own auth middleware — checks BOTH who (the signed session)
// and which browser/machine (the device allowlist) on every request, not
// just at login, so revoking a device from the Admin's Device Management
// screen takes effect immediately rather than only on that device's next
// login. See 02_FUNCTIONAL_SPEC.md §2.2.
//
// requires cookie-parser to be mounted on the Express app (req.cookies) —
// see INTEGRATION_NOTES.md.
import { query } from "../db.js";
import { verifySolitaireSession, SESSION_COOKIE, DEVICE_COOKIE } from "../lib/solitaireAuth.js";

const DEVICE_ERROR = {
  error: "This browser/device is not authorized to open Solitaire. Contact your Administrator.",
  code: "DEVICE_NOT_AUTHORIZED",
};

export async function requireSolitaireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  const payload = token && verifySolitaireSession(token);
  if (!payload) return res.status(401).json({ error: "Not signed in to Solitaire." });

  const deviceToken = req.cookies?.[DEVICE_COOKIE];
  if (!deviceToken) return res.status(403).json(DEVICE_ERROR);

  const { rows: deviceRows } = await query(
    `SELECT id FROM solitaire_devices WHERE device_token = $1 AND revoked_at IS NULL`,
    [deviceToken]
  );
  if (!deviceRows.length) return res.status(403).json(DEVICE_ERROR);

  const { rows: accountRows } = await query(
    `SELECT id, username, role, display_name, is_active FROM solitaire_accounts WHERE id = $1`,
    [payload.accountId]
  );
  const account = accountRows[0];
  if (!account || !account.is_active) {
    return res.status(401).json({ error: "This Solitaire account is no longer active." });
  }

  // Fire-and-forget — not worth blocking the request on a last-used stamp.
  query(`UPDATE solitaire_devices SET last_used_at = now() WHERE device_token = $1`, [deviceToken]).catch(() => {});

  req.solitaireAccount = account;
  next();
}

export function requireSolitaireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.solitaireAccount.role)) {
      return res.status(403).json({ error: "Not permitted for your Solitaire role." });
    }
    next();
  };
}
