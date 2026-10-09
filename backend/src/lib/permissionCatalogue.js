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
  // Round 192 — the whole-module switches. Untick one for a role and every
  // function inside that module is gone for that role, whatever else is ticked
  // (see MODULES at the bottom of this file and lib/permissions.js).
  { key: "modules", label: "Module access (whole module on / off)" },
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
  { key: "hr", label: "HR" },
  { key: "admin", label: "Administration" },
];

// Shorthands for the role-default column. `A` is administrator, which by the
// user's own decision keeps everything (see ADMIN_HAS_EVERYTHING below) — it
// is listed anyway so the defaults grid can show it, locked.
const V = ["view"];
const VC = ["view", "create"];
const VE = ["view", "edit"];
const VCE = ["view", "create", "edit"];
const VCED = ["view", "create", "edit", "delete"];
const E = ["edit"];

function f(key, group, label, actions, roles, extra = {}) {
  return { key, group, label, actions, roles, ...extra };
}

// Round 192 — the role lists the module routes used to carry in requireRole,
// kept here so the new sub-menu keys default to exactly who could open that
// screen before. Turning the role guard off changes nobody's access on day one.
const PLANT_ROLES = { administrator: V, manager: V, store: V, plant_operator: V, qc_engineer: V, lab_technician: V };
const WB_ROLES = { administrator: V, manager: V, store: V, plant_operator: V, lab_technician: V };

