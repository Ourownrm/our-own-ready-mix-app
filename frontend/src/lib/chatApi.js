// Round 268 — Team Chat: the small shared pieces (the header badge, photo
// loading, shrinking a photo on the phone, the "ask every few seconds" timer).
// The screen itself is pages/TeamChat.jsx; the server side routes/chat.js.
//
// No live connection by design (owner: "without costing anything extra in
// render"): the app asks the server at intervals, and stops asking whenever
// the app is in the background.
import { useEffect, useRef, useState } from "react";
import { apiRequest, BASE_URL } from "./api.js";

export const CHAT = "/notifications/chat";

export const ROLE_NAMES = {
  super_admin: "Super Admin", administrator: "Administrator", manager: "Manager", plant_operator: "Plant Operator",
  qc_engineer: "QC Engineer", driver: "Driver", site_supervisor: "Site Supervisor", accountant: "Accountant",
  sales_executive: "Sales Executive", store: "Store", lab_technician: "Lab Technician",
  loader_operator: "Loader Operator", plant_in_charge: "Plant In Charge",
};

// ---- the unread badge in the header ---------------------------------------
// One shared count for the whole app: TopBar mounts again on every screen, and
// without this each screen change would ask the server again.
const badge = { count: 0, at: 0, every: 60, subs: new Set(), timer: null, busy: false };

async function refreshBadge(force = false) {
  if (badge.busy) return;
  if (!force && Date.now() - badge.at < 15_000) return;
  if (typeof document !== "undefined" && document.hidden) return;
  badge.busy = true;
  try {
    const r = await apiRequest(`${CHAT}/unread`);
    badge.count = r.count || 0;
    if (r.poll_badge_s) badge.every = r.poll_badge_s;
    badge.at = Date.now();
    badge.subs.forEach((fn) => fn(badge.count));
  } catch {
    // No access, or offline: keep quiet; the badge just stays as it was.
    badge.at = Date.now();
  } finally {
    badge.busy = false;
  }
}

function scheduleBadge() {
  clearTimeout(badge.timer);
  badge.timer = setTimeout(async () => {
    await refreshBadge(true);
    if (badge.subs.size) scheduleBadge();
  }, badge.every * 1000);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && badge.subs.size) refreshBadge();
  });
}

/** The number of unread chat messages; `enabled` false = never asks. */
export function useChatUnread(enabled) {
  const [count, setCount] = useState(badge.count);
  useEffect(() => {
    if (!enabled) return undefined;
    badge.subs.add(setCount);
    setCount(badge.count);
    refreshBadge();
    if (badge.subs.size === 1) scheduleBadge();
    return () => {
      badge.subs.delete(setCount);
      if (!badge.subs.size) clearTimeout(badge.timer);
    };
  }, [enabled]);
  return enabled ? count : 0;
}

/** The chat screen calls this after reading, so the header badge drops at once. */
export function bumpChatBadge() {
  refreshBadge(true);
}

// ---- asking every N seconds, only while the app is in front ---------------
export function usePolling(fn, seconds, deps) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!seconds) return undefined;
    let stopped = false;
    let timer = null;
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden) {
        try { await saved.current(); } catch { /* the next tick tries again */ }
      }
      if (!stopped) timer = setTimeout(tick, seconds * 1000);
    };
    timer = setTimeout(tick, seconds * 1000);
    const onVisible = () => {
      if (!document.hidden) { clearTimeout(timer); tick(); }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, ...deps]);
}

// ---- photos -----------------------------------------------------------------
// An <img src> cannot carry the sign-in, so a photo is fetched with it and
// shown from memory. Kept for the session, so scrolling back does not refetch.
const photoCache = new Map(); // id -> Promise<objectURL | null>

export function loadChatPhoto(id) {
  if (!photoCache.has(id)) {
    const p = fetch(`${BASE_URL}${CHAT}/photos/${id}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("oorm_token") || ""}` },
    })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? URL.createObjectURL(b) : null))
      .catch(() => { photoCache.delete(id); return null; });
    photoCache.set(id, p);
  }
  return photoCache.get(id);
}

// Shrink a photo on the phone before it is sent: at most 1280 px on the long
// side, JPEG, aiming under ~200 KB. A phone camera's 4–8 MB photo becomes
// about 150 KB, which is what keeps the database (and so the bill) small.
const TARGET = 200 * 1024;

async function decode(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* fall back below */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file could not be opened as a photo.")); };
    img.src = url;
  });
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ""));
    fr.onerror = () => reject(new Error("The photo could not be read."));
    fr.readAsDataURL(blob);
  });
}

export async function shrinkPhoto(file) {
  if (!file || !/^image\//.test(file.type || "image/")) throw new Error("Pick a photo (JPG or PNG).");
  const img = await decode(file);
  const w0 = img.width, h0 = img.height;
  let max = 1280, quality = 0.72, blob = null, w = w0, h = h0;
  for (let i = 0; i < 8; i += 1) {
    const scale = Math.min(1, max / Math.max(w0, h0));
    w = Math.max(1, Math.round(w0 * scale));
    h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    blob = await toBlob(canvas, quality);
    if (!blob) throw new Error("This phone could not prepare the photo.");
    if (blob.size <= TARGET) break;
    if (quality > 0.5) quality -= 0.1; else max = Math.round(max * 0.8);
  }
  if (img.close) img.close();
  return {
    mime: "image/jpeg", width: w, height: h, bytes: blob.size,
    data: await blobToBase64(blob), preview: URL.createObjectURL(blob),
  };
}
