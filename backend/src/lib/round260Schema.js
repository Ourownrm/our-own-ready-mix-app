// Round 260 (v10.92) — owner, 2 Nov 2026: "the super admin access control is
// to be reviewed again … plant in charge … create order … shows you don't
// have access".
//
// The cause: the Access Control page decides who SEES a screen and its
// buttons, but 117 of the routes those screens call still checked a fixed
// role list. Plant In Charge, given Production → Orders, saw "+ New order"
// and was refused on save by POST /orders (Manager / Administrator only).
// Those routes are now gated by the same functions as their screens
// (lib/permissions.js allow()).
//
// So that nobody loses anything on the day this ships, every role the old
// lists allowed is given the function its route now asks for — ONCE, and
// never where the Super Admin has already decided that role + function
// (permission_change_log), so a deliberate "off" stays off.
export const R260_GRANTS = {
  accountant: [
    "accounts.outstanding:view",
    "accounts.rates:create",
    "accounts.rates:delete",
    "accounts.rates:edit",
    "accounts.rates:view",
    "masters.billing-addresses:view",
    "orders.delay-charge:edit",
    "reports.director-dashboard:view",
    "store.items:view",
  ],
  manager: [
    "accounts.outstanding:view",
    "accounts.rates:create",
    "accounts.rates:delete",
    "accounts.rates:edit",
    "accounts.rates:view",
    "admin.home-screen-photos:create",
    "admin.home-screen-photos:delete",
    "admin.home-screen-photos:edit",
    "admin.home-screen-photos:view",
    "admin.notifications:edit",
    "admin.notifications:view",
    "admin.site-content:edit",
    "fleet.maintenance:create",
    "fleet.maintenance:edit",
    "fleet.maintenance:view",
    "masters.billing-addresses:create",
    "masters.billing-addresses:edit",
    "masters.billing-addresses:view",
    "masters.customers:create",
    "masters.customers:delete",
    "masters.customers:edit",
    "masters.site-merge:delete",
    "masters.sites:create",
    "masters.sites:delete",
    "masters.sites:edit",
    "masters.sites:view",
    "orders.confirm-completion:edit",
    "orders.delay-charge:edit",
    "orders.live-tracking:edit",
    "orders.live-tracking:view",
    "orders.site-mismatch:edit",
    "orders.site-mismatch:view",
    "production.correct-order:edit",
    "production.manager-dashboard:view",
    "quality.mix-design-standard:edit",
    "reports.charts:view",
    "reports.delay-justification:view",
    "reports.director-dashboard:view",
    "reports.geofence:view",
    "reports.trip-time-crosscheck:view",
    "reports.truck-timing:view",
    "sales.salespersons:create",
    "store.items:edit",
    "store.items:view",
    "store.purchase-approve:edit",
    "store.purchases:create",
    "store.purchases:delete",
    "store.purchases:edit",
    "store.purchases:view",
    "store.supply-approve:edit",
    "store.supply-requests:delete",
  ],
  plant_in_charge: [
    "store.items:create",
    "store.items:edit",
    "store.items:view",
    "store.purchase-approve:edit",
    "store.purchases:create",
    "store.purchases:delete",
    "store.purchases:edit",
    "store.purchases:view",
    "store.supply-approve:edit",
    "store.supply-report:view",
    "store.supply-requests:create",
    "store.supply-requests:delete",
    "store.supply-requests:view",
  ],
  plant_operator: [
    "reports.delay-justification:view",
  ],
  sales_executive: [
    "masters.billing-addresses:view",
    "masters.customer-quick-create:create",
    "masters.site-quick-create:create",
    "orders.customer-orders:view",
  ],
  site_supervisor: [
    "reports.delay-justification:view",
  ],
  store: [
    "store.items:view",
    "store.purchases:create",
    "store.purchases:edit",
    "store.purchases:view",
    "store.supply-issue:edit",
  ],
};

export async function migrateRound260(pool, log) {
  const { rows: done } = await pool.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r260_route_grants'`).catch(() => ({ rows: [] }));
  if (done.length) return;
  const roles = [], keys = [], actions = [];
  for (const [role, list] of Object.entries(R260_GRANTS)) {
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
  await pool.query(`INSERT INTO app_migration_marks (mark) VALUES ('r260_route_grants') ON CONFLICT DO NOTHING`);
  log?.push?.(`Round 260: screens and their routes now ask the same Access Control question; ${rowCount} role default(s) added so no role loses what its old route list allowed.`);
}

let ready = null;
export function ensureRound260(pool) {
  if (!ready) ready = migrateRound260(pool).catch((e) => { ready = null; throw e; });
  return ready;
}
