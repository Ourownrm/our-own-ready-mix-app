// Bump this every round. App 91 -> "9.1" — this exists specifically so
// everyone can confirm at a glance whether their browser is actually
// serving the latest deploy, since the PWA's service worker can otherwise
// keep an already-open tab on a stale build even after a new one is live.
export const APP_VERSION = "9.27";
