// Round 269 — the outside services the Marketing module talks to: Google
// Drive (where the library's files live), the WhatsApp Cloud API, and email.
// Settings and secrets live in mkt_settings (one row): the Administrator
// enters them on Marketing › Settings, so nothing has to be added on Render.
// Secrets are never sent back to a browser.
//
// GOOGLE DRIVE uses the owner's own Google account (OAuth, scope drive.file),
// not a service account: since 2024 a service account cannot store files in
// an ordinary (non-Workspace) Drive, which is what ourownrm@gmail.com has.
// drive.file lets the app see ONLY the files and folders it created itself.
import crypto from "crypto";
import { Readable } from "stream";
import { query } from "../db.js";

// ---------------- settings ----------------
export const DEFAULT_DATA = {
  firm_types: ["Builder / developer", "Contractor", "Architect", "Structural consultant", "Engineer", "Government / PWD", "Individual house owner", "Dealer / supplier", "Other"],
  categories: ["Follow-up call", "Price revision", "Offer / new product", "Technical note", "Festival greeting", "Birthday wish", "Project update"],
  firm_categories: ["A — regular buyer", "B — occasional", "C — prospect"],
  levels: { 1: "Decision maker", 2: "Purchase / project", 3: "Site" },
  festivals: [],
  require_consent: true,
  min_days_between: 0,
  public_origin: null,
  wa: { phone_number_id: "", waba_id: "", api_version: "v21.0", templates: { link: { name: "", lang: "en" }, poster: { name: "", lang: "en" }, video: { name: "", lang: "en" }, pdf: { name: "", lang: "en" }, brochure: { name: "", lang: "en" } } },
  email: { from_name: "Our Own Ready Mix", from_email: "" },
  drive: { folder_id: null, folders: {}, account: null },
};

export async function loadSettings() {
  const { rows } = await query(`SELECT data, secrets FROM mkt_settings WHERE id = 1`);
  const r = rows[0] || { data: {}, secrets: {} };
  const d = r.data || {};
  const data = {
    ...DEFAULT_DATA, ...d,
    levels: { ...DEFAULT_DATA.levels, ...(d.levels || {}) },
    wa: { ...DEFAULT_DATA.wa, ...(d.wa || {}), templates: { ...DEFAULT_DATA.wa.templates, ...((d.wa || {}).templates || {}) } },
    email: { ...DEFAULT_DATA.email, ...(d.email || {}) },
    drive: { ...DEFAULT_DATA.drive, ...(d.drive || {}) },
  };
  return { data, secrets: r.secrets || {} };
}
export async function saveData(patch, userId) {
  await query(`UPDATE mkt_settings SET data = data || $1::jsonb, updated_by = $2, updated_at = now() WHERE id = 1`, [JSON.stringify(patch), userId || null]);
}
export async function saveSecrets(patch) {
  await query(`UPDATE mkt_settings SET secrets = secrets || $1::jsonb, updated_at = now() WHERE id = 1`, [JSON.stringify(patch)]);
}

// The backend's own public address, as the request reached it (Render sits
// behind a proxy, so the forwarded headers are the truth).
export function backendBase(req) {
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  return `${proto}://${req.get("x-forwarded-host") || req.get("host")}`;
}

// ---------------- signed media links ----------------
// For WhatsApp (Meta downloads the header media from a URL) and for previews
// inside the app (an <img>/<video> cannot carry the sign-in token).
function secret() { return process.env.JWT_SECRET || "oorm-dev-secret"; }
export function mediaSig(itemId, exp) {
  return crypto.createHmac("sha256", secret()).update(`mkt-media:${itemId}:${exp}`).digest("hex").slice(0, 32);
}
export function mediaPath(itemId, hours = 48) {
  const exp = Math.floor(Date.now() / 1000) + hours * 3600;
  return `/api/marketing-public/media/${itemId}/${exp}/${mediaSig(itemId, exp)}`;
}
export function mediaSigOk(itemId, exp, sig) {
  if (!(Number(exp) * 1000 > Date.now())) return false;
  const want = Buffer.from(mediaSig(itemId, exp));
  const got = Buffer.from(String(sig || ""));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
export function stateToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 15 * 60 * 1000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(`mkt-state:${body}`).digest("base64url");
  return `${body}.${sig}`;
}
export function readState(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", secret()).update(`mkt-state:${body}`).digest("base64url");
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  return p.exp > Date.now() ? p : null;
}

