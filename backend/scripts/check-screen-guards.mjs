// Round 260 — the check that would have caught "Plant In Charge sees
// + New order, and saving it says You don't have access to this".
//
// The Access Control page decides who sees a screen and its buttons. If the
// route that screen calls still checks a fixed role list, a person the Super
// Admin gave the screen to is refused on save — and a person the Super Admin
// took it away from could still reach the route directly.
//
// This lists every API call made by the screens the Super Admin controls
// (SCREENS below) and fails when one of them reaches a route guarded only by
// requireRole(...). Such a route must be gated by the screen's own function:
// requirePermission / requireAnyPermission / allow() (lib/permissions.js).
//
// It reads the files as text (like check-guards.mjs), so it understands
// apiRequest("...") / apiRequest(`...`) calls with a literal method only.
//
//     node backend/scripts/check-screen-guards.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, "..");
const FRONTEND_SRC = path.join(BACKEND, "..", "frontend", "src");

// Round 262 — every screen of the app is now opened through the Access
// Control page, so every frontend file is checked. The only routes still
// allowed a role guard are the Super Admin's own (requireRole("super_admin")):
// the Access Control page itself, plugins, C Ledger access, Solitaire access
// and the MCI370 recipe password.
const SCREENS = [/./];

const index = fs.readFileSync(path.join(BACKEND, "src", "index.js"), "utf8");
const imports = Object.fromEntries([...index.matchAll(/import (\w+) from "\.\/routes\/(\w+)\.js"/g)].map((m) => [m[1], m[2]]));
const mounts = [];
for (const m of index.matchAll(/app\.use\("([^"]+)",\s*(\w+)\)/g)) if (imports[m[2]]) mounts.push({ prefix: m[1], file: imports[m[2]] });

const routes = [];
for (const { prefix, file } of mounts) {
  const src = fs.readFileSync(path.join(BACKEND, "src", "routes", `${file}.js`), "utf8");
  const consts = {};
  for (const m of src.matchAll(/const (\w+) = (requireRole\([^)]*\)|requirePermission\([^)]*\)|requireAnyPermission\([^)]*\]\s*(?:,\s*"\w+")?\)|allow\(.*\));/g)) consts[m[1]] = m[2];
  const wildcard = {};
  for (const m of src.matchAll(/router\.(get|post|patch|put|delete)\("\*",\s*(allow\(.*\)|requirePermission\(.*\))\);/g)) wildcard[m[1].toUpperCase()] = m[2];
  const fileRole = [...src.matchAll(/router\.use\(([^;]*?)\);/g)].some((m) => m[1].includes("requireRole"));
  const lines = src.split("\n");
  for (const [i, line] of lines.entries()) {
    const m = line.match(/router\.(get|post|patch|put|delete)\(\s*"([^"]+)"\s*,(.*)$/);
    if (!m || m[2] === "*") continue;
    let guards = m[3];
    let j = i;
    while (!/async|\(req|=>/.test(guards) && j < i + 4) guards += lines[++j];
    guards = guards.split(/async|\(req,/)[0].replace(/\b([A-Z_][A-Z0-9_]*)\b/g, (w) => consts[w] || w) + " " + (wildcard[m[1].toUpperCase()] || "");
    const perm = /requirePermission|requireAnyPermission|allow\(/.test(guards);
    const roleSrc = guards + " " + (fileRole ? [...src.matchAll(/router\.use\(([^;]*?)\);/g)].map((x) => x[1]).join(" ") : "");
    const onlySuper = [...roleSrc.matchAll(/requireRole\(([^)]*)\)/g)].every((x) => x[1].trim() === '"super_admin"');
    const role = (/requireRole/.test(guards) || fileRole) && !onlySuper;
    const p = (prefix + (m[2] === "/" ? "" : m[2])).replace(/\(\\\\d\+\)/g, "");
    const re = new RegExp("^" + p.replace(/\(\\d\+\)/g, "").replace(/:\w+(\([^)]*\))?/g, "[^/]+").replace(/\//g, "\\/") + "$");
    routes.push({ method: m[1].toUpperCase(), path: p, re, roleOnly: role && !perm, at: `${file}.js:${i + 1}` });
  }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const problems = [];
let calls = 0;
for (const f of walk(FRONTEND_SRC)) {
  const rel = path.relative(FRONTEND_SRC, f).split(path.sep).join("/");
  if (!SCREENS.some((re) => re.test(rel))) continue;
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/apiRequest\(\s*[`"']([^`"']+)[`"'](?:\s*,\s*\{\s*method:\s*"(\w+)")?/g)) {
    const url = "/api" + m[1].split("?")[0].replace(/\$\{[^}]*\}/g, "X");
    const method = (m[2] || "GET").toUpperCase();
    const hit = routes.find((r) => r.method === method && r.re.test(url));
    if (!hit) continue;
    calls++;
    if (hit.roleOnly) problems.push(`${rel}  →  ${method} ${hit.path}  (${hit.at}) is guarded by a role list only`);
  }
}

console.log(`Checked ${calls} call(s) from Access-Control screens against their routes.`);
if (problems.length) {
  console.error(`\n${[...new Set(problems)].join("\n")}\n\nGate these routes by the screen's own function (lib/permissions.js allow / requirePermission).`);
  process.exit(1);
}
console.log("Every Access-Control screen calls routes gated by functions, not role lists.");