export const CATALOGUE = [
  // ---------- Module access (Round 192) ----------
  // One switch per module. "material.module" predates this round and keeps its
  // key (renaming would drop every grant stored under it); it is simply the
  // Raw Material module's switch now.
  f("material.module", "modules", "Raw Material module", V,
    { administrator: V, store: V, plant_operator: V }, { screen: "material-module" }),
  f("module.plant-production", "modules", "Plant Production module", V,
    { ...PLANT_ROLES }, { screen: "plant-production" }),
  f("module.weighbridge", "modules", "Weighbridge module", V,
    { ...WB_ROLES }, { screen: "weighbridge-receipts" }),
  f("module.quality-control", "modules", "Quality Control module", V,
    // Manager and QC Engineer already reach parts of it (Approved Mix Designs,
    // Mix Designs & Recipes, recipe edits); the matrix below adds the rest.
    { administrator: V, lab_technician: V, manager: V, qc_engineer: V }),

  // ---------- Orders & delivery ----------
  f("orders.customer-orders", "orders", "Customer orders", VCED,
    { administrator: VCED, manager: VCED, sales_executive: V }),
  f("orders.reschedule", "orders", "Reschedule an order", E,
    { administrator: E, manager: E }),
  f("orders.tickets", "orders", "Delivery tickets / challans", VCED,
    { administrator: VCED, manager: ["view", "edit", "delete"], plant_operator: VC, qc_engineer: V, accountant: V, driver: V, site_supervisor: V }),
  // Round 192 — the Administrator dashboard's Correct Order / Correct Tickets
  // screens, which only Administrator and Manager could open (their routes
  // said so). Separate from the keys above because Sales and the plant roles
  // hold view on orders/tickets for their OWN screens, and handing them the
  // correction screens by accident would widen access.
  f("production.correct-order", "orders", "Correct Order (admin correction screen)", VE,
    { administrator: VE, manager: VE }, { screen: "correct-order" }),
  f("production.correct-tickets", "orders", "Correct Tickets (admin correction screen)", VE,
    { administrator: VE, manager: VE }, { screen: "correct-tickets" }),
  // Round 153, item 1 — widened from Administrator-only. The Plant Operator
  // raises every one of these notes, and the lab and QC get asked about a
  // specific load hours later; all three had to go and find an Administrator
  // to see the paperwork. Manager is included because the Manager already
  // reached the same document through the Administrator ticket table.
  //
  // This is the key routes/deliveryNotes.js is gated on, and it is the switch
  // the Super Admin's Access Control page flips to take this away from any one
  // of these roles again. A database seeded before Round 153 does not pick up
  // a changed default, so setup.js carries REPAIR_153 — same shape as
  // REPAIR_148, and for the same reason.
  f("orders.challan-print", "orders", "Print / download challan", V,
    { administrator: V, manager: V, plant_operator: V, lab_technician: V, qc_engineer: V }),
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
  // Round 192 — the route has always let these four roles approve; the
  // default now says so, since the permission is the only guard from here on.
  f("quality.mix-design-approve", "quality", "Approve a mix design", E,
    { administrator: E, lab_technician: E, qc_engineer: E, manager: E }),
  // Round 192 — the Mix Designs & Recipes screen (/mix-designs). It read the
  // plant's data key before, which tied a Quality Control screen to Plant
  // Production; denying one module must not break the other.
  f("quality.mix-designs-view", "quality", "Mix Designs & Recipes", V,
    { administrator: V, manager: V, qc_engineer: V, lab_technician: V }, { screen: "mix-designs-view" }),
  f("quality.mix-design-standard", "quality", "Set a design as standard for its grade", E,
    { administrator: E, manager: E }),
  f("quality.mix-assignments", "quality", "Approved Mix Designs (assignments)", ["view", "create", "delete"],
    { administrator: ["view", "create", "delete"], manager: ["view", "create", "delete"] }, { screen: "mix-assignments" }),
  // Round 194 — raw material lab tests. Cards are issued from a GRN to the
  // Lab Technician; an ADMINISTRATOR approves (the user's decision, 8 Oct
  // 2026 — "instead of QC Engineer, make admin the approving authority"), and
  // the approving Administrator's own name prints as "Approved by". The
  // approve key is edit-only and defaults to Administrator alone; a Super
  // Admin can hand it to someone else from Access Control if that ever
  // changes.
  f("quality.rm-tests", "quality", "Raw Material Tests (test cards & entry)", VCE,
    { administrator: VCE, lab_technician: VCE }, { screen: "rm-tests" }),
  f("quality.rm-test-approve", "quality", "Approve a raw material test (signs the report)", E,
    { administrator: E }),
  f("quality.rm-test-register", "quality", "Raw Material Test Register (filed reports)", V,
    { administrator: V, lab_technician: V, manager: V }, { screen: "rm-test-register" }),
  f("quality.rm-test-plans", "quality", "Raw material test plans (setup)", VCED,
    { administrator: VCED }, { screen: "rm-test-plans" }),
  f("quality.raw-material-stock", "quality", "Raw material stock (lab 9-bin)", VCE,
    { administrator: V, lab_technician: VCE }),

  // ---------- Material Module ----------
  // Round 148 — the six `store` / `plant_operator` VIEW defaults below were
  // missing in Round 146 and are a correction, not a widening.
  //
  // Round 146's rule was that each default is transcribed from that route's
  // own requireRole. For these master-data reads that transcription was
  // wrong: the routes have always allowed Store (MATERIALS_READ_ROLES /
  // ORDER_ROLES) and Plant Operator, but the catalogue granted only
  // Administrator — so the moment requirePermission was added alongside
  // requireRole, Store lost the Materials, Suppliers, Rates and Transporters
  // lists it needs to raise an order at all, and Plant Operator lost the
  // Materials list behind consumption entry. Both got a bare 403.
  //
  // This is the two-guards-disagreeing bug this project keeps hitting, in a
  // new place. `scripts/check-guards.mjs` now cross-checks every route's
  // requireRole against its requirePermission default and fails on a
  // mismatch — run it when converting the next group of routes.
  //
  // Granting view here can never exceed the role guard, since both must pass.
  f("material.materials", "material", "Materials master", VCED,
    { administrator: VCED, store: V, plant_operator: V }),
  f("material.units", "material", "Purchase units per material", VCED,
    { administrator: VCED, store: V, plant_operator: V }),
  f("material.suppliers", "material", "Suppliers master", VCED,
    { administrator: VCED, store: V }),
  f("material.supplier-rates", "material", "Supplier rates", VCE,
    { administrator: VCE, store: V }),
  f("material.transporters", "material", "Transporters & freight rates", VCE,
    { administrator: VCE, store: V }),
  f("material.orders", "material", "Material orders", VCED,
    { administrator: VCED, store: VC }),
  f("material.order-approve", "material", "Approve / reject a material order", E,
    { administrator: E }),
  f("material.receipts", "material", "Material receipts", VCED,
    { administrator: VCED, store: VC }),
  // Round 158 — deciding which quantity stands when the weighbridge and the
  // supplier's invoice disagree. Deliberately NOT part of material.receipts:
  // Store records the load (they are the ones standing there), but the figure
  // that reaches stock and the ledger is a Manager's call. Separating the keys
  // is what lets Store keep creating receipts without also settling disputes.
  f("material.receipt-confirm", "material", "Confirm a disputed receipt quantity", VE,
    { administrator: VE, manager: VE }, { screen: "receipt-differences" }),
  f("material.consumption", "material", "Daily consumption entry", VCE,
    { administrator: VCE, plant_operator: VCE }),
  f("material.stock", "material", "Stock — quantities", V,
    { administrator: V, store: V, plant_operator: V }),
  f("material.stock-valuation", "material", "Stock — rates and value", V,
    { administrator: V }),
  f("material.physical-stock", "material", "Monthly physical stock count", VCE,
    { administrator: VCE, store: VCE, plant_operator: V }),
  // Round 192 — approving a month's count locks it in as the next month's
  // opening stock. It shared the count's "create" with Store until now, kept
  // Administrator-only by the route's role guard; that guard is gone, so the
  // approval needs a key of its own.
  f("material.physical-stock-approve", "material", "Approve a month's physical count", E,
    { administrator: E }),
  // Round 189 — moving plant consumption from the material the plant booked to
  // the one really used (several materials through one bin). Administrator only.
  f("material.consumption-transfer", "material", "Plant consumption transfer", VCED,
    { administrator: VCED }),
  f("material.reports", "material", "Material reports", V,
    { administrator: V }),
  f("material.cost-dashboard", "material", "Material cost dashboard", V,
    { administrator: V }),
  // Round 192 — sub-menus of the Raw Material module that had no key of their
  // own. The Materials and Suppliers TABS used to need create on the master
  // (so Store's read access for dropdowns never handed it the editor); a
  // separate view key per tab lets a Super Admin show the list read-only.
  f("material.materials-menu", "material", "Materials tab", V, { administrator: V }),
  // Round 193 — the supplier ledger. Money owed and paid, so it is NOT handed
  // out with "view the module" (noAutoView below): Administrator, Accountant and
  // the Plant Manager see it by default; a Super Admin can add anyone else.
  f("material.supplier-ledger", "material", "Supplier Ledger tab (balances, statements, PDF)", V,
    { administrator: V, accountant: V, manager: V }),
  // Recording a payment or an opening balance (create) and cancelling a payment
  // (delete). Cancelling is Administrator-only by default.
  f("material.supplier-payments", "material", "Record supplier payments & opening balances", ["create", "delete"],
    { administrator: ["create", "delete"], accountant: ["create"] }),
  f("material.suppliers-menu", "material", "Suppliers tab", V, { administrator: V }),
  f("material.kpi", "material", "KPI cards (stock value, open orders, purchases)", V, { administrator: V }),
  // The ten reports inside the Reports tab, each switchable. Defaults copy
  // material.reports (Administrator only); setup.js copies any existing grant
  // of material.reports onto all ten so nobody loses a report they had.
  f("material.report.open-orders", "material", "Report — Open orders", V, { administrator: V }),
  f("material.report.weighbridge-comparison", "material", "Report — Weighbridge comparison", V, { administrator: V }),
  f("material.report.daily-consumption", "material", "Report — Daily consumption", V, { administrator: V }),
  f("material.report.mix-vs-actual", "material", "Report — Mix vs actual", V, { administrator: V }),
  f("material.report.monthly-consumption", "material", "Report — Monthly consumption", V, { administrator: V }),
  f("material.report.monthly-physical-stock", "material", "Report — Monthly physical stock", V, { administrator: V }),
  f("material.report.rate-history", "material", "Report — Weighted average rate history", V, { administrator: V }),
  f("material.report.supplier-summary", "material", "Report — Supplier purchase summary", V, { administrator: V }),
  f("material.report.transporter-freight", "material", "Report — Transporter freight", V, { administrator: V }),
  f("material.report.cost-per-m3", "material", "Report — Cost per m³ (purchase)", V, { administrator: V }),
  // Round 154 — the weighbridge sync. Two separate keys on purpose.
  //
  // "material.weighbridge" is the day-to-day screen: see what the weighbridge
  // has weighed, and mark a ticket reviewed or ignored (that is the `edit`).
  // Store lives on this screen, the Plant Operator and Manager watch it, and
  // the lab gets it because they are the ones asked "what did that lorry
  // actually weigh?" hours after the fact.
  //
  // "material.weighbridge-mapping" is the consequential one: mapping a raw
  // weighbridge spelling to a real material, supplier or truck decides where
  // stock gets credited from then on, for every past and future ticket
  // carrying that spelling. So it defaults to Administrator alone — Store can
  // flag a ticket for review, but not decide what it means.
  f("material.weighbridge", "material", "Weighbridge receipts", VE,
    { administrator: VE, manager: VE, store: VE, plant_operator: V, lab_technician: V }),
  f("material.weighbridge-mapping", "material", "Weighbridge name mapping", VCE,
    { administrator: VCE }),
  // Round 192 — Weighbridge sub-menus that rode on the two keys above.
  f("weighbridge.records", "material", "Weighbridge — Records", V, { ...WB_ROLES }),
  f("weighbridge.vehicles", "material", "Weighbridge — Vehicles", VE, { administrator: VE }),
  // The variance REPORT on the Receipt Differences screen (it used to need the
  // whole material.reports key). Confirming a disputed load stays
  // material.receipt-confirm.
  f("weighbridge.receipt-variance", "material", "Receipt variance report", V, { administrator: V }),

  // Round 157 — the MCI370 batching plant feed. Two keys, split the same way
  // as the weighbridge's and for the same reason.
  //
  // "production.plant-data" is the day-to-day screen: what the plant made and
  // what it consumed. Wide, because everyone from the Plant Operator to the
  // lab has a reason to look at it.
  //
  // "production.plant-mapping" decides which of our materials a silo holds,
  // and therefore where a month of consumption is counted. Administrator only.
  f("production.plant-data", "production", "Plant production & consumption (MCI370)", V,
    { administrator: V, manager: V, store: V, plant_operator: V, qc_engineer: V, lab_technician: V }),
  // Round 159 — entering what the plant did not record. Separate from
  // plant-data because reading the plant's figures and adding to them are
  // different acts: one is information, the other changes what stock and cost
  // are computed from.
  // Round 192 — view added for the other plant roles: the Manual entry tab has
  // always been shown (read-only) to everyone who could open Plant Production,
  // and it is now a switchable sub-menu, so its view is this key.
  f("production.plant-manual", "production", "Plant manual consumption & production", VCE,
    { administrator: VCE, plant_operator: VCE, manager: V, store: V, qc_engineer: V, lab_technician: V }),
  // Round 192 — the Plant Production tabs, each its own switch.
  f("plant.production", "production", "Plant — Production tab", V, { ...PLANT_ROLES }),
  f("plant.consumption", "production", "Plant — Consumption tab", V, { ...PLANT_ROLES }),
  f("plant.kpi", "production", "Plant — KPI strip (made today, loads, agent)", V, { ...PLANT_ROLES }),
  // Round 187 kept this tab from the Plant Operator; that is now a default
  // instead of a hard-coded role check.
  f("plant.vs-billed", "production", "Plant — Plant vs billed tab", V,
    { administrator: V, manager: V, store: V, qc_engineer: V, lab_technician: V }),
  f("plant.cost", "production", "Plant — Cost/m³ material tab", V, { administrator: V }),
  f("production.plant-mapping", "production", "Plant silo mapping", VCE,
    { administrator: VCE }),
  // ROUND 174 — editing a plant Recipe (Recipe Master) and writing the change
  // back into MCI370. A QC function, so Administrator/Manager/QC Engineer by
  // default. The "edit" action gates the write endpoints; on top of it, a
  // plant-wide edit password (set by a Super Admin) must be entered for each
  // change — the permission says WHO may reach the editor, the password is the
  // deliberate second key the owner holds.
  f("production.recipe-edit", "production", "Edit plant recipes (writes to MCI370)", VE,
    { administrator: VE, manager: VE, qc_engineer: VE, lab_technician: VE }),

  // ROUND 160 — the QC allowance added to the ticket's finish time, per
  // customer or site.
  //
  // Administrator only, and deliberately not the Plant Operator's: this moves
  // the time printed on a document that goes to the customer, so it is a
  // settings decision rather than a shift-floor one. A Manager may look.
  f("production.mixtrack-qc-delay", "production", "MixTrack QC delay allowance", VCE,
    { administrator: VCE, manager: V }),

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
    // Round 165 — sales_executive gets view here. The Sales screen already
    // links to /customer-booking for them (the route allows the role), so this
    // makes the catalogue match reality and lets a Super Admin control it. The
    // create/delete of booking links stays with Administrator and Manager.
    { administrator: ["view", "create", "delete"], manager: ["view", "create", "delete"], sales_executive: ["view"] }, { screen: "booking-links" }),
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

  // ---------- HR (Round 197 — stage 1) ----------
  // The user's rule: HR appears in access control only once it is built. It is
  // now. Defaults: Administrator everything; the Plant Manager (manager role)
  // keeps the people, the roster and attendance; the Accountant sees attendance.
  // Pay is its own function and Administrator-only by default — nobody sees a
  // salary because they can see the staff list.
  f("module.hr", "modules", "HR module", V,
    { administrator: V, manager: V, accountant: V }, { screen: "hr" }),
  f("hr.attendance", "hr", "Attendance register", V,
    { administrator: V, manager: V, accountant: V }),
  f("hr.employees", "hr", "Employees — list, add, edit", VCE,
    { administrator: VCE, manager: VCE, accountant: V }),
  f("hr.salary", "hr", "Employees — pay, incentive & bank-relevant details", VE,
    { administrator: VE }),
  f("hr.roster", "hr", "Shift roster for operations staff", VE,
    { administrator: VE, manager: VE }),
  f("hr.settings", "hr", "HR settings — departments, shifts, holidays", VCED,
    { administrator: VCED, manager: V }),
  // Round 198 — stage 2. Approving (edit) a request: the Plant Manager; Admin
  // also approves the ones the rules send to Admin (enforced in routes/hr.js
  // by role, so it cannot be granted away by mistake). Payroll and advances
  // carry pay, so they start Administrator-only like hr.salary.
  f("hr.requests", "hr", "Attendance requests — raise for staff, approve", VCE,
    { administrator: VCE, manager: VCE, accountant: V }),
  f("hr.payroll", "hr", "Payroll — calculate, lock, record salary paid", VCED,
    { administrator: VCED }),
  f("hr.advances", "hr", "Salary advances", VCED,
    { administrator: VCED }),

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
  // Round 195 — the eSSL attendance machine: is it being read, and what it
  // recorded. Raw punches only; the HR module (not built yet) will add its own
  // functions when it arrives, per the user's rule that HR appears in access
  // control only once it exists.
  f("admin.attendance-machine", "admin", "Attendance machine — sync status & punches", V,
    { administrator: V }),
  f("admin.notifications", "admin", "Notifications setup", VCE,
    { administrator: VCE, manager: VCE }),
  f("admin.setup", "admin", "Database setup & transactional reset", ["view", "edit", "delete"],
    {}, { locked: true }),

  // Round 149 — turning a whole optional module on or off, and deciding who
  // gets into it. LOCKED, which here carries the user's explicit instruction
  // that an Administrator must have no access to the Delivery Challan module
  // at all: locked means the function can never be granted to anyone by any
  // route, and Administrator's computed set is "everything EXCEPT the locked
  // ones" (see lib/permissions.js), so this is the one class of function the
  // permanent-full-access decision does not reach.
  f("admin.plugins", "admin", "Plugins — enable/disable a module and grant access to it", ["view", "edit"],
    {}, { locked: true }),
];

