// Round 148 — one place to ask "does this person have Administrator-level
// access?", mirroring `isAdminLevel` in the backend's middleware/auth.js.
//
// Round 146 added `super_admin` as a twelfth role, and every screen in the app
// asks for the Administrator by the literal string "administrator" — in route
// guards (`roles={["administrator"]}`) and in dozens of inline
// `user.role === "administrator"` checks that decide whether a column, a button
// or a whole panel is shown. The first real promotion therefore took the entire
// Administrator side of the app AWAY from the account that was supposed to have
// the most access, which is the opposite of what the role means.
//
// `super_admin` is the top role: an Administrator plus the access-control
// screen. So every one of those questions must answer yes for it. Asking
// through this helper rather than by string compare is what stops the next
// screen re-introducing the same bug.
export function isAdminLevel(role) {
  return role === "administrator" || role === "super_admin";
}

// For route guards: `roles={ADMIN_LEVEL}` reads better than repeating the pair,
// and ProtectedRoute lets super_admin through any guard anyway — this is for
// the places that build a role list by hand.
export const ADMIN_LEVEL = ["administrator", "super_admin"];
