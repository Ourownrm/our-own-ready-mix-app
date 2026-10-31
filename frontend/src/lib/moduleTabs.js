// Round 256 — the tabs of each tabbed module, in one place.
//
// The computer side menu (lib/SideMenu.jsx) lists a module's screens under it,
// and the module page (pages/AccountsModule.jsx and friends) shows the same
// screens as its tab strip. Both read this list, so a tab added to a module
// shows up in the side menu without a second edit, and the two can never
// disagree about who may see what.
//
// No components here — only key, label and the permission(s) that open the
// tab — so the side menu can import it without pulling every page in. Each
// page maps its own components onto these keys.
//
// A tab opens when:
//   any: [[permKey, action], …]  — any one of these is held, or
//   perm: key | [keys]           — any of these is held on `action` (view).

export function tabAllowed(t, can) {
  if (t.any) return t.any.some(([p, a]) => can(p, a));
  const action = t.action || "view";
  return [].concat(t.perm).some((p) => can(p, action));
}

// Production → Reports: the report links inside that tab (pages/ProductionModule.jsx).
export const PRODUCTION_REPORTS = [
  { label: "Daily Production Report", to: "/production-report", perm: "reports.production" },
  { label: "Trip Allowance Report", to: "/trip-allowance-report", perm: "reports.trip-allowance" },
  { label: "Cycle Time Report", to: "/cycle-time-report", perm: "reports.cycle-time" },
  { label: "Truck Timing Report", to: "/truck-timing-report", perm: "reports.truck-timing" },
  { label: "Delay Justification Report", to: "/delay-justification-report", perm: "reports.delay-justification" },
  { label: "Time Cross Check", to: "/trip-time-crosscheck", perm: "reports.trip-time-crosscheck" },
  { label: "Charts", to: "/charts", perm: "reports.charts" },
  { label: "Fuel and Lubricant Report", to: "/fuel-report", perm: "reports.fuel" },
  { label: "Best Driver & Site Efficiency", to: "/maintenance", perm: "fleet.maintenance" },
  { label: "Outstanding Collection", to: "/outstanding-collection-report", perm: "accounts.outstanding" },
];

