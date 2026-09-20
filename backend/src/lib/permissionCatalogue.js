// Round 146 — the permission catalogue: the ONE list of every function the app
// can grant or withhold, from the approved design in
// claude/super-admin-functions-list.md.
//
// Shape of an entry:
//   key       stable identifier, never reused or renamed once shipped (the
//             database stores these strings, and a rename would silently
//             revoke whatever was granted under the old one)
//   group     one of GROUPS below — how the Super Admin page arranges them
//   label     what a person reading the page sees
//   actions   which of view / create / edit / delete exist for this function.
//             A report has only view; an approval step has only edit.
//   roles     the role default set: role -> the actions that role gets today.
//             Transcribed from each route's own requireRole(...) so that
//             turning the system on changes nobody's access on day one.
//   screen    the matching key in frontend/src/lib/adminScreens.js, where one
//             exists — this is what lets a dashboard tile disappear when its
//             View is revoked, with no second list to keep in step.
//   locked    true = never delegable to anyone; Super Admin only, and the
//             page refuses to tick it (enforced here AND in the API, not
//             just hidden in the UI).
//
// VIEW IS THE GATE: create, edit and delete mean nothing without view, and
// both the API and the page enforce that pairing.

export const ACTIONS = ["view", "create", "edit", "delete"];

export const GROUPS = [
  { key: "orders", label: "Orders & delivery" },
  { key: "production", label: "Production & plant" },
  { key: "quality", label: "Quality & lab" },
  { key: "material", label: "Material Module" },
  { key: "store", label: "Store & supplies" },
  { key: "fleet", label: "Fleet, fuel & maintenance" },
  { key: "sales", label: "Sales & CRM" },
  { key: "accounts", label: "Accounts" },
  { key: "masters", label: "Masters" },
  { key: "reports", label: "Reports" },
  { key: "admin", label: "Administration" },
];

// Shorthands for the role-default column. `A` is administrator, which by the
// user's own decision keeps everything (see ADMIN_HAS_EVERYTHING below) — it
// is listed anyway so the defaults grid can show it, locked.
const V = ["view"];
const VC = ["view", "create"];
const VCE = ["view", "create", "edit"];
const VCED = ["view", "create", "edit", "delete"];
const E = ["edit"];

function f(key, group, label, actions, roles, extra = {}) {
  return { key, group, label, actions, roles, ...extra };
}