// ===================================================================
// Round 192 — MODULES: the user's role × module table (8 Oct 2026).
//
//   gate     the module's own switch. If a person does not hold View on it,
//            EVERY function listed under that module (menus + support) is
//            stripped from their effective set in lib/permissions.js — the
//            user's rule: "if a module is denied to a role, the complete
//            module is inaccessible to that role".
//   menus    the sub-menus a Super Admin switches one by one, in screen order.
//            `children` are switchable parts of one sub-menu (the reports).
//   support  functions with no menu of their own that belong to the module
//            (master-data reads behind a dropdown, approve buttons, …). They
//            go when the module goes.
//   matrixRoles  roles the user's table ADDS to this module. The table is a
//            minimum — everyone who already had the module keeps it — and a
//            ticked module gives VIEW ONLY by default (the user's answer), so
//            these roles get View on the gate and on every menu/support key
//            below except `noAutoView`. Create/edit/delete stay as they were.
//
// Fuel, HR and Accounts are deliberately NOT here yet: the user's instruction
// is to add them only once those modules are built.
// ===================================================================
export const MODULES = [
  {
    key: "raw-material", label: "Raw Material", gate: "material.module", to: "/material-module",
    matrixRoles: ["manager", "lab_technician", "accountant", "qc_engineer"],
    menus: [
      { key: "material.stock", label: "Stock" },
      { key: "material.orders", label: "Order" },
      { key: "material.receipts", label: "Receipts" },
      { key: "material.consumption", label: "Consumption" },
      { key: "material.physical-stock", label: "Physical Stock" },
      { key: "material.cost-dashboard", label: "Cost Dashboard" },
      { key: "material.materials-menu", label: "Materials" },
      { key: "material.suppliers-menu", label: "Suppliers" },
      { key: "material.kpi", label: "KPI" },
      { key: "material.supplier-ledger", label: "Supplier Ledger" },
      {
        key: "material.reports", label: "Reports",
        children: [
          { key: "material.report.open-orders", label: "Open Orders" },
          { key: "material.report.weighbridge-comparison", label: "Weighbridge Comparison" },
          { key: "material.report.daily-consumption", label: "Daily Consumption" },
          { key: "material.report.mix-vs-actual", label: "Mix vs Actual" },
          { key: "material.report.monthly-consumption", label: "Monthly Consumption" },
          { key: "material.report.monthly-physical-stock", label: "Monthly Physical Stock" },
          { key: "material.report.rate-history", label: "Weighted Average Rate History" },
          { key: "material.report.supplier-summary", label: "Supplier Purchase Summary" },
          { key: "material.report.transporter-freight", label: "Transporter Freight" },
          { key: "material.report.cost-per-m3", label: "Cost per m³ – Purchase" },
        ],
      },
      { key: "material.consumption-transfer", label: "Consumption transfer" },
    ],
    support: ["material.materials", "material.units", "material.suppliers", "material.supplier-rates",
      "material.transporters", "material.order-approve", "material.physical-stock-approve",
      "material.supplier-payments"],
    // An Administrator's tool for moving consumption between materials — not
    // a screen to hand out with "view the module".
    noAutoView: ["material.consumption-transfer", "material.supplier-ledger"],
  },
  {
    key: "plant-production", label: "Plant Production", gate: "module.plant-production", to: "/plant-production",
    matrixRoles: ["accountant"],
    menus: [
      { key: "plant.production", label: "Production" },
      { key: "plant.consumption", label: "Consumption" },
      { key: "production.plant-mapping", label: "Silos" },
      { key: "production.plant-manual", label: "Manual Entry" },
      { key: "plant.cost", label: "Cost/m³ – Material" },
      { key: "production.mixtrack-qc-delay", label: "QC Delay" },
      { key: "plant.kpi", label: "KPI" },
      { key: "plant.vs-billed", label: "Plant vs billed" },
    ],
    support: ["production.plant-data"],
  },
  {
    key: "weighbridge", label: "Weighbridge", gate: "module.weighbridge", to: "/weighbridge",
    matrixRoles: ["accountant", "qc_engineer"],
    menus: [
      { key: "material.weighbridge", label: "Receipts" },
      { key: "weighbridge.records", label: "Records" },
      { key: "material.weighbridge-mapping", label: "Name Mapping" },
      { key: "weighbridge.vehicles", label: "Vehicles" },
      { key: "weighbridge.receipt-variance", label: "Receipt Variances" },
      { key: "material.receipt-confirm", label: "Receipt Differences (confirm disputed loads)" },
    ],
    support: [],
  },
  {
    // Round 197 — HR, stage 1. Plant Manager and Accountant get the module per
    // the user's role × module table ("+ HR later" — now built).
    key: "hr", label: "HR", gate: "module.hr", to: "/hr",
    matrixRoles: ["manager", "accountant"],
    menus: [
      { key: "hr.attendance", label: "Attendance" },
      { key: "hr.employees", label: "Employees" },
      { key: "hr.roster", label: "Roster" },
      { key: "hr.requests", label: "Requests" },
      { key: "hr.payroll", label: "Payroll" },
      { key: "hr.advances", label: "Advances" },
      { key: "hr.settings", label: "Settings" },
      { key: "admin.attendance-machine", label: "Attendance Machine" },
    ],
    support: ["hr.salary"],
    noAutoView: ["hr.salary", "hr.payroll", "hr.advances"],
  },
  {
    key: "quality-control", label: "Quality Control", gate: "module.quality-control", to: "/modules?module=quality-control",
    matrixRoles: ["manager", "qc_engineer"],
    menus: [
      { key: "quality.lab-technician", label: "Laboratory" },
      { key: "quality.mix-assignments", label: "Approved Mix Designs" },
      { key: "quality.mix-designs", label: "Mix Designs (Approve)" },
      { key: "quality.mix-designs-view", label: "Mix Designs & Recipes" },
      { key: "quality.cube-test-report", label: "Cube Test Report" },
      { key: "quality.cube-qc-dashboard", label: "Cube Strength Analysis" },
      // Round 194
      { key: "quality.rm-tests", label: "Raw Material Tests" },
      { key: "quality.rm-test-register", label: "Raw Material Test Register" },
      { key: "quality.rm-test-plans", label: "Raw Material Test Plans" },
    ],
    support: ["quality.cube-tests", "quality.lab-due-today", "quality.raw-material-stock",
      "quality.mix-design-approve", "production.recipe-edit", "quality.rm-test-approve"],
  },
];