// Keyed by the module's key in lib/adminScreens.js.
export const MODULE_TABS = {
  production: {
    path: "/production",
    tabs: [
      { key: "overview", label: "Plant overview", perm: "production.manager-dashboard" },
      { key: "orders", label: "Orders", perm: "production.correct-order" },
      { key: "tickets", label: "Delivery tickets", perm: "production.correct-tickets" },
      { key: "tracking", label: "Vehicle tracking", perm: "orders.live-tracking" },
      { key: "customers", label: "Customers & sites", perm: "masters.customers" },
      { key: "target", label: "Production target", perm: "production.targets" },
      { key: "reports", label: "Reports", any: PRODUCTION_REPORTS.map((r) => [r.perm, "view"]) },
    ],
  },
  "material-module": {
    path: "/material-module",
    // Materials / Suppliers have their own view keys (Round 192) so a Super
    // Admin can show the masters read-only; Receipt Variances opens on either
    // function (Round 204).
    tabs: [
      { key: "stock", label: "Stock", perm: "material.stock" },
      { key: "orders", label: "Orders", perm: "material.orders" },
      { key: "receipts", label: "Receipts", perm: "material.receipts" },
      { key: "consumption", label: "Consumption", perm: "material.consumption" },
      { key: "physical-stock", label: "Physical Stock", perm: "material.physical-stock" },
      { key: "consumption-transfer", label: "Consumption transfer", perm: "material.consumption-transfer" },
      { key: "reports", label: "Reports", perm: "material.reports" },
      { key: "cost-dashboard", label: "Cost Dashboard", perm: "material.cost-dashboard" },
      { key: "supplier-ledger", label: "Supplier Ledger", perm: "material.supplier-ledger" },
      { key: "transporter-ledger", label: "Transporter Ledger", perm: "material.transporter-ledger" },
      { key: "materials", label: "Materials", perm: "material.materials-menu" },
      { key: "suppliers", label: "Suppliers", perm: "material.suppliers-menu" },
      { key: "receipt-variances", label: "Receipt Variances", perm: ["material.receipt-confirm", "weighbridge.receipt-variance"] },
    ],
  },
  "maintenance-module": {
    path: "/maintenance-module",
    tabs: [
      { key: "dashboard", label: "Dashboard", perm: "mnt.dashboard" },
      { key: "equipment", label: "Equipment", perm: "mnt.equipment" },
      { key: "schedules", label: "PM schedules", perm: "mnt.schedules" },
      { key: "inspection", label: "PM Inspection", perm: "mnt.inspections" },
      { key: "job-cards", label: "Job cards", perm: "mnt.job-cards" },
      { key: "outside", label: "Outside repairs", perm: "mnt.outside-repairs" },
      { key: "purchase", label: "Parts, PO & GRV", perm: "mnt.purchase-orders" },
      { key: "store", label: "Store stock", perm: "mnt.store" },
      { key: "tyres", label: "Tyres & batteries", perm: "mnt.tyres" },
      { key: "certificates", label: "Certificates", perm: "mnt.certificates" },
      { key: "payments", label: "Payments", perm: "mnt.payments" },
    ],
  },
  "fuel-module": {
    path: "/fuel-module",
    tabs: [
      { key: "dashboard", label: "Dashboard", perm: "fuel.dashboard" },
      { key: "transactions", label: "Transactions", perm: "fuel.transactions" },
      { key: "issue", label: "Issue fuel", perm: "fuel.issue" },
      { key: "purchases", label: "Purchases", perm: "fuel.purchases" },
      { key: "analysis", label: "360° Analysis", perm: "reports.fuel-analysis" },
      { key: "reports", label: "Reports", perm: "fuel.reports" },
      { key: "settings", label: "Settings", perm: "fuel.settings" },
      { key: "corrections", label: "Corrections", perm: "fuel.corrections" },
    ],
  },
  "accounts-module": {
    path: "/accounts",
    // Rate migration is switched off (Round 252) and is not listed.
    tabs: [
      { key: "quotations", label: "Quotations", perm: "accounts.quotations" },
      { key: "price-lists", label: "Price lists", perm: "accounts.price-lists" },
      { key: "invoices", label: "Invoices", perm: "accounts.invoice-list" },
      { key: "credit-notes", label: "Credit notes", perm: "accounts.credit-notes" },
      { key: "ledger", label: "Customer ledger", perm: "accounts.customer-ledger" },
      { key: "receipts", label: "Bank receipts", perm: "accounts.bank-receipts" },
      { key: "cheques", label: "Cheques", perm: "accounts.cheques" },
      { key: "petty-cash", label: "Petty cash", perm: "accounts.petty-cash" },
      { key: "send-to-ca", label: "Send to CA", perm: "accounts.send-to-ca" },
      { key: "settings", label: "Settings", perm: "accounts.quotation-settings" },
    ],
  },
  "cost-module": {
    path: "/cost",
    // `current`: the tab opens on the current month, not the last closed one.
    tabs: [
      { key: "dashboard", label: "Cost dashboard", perm: "cost.dashboard" },
      { key: "pl", label: "Profit & Loss", perm: "cost.pl" },
      { key: "balance-sheet", label: "Balance Sheet", perm: "cost.balance-sheet" },
      { key: "break-even", label: "Break-even", perm: "cost.break-even", current: true },
      { key: "water", label: "Water", perm: "cost.pl" },
      { key: "bank", label: "Bank statements", perm: "cost.bank", current: true },
      { key: "loans", label: "Loans", perm: "cost.bank" },
      { key: "partners", label: "Partners", perm: "cost.bank" },
      { key: "gst", label: "GST payable", perm: "cost.gst" },
      { key: "c-ledger", label: "C Ledger", perm: "cledger.access" },
    ],
  },
  hr: {
    path: "/hr",
    tabs: [
      { key: "today", label: "Today", perm: "hr.today" },
      { key: "attendance", label: "Attendance", perm: "hr.attendance" },
      { key: "employees", label: "Employees", perm: "hr.employees" },
      { key: "requests", label: "Requests", perm: "hr.requests" },
      { key: "leave", label: "Leave", perm: "hr.requests" },
      { key: "compoff", label: "Comp-off", perm: "hr.requests" },
      { key: "roster", label: "Roster", perm: "hr.roster" },
      { key: "payroll", label: "Payroll", perm: "hr.payroll" },
      { key: "advances", label: "Advances", any: [["hr.advances", "view"], ["hr.advance-request", "view"], ["hr.advance-approve", "edit"], ["hr.advance-pay", "edit"]] },
      { key: "contract", label: "Contract labour", perm: "hr.gangs" },
      { key: "bills", label: "Contractor bills", perm: "hr.contractor-bills" },
      { key: "ppe", label: "PPE", any: [["hr.ppe", "view"], ["hr.ppe-approve", "edit"]] },
      { key: "exits", label: "Exits", any: [["hr.exit", "view"], ["hr.exit-approve", "edit"]] },
      { key: "settings", label: "Settings", perm: "hr.settings" },
    ],
  },
};
