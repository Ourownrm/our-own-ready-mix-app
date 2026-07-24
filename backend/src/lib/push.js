import webpush from "web-push";
import { query } from "../db.js";

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails("mailto:admin@ourownreadymix.example", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

// Sends to every subscribed device for a given set of subscription rows.
// Automatically forgets a subscription if the push service reports it's gone
// (410/404 — the usual "user uninstalled / revoked permission" response),
// so the list doesn't slowly fill up with dead endpoints.
async function sendToSubscriptions(subscriptions, payload) {
  if (!ensureConfigured() || subscriptions.length === 0) return;
  const body = JSON.stringify(payload);
  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await query("DELETE FROM push_subscriptions WHERE id = $1", [sub.id]).catch(() => {});
      } else {
        console.error("Push send failed:", err.statusCode, err.message);
      }
    }
  }));
}

// Push to every device belonging to every active user with a given role
// (e.g. every Manager). Use for events that any one of them acting on is fine.
export async function pushToRole(role, payload) {
  const { rows } = await query(
    `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
     FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id
     WHERE u.role = $1 AND u.is_active`,
    [role]
  );
  await sendToSubscriptions(rows, payload);
}

// Push to one specific user's devices (e.g. the Site Supervisor actually
// assigned to that order, not every Site Supervisor in the system).
export async function pushToUser(userId, payload) {
  if (!userId) return;
  const { rows } = await query("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1", [userId]);
  await sendToSubscriptions(rows, payload);
}