// Function groups the user listed that are not modules in their table — the
// Administrator dashboard's Production and Fuel & Lubricants tiles. Each
// screen is switchable; there is no whole-group switch (the future Fuel
// Module will get one when it is built).
export const FUNCTION_GROUPS = [
  {
    key: "production", label: "Production",
    menus: [
      { key: "production.targets", label: "Production Target" },
      { key: "production.correct-order", label: "Correct Order" },
      { key: "production.correct-tickets", label: "Correct Tickets" },
      { key: "reports.production", label: "Daily Production Report" },
      { key: "reports.trip-allowance", label: "Trip Allowance Report" },
      { key: "reports.cycle-time", label: "Cycle Time Report" },
    ],
  },
  {
    key: "fuel-lubricants", label: "Fuel & Lubricants",
    menus: [
      { key: "reports.fuel-analysis", label: "360° Fuel Analysis" },
      { key: "fleet.fuel-stations", label: "Fuel Stations & Equipment" },
      { key: "reports.fuel", label: "Fuel & Lubricant Report" },
    ],
  },
];

function moduleKeys(m) {
  const out = [];
  for (const menu of m.menus) {
    out.push(menu.key);
    for (const ch of menu.children || []) out.push(ch.key);
  }
  return [...out, ...m.support];
}