export const CATALOGUE = [
  // ---------- Orders & delivery ----------
  f("orders.customer-orders", "orders", "Customer orders", VCED,
    { administrator: VCED, manager: VCED, sales_executive: V }, { screen: "correct-order" }),
  f("orders.reschedule", "orders", "Reschedule an order", E,
    { administrator: E, manager: E }),
  f("orders.tickets", "orders", "Delivery tickets / challans", VCED,
    { administrator: VCED, manager: ["view", "edit", "delete"], plant_operator: VC, qc_engineer: V, accountant: V, driver: V, site_supervisor: V }, { screen: "correct-tickets" }),
  f("orders.challan-print", "orders", "Print / download challan", V,
    { administrator: V }),
  f("orders.live-tracking", "orders", "Live truck tracking", ["view", "edit"],
    { administrator: ["view", "edit"], manager: ["view", "edit"] }),
  f("orders.delay-reasons", "orders", "Delay reasons", VC,
    { administrator: VC, manager: VC, site_supervisor: VC, plant_operator: VC }),
  f("orders.delay-charge", "orders", "Apply a delay charge", E,
    { administrator: E, manager: E, accountant: E }),
  f("orders.confirm-completion", "orders", "Confirm order completion", E,
    { administrator: E, manager: E }),
  f("orders.site-mismatch", "orders", "Site–customer mismatch fixes", ["view", "edit"],
    { administrator: ["view", "edit"], manager: ["view", "edit"] }),

  // ---------- Production & plant ----------
  f("production.plant-operator", "production", "Plant Operator screen", VCE,
    { administrator: VCE, plant_operator: VCE }),
  f("production.manager-dashboard", "production", "Plant Manager dashboard", V,
    { administrator: V, manager: V }, { screen: "plant-manager" }),
  f("production.targets", "production", "Production Target", VCE,
    { administrator: VCE, manager: V }, { screen: "production-target" }),
  f("production.daily-entry", "production", "Daily production entry (m³)", VCE,
    { administrator: VCE, plant_operator: VCE }),
  f("production.loader-operator", "production", "Loader Operator screen", VC,
    { administrator: VC, loader_operator: VC }),

  // ---------- Quality & lab ----------
  f("quality.lab-technician", "quality", "Laboratory (Lab Technician screen)", VCE,
    { administrator: VCE, lab_technician: VCE }, { screen: "laboratory" }),
  f("quality.site-qc", "quality", "Site QC / reject concrete", VCE,
    { administrator: VCE, qc_engineer: VCE }),
  f("quality.cube-tests", "quality", "Cube casting & testing", VCED,
    { administrator: VCED, lab_technician: VCED }),
  f("quality.cube-test-report", "quality", "Cube Test Report", V,
    { administrator: V, lab_technician: V }, { screen: "cube-test-report" }),
  f("quality.lab-due-today", "quality", "Lab due today", V,
    { administrator: V, lab_technician: V }),
  f("quality.cube-qc-dashboard", "quality", "Cube Strength Analysis", V,
    { administrator: V }, { screen: "cube-strength-analysis" }),
  f("quality.mix-designs", "quality", "Mix designs", VCED,
    { administrator: VCED, lab_technician: VCED }, { screen: "mix-designs-approve" }),
  f("quality.mix-design-approve", "quality", "Approve a mix design", E,
    { administrator: E }),
  f("quality.mix-design-standard", "quality", "Set a design as standard for its grade", E,
    { administrator: E, manager: E }),
  f("quality.mix-assignments", "quality", "Approved Mix Designs (assignments)", ["view", "create", "delete"],
    { administrator: ["view", "create", "delete"], manager: ["view", "create", "delete"] }, { screen: "mix-assignments" }),
  f("quality.raw-material-stock", "quality", "Raw material stock (lab 9-bin)", VCE,
    { administrator: V, lab_technician: VCE }),

  // ---------- Material Module ----------
  f("material.materials", "material", "Materials master", VCED,
    { administrator: VCED }),
  f("material.units", "material", "Purchase units per material", VCED,
    { administrator: VCED }),
  f("material.suppliers", "material", "Suppliers master", VCED,
    { administrator: VCED }),
  f("material.supplier-rates", "material", "Supplier rates", VCE,
    { administrator: VCE }),
  f("material.transporters", "material", "Transporters & freight rates", VCE,
    { administrator: VCE }),
  f("material.orders", "material", "Material orders", VCED,
    { administrator: VCED, store: VC }),
  f("material.order-approve", "material", "Approve / reject a material order", E,
    { administrator: E }),
  f("material.receipts", "material", "Material receipts", VCED,
    { administrator: VCED, store: VC }),
  f("material.consumption", "material", "Daily consumption entry", VCE,
    { administrator: VCE, plant_operator: VCE }),
  f("material.stock", "material", "Stock — quantities", V,
    { administrator: V, store: V, plant_operator: V }),
  f("material.stock-valuation", "material", "Stock — rates and value", V,
    { administrator: V }),
  f("material.physical-stock", "material", "Monthly physical stock count", VCE,
    { administrator: VCE, store: VCE }),
  f("material.reports", "material", "Material reports", V,
    { administrator: V }),
  f("material.cost-dashboard", "material", "Material cost dashboard", V,
    { administrator: V }),
  f("material.module", "material", "Raw Material Module (open it)", V,
    { administrator: V, store: V, plant_operator: V }, { screen: "material-module" }),

  // ---------- Store & supplies ----------
  f("store.items", "store", "Store stock items", VCE,
    { administrator: VCE, manager: VCE, store: VC, accountant: V }),
  f("store.purchases", "store", "Store purchases", VCED,
    { administrator: VCED, manager: VCED, store: VCE }),
  f("store.purchase-approve", "store", "Approve / reject a store purchase", E,
    { administrator: E, manager: E }),
  f("store.supply-requests", "store", "Supply requests (fuel, lubricant)", ["view", "create", "delete"],
    { administrator: ["view", "create", "delete"], manager: ["view", "create", "delete"], driver: VC, site_supervisor: VC, plant_operator: VC, loader_operator: VC }),
  f("store.supply-approve", "store", "Approve / reject a supply request", E,
    { administrator: E, manager: E }),
  f("store.supply-issue", "store", "Issue against a supply request", E,
    { administrator: E, store: E }),
  f("store.supply-report", "store", "Supply request report & export", V,
    { administrator: V, manager: V, accountant: V, store: V }),

  // ---------- Fleet, fuel & maintenance ----------
  f("fleet.trucks-pumps", "fleet", "Trucks & Pumps", VCED,
    { administrator: VCED }, { screen: "trucks-pumps" }),
  f("fleet.equipment", "fleet", "Equipment master", VCED,
    { administrator: VCED }),
  f("fleet.driver-screen", "fleet", "Driver screen", VCE,
    { administrator: V, driver: VCE }),
  f("fleet.breakdowns", "fleet", "Equipment Breakdowns", VCE,
    { administrator: VCE, manager: VCE, driver: VC, site_supervisor: VC, plant_operator: VC }, { screen: "equipment-breakdowns" }),
  f("fleet.maintenance", "fleet", "Maintenance & Best Driver", VCE,
    { administrator: VCE, manager: VCE }, { screen: "maintenance" }),
  f("fleet.action-points", "fleet", "Maintenance Action Points", VCED,
    { administrator: VCED, manager: VCED }, { screen: "maintenance-action-points" }),
  f("fleet.external-repairs", "fleet", "External repairs", VCE,
    { administrator: VCE, manager: VCE }),
  f("fleet.inspections", "fleet", "Truck inspections", VCE,
    { administrator: VCE, manager: VCE, driver: VC }),
  f("fleet.fuel-filling", "fleet", "Fuel filling entry", VC,
    { administrator: VC, manager: VC, driver: VC, site_supervisor: VC, plant_operator: VC, loader_operator: VC }),
  f("fleet.fuel-stations", "fleet", "Fuel Stations & Equipment", VCED,
    { administrator: VCED }, { screen: "fuel-stations" }),
  f("fleet.lubricant-types", "fleet", "Lubricant types", VCE,
    { administrator: VCE }),

  // ---------- Sales & CRM ----------
  f("sales.leads", "sales", "Browse Leads", VCE,
    { administrator: VCE, manager: VCE, sales_executive: VCE }, { screen: "browse-leads" }),
  f("sales.lead-assign", "sales", "Assign a Lead", E,
    { administrator: E, manager: E }, { screen: "assign-lead" }),
  f("sales.lead-won", "sales", "Mark a lead won", E,
    { administrator: E }),
  f("sales.bookings", "sales", "Sales bookings", VCE,
    { administrator: VCE, manager: VCE, sales_executive: VC }),
  f("sales.feedback", "sales", "Customer Feedback", VC,
    { administrator: VC, manager: VC, sales_executive: VC }, { screen: "customer-feedback" }),
  f("sales.visits", "sales", "Sales visits & outcomes", VCE,
    { administrator: VCE, manager: VCE, sales_executive: VCE }),
  f("sales.forecast", "sales", "Sales Forecast", VCED,
    { administrator: VCE, manager: VCE, sales_executive: VCED }, { screen: "sales-forecast" }),
  f("sales.performance", "sales", "Sales Performance", V,
    { administrator: V }, { screen: "sales-performance" }),
  f("sales.dashboard", "sales", "Sales Executive Dashboard", V,
    { administrator: V, manager: V, sales_executive: V }, { screen: "sales-dashboard" }),
  f("sales.salespersons", "sales", "Salespersons", VCE,
    { administrator: VCE, manager: VC }, { screen: "salespersons" }),
  f("sales.booking-links", "sales", "Booking Links & Requests", ["view", "create", "delete"],
    { administrator: ["view", "create", "delete"], manager: ["view", "create", "delete"] }, { screen: "booking-links" }),
  f("sales.portal-access", "sales", "Customer portal access codes", VCED,
    { administrator: VCED }),

  // ---------- Accounts ----------
  f("accounts.invoices", "accounts", "Invoices", VCED,
    { administrator: VCED, accountant: VCED }),
  f("accounts.payments", "accounts", "Payments / receipts", VCE,
    { administrator: VCE, accountant: VCE }),
  f("accounts.rates", "accounts", "Concrete Grade & Rates", VCED,
    { administrator: VCED, manager: VCED, accountant: VCED }, { screen: "rates" }),
  f("accounts.trip-allowance", "accounts", "Trip allowance", ["view", "edit"],
    { administrator: ["view", "edit"], manager: ["view", "edit"], accountant: ["view", "edit"] }),
  f("accounts.outstanding", "accounts", "Outstanding Collection Report", V,
    { administrator: V, manager: V, accountant: V }, { screen: "outstanding-collection" }),

  // ---------- Masters ----------
  f("masters.customers", "masters", "Customer", VCED,
    { administrator: VCED, manager: VCED }, { screen: "customers" }),
  // A Sales Executive can raise a customer from the field (POST
  // /sales/quick-customer) without being able to browse the customer master —
  // two different endpoints today, so two different functions here. Folding
  // them into one would have forced a choice between granting them the whole
  // master or taking away something they already do.
  f("masters.customer-quick-create", "masters", "Add a customer from the field", ["create"],
    { administrator: ["create"], sales_executive: ["create"] }),
  f("masters.billing-addresses", "masters", "Billing addresses", VCE,
    { administrator: VCE, manager: VCE, accountant: V, sales_executive: V }),
  f("masters.sites", "masters", "Projects & Sites", VCED,
    { administrator: VCED, manager: VCED }, { screen: "sites" }),
  f("masters.site-quick-create", "masters", "Add a site from the field", ["create"],
    { administrator: ["create"], sales_executive: ["create"] }),
  f("masters.site-merge", "masters", "Merge duplicate sites", ["delete"],
    { administrator: ["delete"], manager: ["delete"] }),
  f("masters.site-contacts", "masters", "Site Contacts", VCE,
    { administrator: VCE }, { screen: "site-contacts" }),
  f("masters.mix-grades", "masters", "Mix grades", VCE,
    { administrator: VCE }),
  f("masters.rejection-reasons", "masters", "Rejection reasons", VCE,
    { administrator: VCE }),
  f("masters.trip-allowance-categories", "masters", "Trip allowance categories", VCE,
    { administrator: VCE }),
  f("masters.plant-locations", "masters", "Plant Location (Geofence)", VCED,
    { administrator: VCED }, { screen: "plant-locations" }),
  f("masters.visit-outcome-reasons", "masters", "Visit outcome reasons", VCE,
    { administrator: VCE }),
  f("masters.breakdown-issue-types", "masters", "Breakdown issue types", VCE,
    { administrator: VCE }),

  // ---------- Reports ----------
  f("reports.director-dashboard", "reports", "Directors Dashboard", V,
    { administrator: V, manager: V, accountant: V }, { screen: "directors-dashboard" }),
  f("reports.production", "reports", "Daily Production Report", V,
    { administrator: V, manager: V }, { screen: "daily-production-report" }),
  f("reports.fuel", "reports", "Fuel and Lubricant Report", V,
    { administrator: V, manager: V, accountant: V, store: V }, { screen: "fuel-report" }),
  f("reports.fuel-analysis", "reports", "360° Fuel Analysis", V,
    { administrator: V, manager: V }, { screen: "fuel-analysis" }),
  f("reports.trip-allowance", "reports", "Trip Allowance Report", V,
    { administrator: V, manager: V, accountant: V }, { screen: "trip-allowance-report" }),
  f("reports.delay-justification", "reports", "Delay Justification Report", V,
    { administrator: V, manager: V, site_supervisor: V, plant_operator: V }, { screen: "delay-justification" }),
  f("reports.charts", "reports", "Charts", V,
    { administrator: V, manager: V }, { screen: "charts" }),
  f("reports.cycle-time", "reports", "Cycle Time Report", V,
    { administrator: V, manager: V }, { screen: "cycle-time-report" }),
  f("reports.truck-timing", "reports", "Truck timing report", V,
    { administrator: V, manager: V }),
  f("reports.trip-time-crosscheck", "reports", "Time Cross Check", V,
    { administrator: V, manager: V }, { screen: "time-cross-check" }),
  f("reports.geofence", "reports", "Geofence report", V,
    { administrator: V, manager: V }),
  f("reports.site-efficiency", "reports", "Site efficiency / best driver", V,
    { administrator: V, manager: V }),
  f("reports.compliance", "reports", "Statutory Compliance", VCE,
    { administrator: VCE, manager: VCE }, { screen: "statutory-compliance" }),

  // ---------- Administration ----------
  f("admin.users", "admin", "Users — list and create", VCE,
    { administrator: VCE }, { screen: "users-roles" }),
  f("admin.password-reset", "admin", "Reset a user's password", E,
    {}, { locked: true }),
  f("admin.access-control", "admin", "Access control (the Super Admin page)", ["view", "edit"],
    {}, { locked: true }),
  f("admin.home-screen-photos", "admin", "Home Screen Photos", VCED,
    { administrator: VCED, manager: VCED }, { screen: "home-screen-photos" }),
  f("admin.site-content", "admin", "Website Content", VCED,
    { administrator: VCED, manager: VCED }, { screen: "website-content" }),
  f("admin.notifications", "admin", "Notifications setup", VCE,
    { administrator: VCE, manager: VCE }),
  f("admin.setup", "admin", "Database setup & transactional reset", ["view", "edit", "delete"],
    {}, { locked: true }),
];

// Every role the app has, plus the new one. Administrator and super_admin are
// deliberately at the front — they are the two the defaults grid locks.
export const ROLES = [
  "super_admin", "administrator", "manager", "plant_operator", "qc_engineer",
  "lab_technician", "driver", "site_supervisor", "accountant", "sales_executive",
  "store", "loader_operator",
];

// The user's decision, 19 Sep: Administrator keeps everything except the
// locked functions, permanently. Enforced here rather than seeded as rows, so
// nobody can trim it by editing the defaults table directly.
export const ADMIN_HAS_EVERYTHING = true;

export const CATALOGUE_BY_KEY = Object.fromEntries(CATALOGUE.map((c) => [c.key, c]));

// screen key (adminScreens.js) -> permission key, for hiding a dashboard tile.
export const PERMISSION_BY_SCREEN = Object.fromEntries(
  CATALOGUE.filter((c) => c.screen).map((c) => [c.screen, c.key])
);

export function isLocked(key) {
  const c = CATALOGUE_BY_KEY[key];
  return !c || !!c.locked;
}

export function hasAction(key, action) {
  const c = CATALOGUE_BY_KEY[key];
  return !!c && c.actions.includes(action);
}
