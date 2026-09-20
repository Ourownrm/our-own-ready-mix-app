// Round 149 — the plugin registry.
//
// A plugin is a whole optional module (the first is Solitaire, the delivery
// challan / batching docket). A Super Admin can switch one off at any time
// without a deploy, and off must mean OFF: the module's API refuses every
// request and its icon disappears. Hiding the icon alone would be theatre —
// anyone who had bookmarked the page, or whose browser still held the module's
// own session cookie, would carry on using it.
//
// This is deliberately NOT part of the permission catalogue, which answers a
// different question. Permissions decide what a PERSON may do with a module
// that exists; a plugin decides whether the module exists for anyone at all.
// Conflating them would mean "switch off Solitaire" had to be expressed as
// revoking a permission from every role one at a time, and a role added later
// would quietly get it back.
//
// The 5-second cache mirrors lib/permissions.js: a toggle has to bite quickly
// enough that a Super Admin flipping it can see the effect, without every
// request in the module paying for a round trip.
import { query } from "../db.js";

const CACHE_MS = 5000;
let cache = null; // { at, map }

export async function pluginStates() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.map;
  const { rows } = await query(`SELECT key, is_enabled FROM app_plugins`);
  const map = Object.fromEntries(rows.map((r) => [r.key, r.is_enabled]));
  cache = { at: Date.now(), map };
  return map;
}

export function clearPluginCache() {
  cache = null;
}

// Unknown key → false. A plugin that has no row is not "enabled by default":
// if the migration hasn't run, the module it guards is not ready either, and
// failing closed is the only safe direction for a switch whose whole job is
// to take something away.
export async function isPluginEnabled(key) {
  const map = await pluginStates();
  return map[key] === true;
}

// Router-level guard. Mount it FIRST, above the module's own auth, so a
// disabled module answers identically whether or not the caller is signed in —
// there is nothing to probe.
//
// 404 rather than 403: 403 says "this exists and you may not have it", which
// invites someone to go asking for access to a module the business has
// switched off. 404 says the honest thing — right now, there is no such
// module here.
export function requirePluginEnabled(key) {
  return async (req, res, next) => {
    if (await isPluginEnabled(key)) return next();
    res.status(404).json({ error: "This module is not enabled." });
  };
}
