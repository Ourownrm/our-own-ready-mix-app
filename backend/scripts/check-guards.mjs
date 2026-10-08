// Round 148 — cross-check the app's TWO access guards against each other.
//
// Every converted route carries both `requireRole(...)` and
// `requirePermission(key, action)`, and both must pass. That design is
// deliberately fail-safe: a permission can never get anyone past a role guard.
// But it has one failure mode, and Round 146 walked straight into it — if a
// role the route ALLOWS is not granted that action by the catalogue's defaults,
// the role guard says yes, the permission guard says no, and that role gets a
// bare 403 on a screen it is supposed to use. Round 146 did exactly this to
// Store and Plant Operator on the Material Module's master-data reads, and
// nobody found out until somebody tried to open the screen.
//
// Nothing in the type system or the tests catches that, because each guard is
// individually correct. This script is what catches it. Run it after adding
// `requirePermission` to any group of routes:
//
//     node backend/scripts/check-guards.mjs
//
// It exits non-zero and lists every (route, role, action) where requireRole
// allows a role that the catalogue does not grant. Administrator and
// Super Admin are skipped — their sets are computed, not seeded.
//
// It reads the route files as TEXT rather than importing them, because
// importing pulls in the database pool. That means it only understands the
// literal `router.METHOD("path", requireRole(...), requirePermission("key",
// "action")` shape; a route that builds its guards some other way is reported
// as unparsed rather than silently passing.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CATALOGUE_BY_KEY } from "../src/lib/permissionCatalogue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(__dirname, "..", "src", "routes");
const COMPUTED = new Set(["administrator", "super_admin"]);

const ROUTE_RE =
  /router\.(get|post|patch|put|delete)\(\s*"([^"]+)"\s*,\s*requireRole\(([^)]*)\)\s*,\s*requirePermission\(\s*"([^"]+)"\s*,\s*"(\w+)"\s*\)/g;

function roleConstants(src) {
  const out = {};
  for (const m of src.matchAll(/const (\w+) = \[([^\]]*)\];/g)) {
    const vals = [...m[2].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    if (vals.length) out[m[1]] = vals;
  }
  return out;
}

function rolesFor(raw, consts) {
  const roles = new Set();
  for (const m of raw.matchAll(/\.\.\.(\w+)|"([a-z_]+)"/g)) {
    if (m[1]) (consts[m[1]] || []).forEach((r) => roles.add(r));
    else if (m[2]) roles.add(m[2]);
  }
  return [...roles];
}

const problems = [];
let checked = 0;

for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".js"))) {
  const src = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
  if (!src.includes("requirePermission")) continue;
  const consts = roleConstants(src);

  for (const m of src.matchAll(ROUTE_RE)) {
    const [, method, route, rawRoles, key, action] = m;
    checked++;
    const entry = CATALOGUE_BY_KEY[key];
    if (!entry) {
      problems.push(`${file}  ${method.toUpperCase()} ${route}  →  no catalogue entry for "${key}"`);
      continue;
    }
    if (!entry.actions.includes(action)) {
      problems.push(`${file}  ${method.toUpperCase()} ${route}  →  "${key}" has no "${action}" action`);
      continue;
    }
    for (const role of rolesFor(rawRoles, consts)) {
      if (COMPUTED.has(role)) continue;
      if (!(entry.roles?.[role] || []).includes(action)) {
        problems.push(
          `${file}  ${method.toUpperCase()} ${route}  →  requireRole allows "${role}" but ` +
          `"${key}" grants it no "${action}" by default (that role gets a 403)`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Round 192 — routes where the permission is the ONLY guard.
//
// For the user's modules the role guard was removed so a Super Admin's grant
// actually takes effect. Two things can quietly undo that, and both are
// checked here:
//   1. a key or action that does not exist (a typo) — the route would 403
//      for everyone but the Administrator, whose set is computed;
//   2. somebody adding requireRole back in front of one of these routes —
//      that brings back exactly the bug the user reported (grants that do
//      nothing). In the files below a role guard may only appear on a route
//      with NO permission guard (the Administrator-only extras).
// ---------------------------------------------------------------------------
const PERMISSION_ONLY_FILES = new Set(["weighbridge.js", "plant.js", "materialModule.js", "labTechnician.js"]);
let permOnly = 0;
for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".js"))) {
  const src = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
  for (const m of src.matchAll(/requirePermission\(\s*"([^"]+)"\s*,\s*"(\w+)"\s*\)/g)) {
    const [, key, action] = m;
    const entry = CATALOGUE_BY_KEY[key];
    if (!entry) problems.push(`${file}  requirePermission("${key}") — no such function in the catalogue`);
    else if (!entry.actions.includes(action)) problems.push(`${file}  requirePermission("${key}", "${action}") — that function has no ${action}`);
    permOnly++;
  }
  for (const m of src.matchAll(/requireAnyPermission\(\s*(\[[^\]]*\]|\w+)\s*,\s*"(\w+)"\s*\)/g)) {
    let keys = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    if (!keys.length) {
      const c = src.match(new RegExp(`const ${m[1]} = \\[([^\\]]*)\\]`));
      keys = c ? [...c[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
      if (!keys.length) { problems.push(`${file}  requireAnyPermission(${m[1]}) — could not read that list`); continue; }
    }
    for (const key of keys) {
      const entry = CATALOGUE_BY_KEY[key];
      if (!entry) problems.push(`${file}  requireAnyPermission — "${key}" is not in the catalogue`);
      else if (!entry.actions.includes(m[2])) problems.push(`${file}  requireAnyPermission — "${key}" has no ${m[2]}`);
    }
    permOnly++;
  }
  if (PERMISSION_ONLY_FILES.has(file)) {
    for (const m of src.matchAll(/router\.(get|post|patch|put|delete)\(\s*"([^"]+)"\s*,\s*requireRole\([^)]*\)\s*,\s*require(Any)?Permission/g)) {
      problems.push(`${file}  ${m[1].toUpperCase()} ${m[2]}  →  has a role guard in front of its permission; Round 192 made the permission the only gate here`);
    }
  }
}
console.log(`Checked ${permOnly} permission guard(s) against the catalogue.`);

console.log(`Checked ${checked} route(s) carrying both guards.`);
if (!problems.length) {
  console.log("Every role a route allows is granted the matching action by default.");
  process.exit(0);
}
console.log(`\n${problems.length} mismatch(es):\n`);
for (const p of problems) console.log("  " + p);
console.log(
  "\nFix the key/action against permissionCatalogue.js, or add the missing default there — and remember that a\n" +
  "role which has already been seeded will not pick up the change from the seeding loop,\n" +
  "so an already-live installation also needs a named repair in setup.js (see REPAIR_148;\n" +
  "a function NEW to the catalogue is seeded automatically — Round 192)."
);
process.exit(1);