// ---------------- Google Drive ----------------
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export function driveConnectUrl(clientId, redirectUri, state) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: DRIVE_SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  }).toString();
  return u.toString();
}

export async function driveExchangeCode(code, redirectUri) {
  const { secrets } = await loadSettings();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: secrets.google_client_id || "", client_secret: secrets.google_client_secret || "", redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const j = await res.json();
  if (!res.ok || !j.refresh_token) throw new Error(j.error_description || j.error || "Google did not return a refresh token.");
  await saveSecrets({ google_refresh_token: j.refresh_token });
  tokenCache = { token: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
  return j;
}

let tokenCache = { token: null, until: 0 };
export async function driveToken() {
  if (tokenCache.token && tokenCache.until > Date.now()) return tokenCache.token;
  const { secrets } = await loadSettings();
  if (!secrets.google_refresh_token) throw Object.assign(new Error("Google Drive is not connected — Marketing › Settings."), { code: "drive_off" });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: secrets.google_client_id || "", client_secret: secrets.google_client_secret || "", refresh_token: secrets.google_refresh_token, grant_type: "refresh_token" }),
  });
  const j = await res.json();
  if (!res.ok) throw Object.assign(new Error(`Google Drive refused the connection (${j.error || res.status}) — connect it again in Marketing › Settings.`), { code: "drive_off" });
  tokenCache = { token: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
  return j.access_token;
}
export function driveForget() { tokenCache = { token: null, until: 0 }; }

