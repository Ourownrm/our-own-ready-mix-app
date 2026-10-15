// Round 210 — customer and site / project names are kept in CAPITALS
// (owner: "should be converted into capital letters even if typed in small
// letters"). Every place that writes customers.name or sites.name goes
// through this, so the master never mixes "Skyline builders" and
// "SKYLINE BUILDERS".
export function upperName(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}