// key -> module key, for every function that lives inside a module.
export const MODULE_OF_KEY = {};
for (const m of MODULES) for (const k of moduleKeys(m)) MODULE_OF_KEY[k] = m.key;
export const MODULE_BY_KEY = Object.fromEntries(MODULES.map((m) => [m.key, m]));

// The (role, key, action) rows the user's table adds — view only. Applied to
// the catalogue's own defaults right here, so a fresh database is seeded with
// them, and exported so setup.js can add exactly these rows to a live one.
export const MATRIX_GRANTS = [];

function applyMatrix(catalogueByKey) {
  for (const m of MODULES) {
    const keys = [m.gate, ...moduleKeys(m)].filter((k) => !(m.noAutoView || []).includes(k));
    for (const role of m.matrixRoles) {
      for (const k of keys) {
        const c = catalogueByKey[k];
        if (!c || c.locked || !c.actions.includes("view")) continue;
        const cur = c.roles[role] || [];
        if (!cur.includes("view")) c.roles[role] = ["view", ...cur];
        MATRIX_GRANTS.push([role, k, "view"]);
      }
    }
  }
}

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

// Round 192 — fold the user's role × module table into the defaults above.
applyMatrix(CATALOGUE_BY_KEY);

// A module's gate and everything inside it, for the Super Admin page.
export function functionsOfModule(moduleKey) {
  const m = MODULE_BY_KEY[moduleKey];
  return m ? [m.gate, ...moduleKeys(m)] : [];
}

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