async function driveJson(path, opts = {}) {
  const token = await driveToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, { ...opts, headers: { authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Drive: ${j.error?.message || res.status}`);
  return j;
}

export async function driveAccount() {
  const j = await driveJson("about?fields=user(emailAddress,displayName)");
  return j.user?.emailAddress || null;
}

async function makeFolder(name, parent) {
  const j = await driveJson("files?fields=id", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", ...(parent ? { parents: [parent] } : {}) }),
  });
  return j.id;
}
const KIND_FOLDER = { poster: "Posters", video: "Videos", pdf: "Technical PDFs", brochure: "Brochures" };

// The Marketing folder and one sub-folder per kind, made on first use.
export async function driveFolderFor(kind) {
  const { data } = await loadSettings();
  let root = data.drive.folder_id;
  if (!root) {
    root = await makeFolder("Our Own Ready Mix — Marketing");
    await saveData({ drive: { ...data.drive, folder_id: root, folders: {} } });
    data.drive.folder_id = root; data.drive.folders = {};
  }
  if (data.drive.folders?.[kind]) return data.drive.folders[kind];
  const id = await makeFolder(KIND_FOLDER[kind] || "Other", root);
  await saveData({ drive: { ...data.drive, folders: { ...(data.drive.folders || {}), [kind]: id } } });
  return id;
}

// Streams an upload (the incoming request) straight into Drive, resumable
// protocol, so a 90 MB video never sits in the server's memory.
export async function driveUploadStream(stream, { name, mime, size, folderId }) {
  const token = await driveToken();
  const init = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,mimeType", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-type": mime, "x-upload-content-length": String(size) },
    body: JSON.stringify({ name, parents: folderId ? [folderId] : undefined }),
  });
  if (!init.ok) throw new Error(`Google Drive would not start the upload (${init.status}).`);
  const location = init.headers.get("location");
  const put = await fetch(location, {
    method: "PUT", headers: { "content-type": mime, "content-length": String(size) },
    body: Readable.toWeb(stream), duplex: "half",
  });
  const j = await put.json().catch(() => ({}));
  if (!put.ok || !j.id) throw new Error(`Google Drive upload failed (${put.status}).`);
  return j;
}

// Streams a Drive file to the response, passing Range through so a video can
// be scrubbed. Returns the status sent.
export async function drivePipe(fileId, req, res, { name, mime, download } = {}) {
  const token = await driveToken();
  const headers = { authorization: `Bearer ${token}` };
  if (req.headers.range) headers.range = req.headers.range;
  const up = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers });
  if (!up.ok && up.status !== 206) { res.status(up.status === 404 ? 404 : 502).end(); return up.status; }
  res.status(up.status);
  for (const h of ["content-length", "content-range", "accept-ranges"]) if (up.headers.get(h)) res.setHeader(h, up.headers.get(h));
  res.setHeader("content-type", mime || up.headers.get("content-type") || "application/octet-stream");
  res.setHeader("cache-control", "private, max-age=300");
  if (name) res.setHeader("content-disposition", `${download ? "attachment" : "inline"}; filename="${String(name).replace(/[^\w.\- ]/g, "_")}"`);
  if (!up.headers.get("accept-ranges")) res.setHeader("accept-ranges", "bytes");
  Readable.fromWeb(up.body).pipe(res);
  return up.status;
}

// ---------------- WhatsApp Cloud API ----------------
// Templates the app expects (Meta approves each; names set in Settings):
//   link template      body {{1}} = person's name, {{2}} = title; one URL
//                      button whose dynamic part {{1}} is the tracking code.
//   poster/video/pdf/brochure templates — the same, plus an IMAGE / VIDEO /
//                      DOCUMENT header that the app fills with the file.
// A file bigger than WhatsApp allows in a header goes with the link template.
export const WA_MEDIA_LIMIT = { poster: 5 * 1024 * 1024, video: 16 * 1024 * 1024, pdf: 100 * 1024 * 1024, brochure: 100 * 1024 * 1024 };
const HEADER_TYPE = { poster: "image", video: "video", pdf: "document", brochure: "document" };

export function waNumber(mobile) {
  const d = String(mobile || "").replace(/\D/g, "");
  if (d.length === 10) return `91${d}`;
  if (d.length === 12 && d.startsWith("91")) return d;
  if (d.length === 11 && d.startsWith("0")) return `91${d.slice(1)}`;
  return d.length >= 11 ? d : null;
}

export async function waSendTemplate({ to, item, mediaUrl, name, title, token }) {
  const { data, secrets } = await loadSettings();
  if (!secrets.wa_token || !data.wa.phone_number_id) throw new Error("WhatsApp API is not set up — Marketing › Settings.");
  const kindT = item && data.wa.templates[item.kind];
  const useMedia = !!(item && kindT?.name && mediaUrl && Number(item.size_bytes || 0) <= (WA_MEDIA_LIMIT[item.kind] || 0));
  const tpl = useMedia ? kindT : data.wa.templates.link;
  if (!tpl?.name) throw new Error("No WhatsApp template is set in Marketing › Settings.");
  const components = [];
  if (useMedia) {
    const ht = HEADER_TYPE[item.kind];
    const media = { link: mediaUrl };
    if (ht === "document") media.filename = item.file_name || `${title}.pdf`;
    components.push({ type: "header", parameters: [{ type: ht, [ht]: media }] });
  }
  components.push({ type: "body", parameters: [{ type: "text", text: (name || "Sir/Madam").replace(/\s+/g, " ").slice(0, 60) }, { type: "text", text: (title || "").replace(/\s+/g, " ").slice(0, 200) }] });
  components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: token }] });
  const res = await fetch(`https://graph.facebook.com/${data.wa.api_version || "v21.0"}/${data.wa.phone_number_id}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${secrets.wa_token}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: tpl.name, language: { code: tpl.lang || "en" }, components } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.error_data?.details || j.error?.message || `WhatsApp error ${res.status}`);
  return j.messages?.[0]?.id || null;
}

export function waSignatureOk(rawBody, header, appSecret) {
  if (!appSecret) return true; // not set: accepted (Settings says to set it)
  if (!rawBody || !header) return false;
  const want = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return want.length === header.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(header));
}

// ---------------- email ----------------
let mailer = null, mailerKey = "";
export async function emailReady() {
  const { secrets } = await loadSettings();
  return !!(secrets.smtp?.host && secrets.smtp?.user && secrets.smtp?.pass);
}
export async function sendEmail({ to, subject, html, text }) {
  const { data, secrets } = await loadSettings();
  const s = secrets.smtp || {};
  if (!s.host) throw new Error("Email is not set up — Marketing › Settings.");
  const key = `${s.host}|${s.port}|${s.user}`;
  if (!mailer || mailerKey !== key) {
    const nodemailer = (await import("nodemailer")).default;
    mailer = nodemailer.createTransport({ host: s.host, port: Number(s.port) || 465, secure: (Number(s.port) || 465) === 465, auth: { user: s.user, pass: s.pass } });
    mailerKey = key;
  }
  const from = `"${(data.email.from_name || "Our Own Ready Mix").replace(/"/g, "")}" <${data.email.from_email || s.user}>`;
  const info = await mailer.sendMail({ from, to, subject, html, text });
  return info.messageId;
}
export function forgetMailer() { mailer = null; mailerKey = ""; }
