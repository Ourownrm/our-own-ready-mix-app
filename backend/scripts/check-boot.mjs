// Round 181 — load-time boot check. Importing a route/lib module runs its
// top-level code: route registration, constant initialisation, etc. A bug like
// using `requireRole(...SOME_CONST)` ABOVE the `const SOME_CONST = [...]` that
// defines it throws at startup ("Cannot access 'X' before initialization") —
// a TEMPORAL DEAD ZONE error that `node --check` (syntax only) and the text-based
// guard checks never see, because the module is never actually executed there.
//
// That is exactly what broke the Round 179 deploy (RECIPE_EDIT_ROLES used before
// its declaration in plant.js). This check imports every module under
// src/routes and src/lib so any such load-time error is caught here, before a
// push, instead of on Render.
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const targets = [
  ...jsFilesUnder(path.join(SRC, "routes")),
  ...jsFilesUnder(path.join(SRC, "lib")),
];

let failed = 0;
let checked = 0;
for (const file of targets) {
  checked++;
  try {
    await import(pathToFileURL(file).href);
  } catch (err) {
    failed++;
    console.error(`  LOAD ERROR  ${path.relative(SRC, file)}  ->  ${err.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} module(s) failed to load (see above). A module that throws at import time crashes the server on boot.`);
  process.exit(1);
}
console.log(`Checked ${checked} module(s). Every route/lib module loads without a startup error.`);
