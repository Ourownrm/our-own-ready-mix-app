// Round 262 (v10.94) — owner, 2 Nov 2026: "please check other user roles for
// similar access control issues and update the code, super admin should be
// able to control each and every user access".
//
// Every screen and route that still opened by role name — Driver, Site
// Supervisor, Plant Operator, QC Engineer, Accountant home, Store, Sales,
// Administrator dashboard, users / trucks / pumps, compliance, customer
// access, technical writings, booking links, fuel log — is now gated by a
// function on the Access Control page. Only the Super Admin's own controls
// keep a role guard.
//
// So that nobody loses anything the day this ships, every role the old lists
// allowed is given the function its route now asks for — ONCE, and never
// where the Super Admin has already decided that role + function
// (permission_change_log), so a deliberate "off" stays off.

export const R262_GRANTS = {
  accountant: [
    "accounts.accountant-home:create",
    "accounts.accountant-home:delete",
    "accounts.accountant-home:edit",
    "accounts.accountant-home:view",
    "fleet.fuel-filling:create",
    "fleet.fuel-filling:view",
    "sales.followups:edit",
    "sales.followups:view",
  ],
  driver: [
    "fleet.driver-screen:create",
    "fleet.driver-screen:edit",
    "fleet.driver-screen:view",
    "fleet.fuel-filling:create",
    "fleet.fuel-filling:view",
  ],
  loader_operator: [
    "production.loader-operator:create",
    "production.loader-operator:view",
  ],
  manager: [
    "fleet.fuel-filling:create",
    "fleet.fuel-filling:view",
    "mnt.pm-assign:edit",
    "production.correct-tickets:edit",
    "production.manager-dashboard:view",
    "quality.technical-writings:create",
    "quality.technical-writings:delete",
    "quality.technical-writings:edit",
    "quality.technical-writings:view",
    "reports.compliance:create",
    "reports.compliance:edit",
    "reports.compliance:view",
    "sales.booking-links:create",
    "sales.booking-links:delete",
    "sales.bookings:edit",
    "sales.bookings:view",
    "sales.contacts:create",
    "sales.contacts:edit",
    "sales.contacts:view",
    "sales.dashboard:view",
    "sales.feedback:view",
    "sales.followups:edit",
    "sales.followups:view",
    "sales.forecast:view",
    "sales.lead-assign:edit",
    "sales.leads:edit",
    "sales.leads:view",
    "sales.portal-access:create",
    "sales.portal-access:delete",
    "sales.portal-access:edit",
    "sales.portal-access:view",
    "sales.team-review:edit",
    "sales.team-review:view",
    "sales.visits:view",
  ],
  plant_in_charge: [
    "mnt.pm-assign:edit",
  ],
  plant_operator: [
    "orders.tickets:create",
    "production.plant-operator:create",
    "production.plant-operator:edit",
    "production.plant-operator:view",
  ],
  qc_engineer: [
    "fleet.breakdowns:create",
    "fleet.breakdowns:view",
    "quality.plant-qc:create",
    "quality.plant-qc:edit",
    "quality.plant-qc:view",
  ],
  sales_executive: [
    "sales.bookings:view",
    "sales.contacts:create",
    "sales.contacts:edit",
    "sales.contacts:view",
    "sales.dashboard:view",
    "sales.feedback:view",
    "sales.field-app:create",
    "sales.field-app:delete",
    "sales.field-app:edit",
    "sales.field-app:view",
    "sales.followups:edit",
    "sales.followups:view",
    "sales.forecast:view",
    "sales.leads:edit",
    "sales.leads:view",
    "sales.visits:view",
  ],
  site_supervisor: [
    "fleet.fuel-filling:create",
    "fleet.fuel-filling:view",
    "orders.site-supervisor:create",
    "orders.site-supervisor:edit",
    "orders.site-supervisor:view",
  ],
};

export async function migrateRound262(pool, log) {
  const { rows: done } = await pool.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r262_route_grants'`).catch(() => ({ rows: [] }));
  if (done.length) return;
  const roles = [], keys = [], actions = [];
  for (const [role, list] of Object.entries(R262_GRANTS)) {
    for (const ka of list) {
      const i = ka.lastIndexOf(":");
      roles.push(role); keys.push(ka.slice(0, i)); actions.push(ka.slice(i + 1));
    }
  }
  const { rowCount } = await pool.query(
    `INSERT INTO role_default_permissions (role, permission_key, action)
     SELECT g.role::user_role, g.k, g.a
       FROM UNNEST($1::text[], $2::text[], $3::text[]) AS g(role, k, a)
      WHERE g.role IN (SELECT unnest(enum_range(NULL::user_role))::text)
        -- a role with no rows yet is seeded whole from the catalogue by
        -- /setup (which already includes these); adding rows first would
        -- stop that seeding.
        AND EXISTS (SELECT 1 FROM role_default_permissions d WHERE d.role::text = g.role)
        AND NOT EXISTS (SELECT 1 FROM permission_change_log l
                         WHERE l.target_role::text = g.role AND l.permission_key = g.k AND l.action = g.a)
     ON CONFLICT DO NOTHING`,
    [roles, keys, actions]
  );
  await pool.query(`INSERT INTO app_migration_marks (mark) VALUES ('r262_route_grants') ON CONFLICT DO NOTHING`);
  log?.push?.(`Round 262: every role screen and its routes are now on the Access Control page; ${rowCount} role default(s) added so no role loses what its old route list allowed.`);
}

let ready = null;
export function ensureRound262(pool) {
  if (!ready) ready = migrateRound262(pool).catch((e) => { ready = null; throw e; });
  return ready;
}
