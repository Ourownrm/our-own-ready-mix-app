// Round 143 — the Administrator dashboard's screen registry.
//
// ONE list of every screen the Administrator can open, grouped into the eight
// modules of the approved icon-view mockup ("Admin Dashboard — Icon View" +
// claude/admin-dashboard-icon-view-notes.md). Administrator.jsx renders the
// grid straight from this; nothing else hard-codes a label, an icon or a
// destination.
//
// Why a registry and not markup: the same list is what the Super Admin
// per-user permission work will switch tiles on and off from, and what a
// future "is every admin-reachable route on the dashboard?" check would read.
// Three screens (Cube Test Report, the Manager dashboard, the Lab Technician
// screen) were reachable by route for months and absent from the menu, found
// only by eye — a single list is how that stops happening.
//
// A screen has EITHER `to` (a route, navigated to) or `view` (a panel
// Administrator.jsx renders in place, via ?view=). Never both.

// 24x24 stroke glyphs, drawn in currentColor. Inline SVG rather than an icon
// font or images: no extra request, and the colour follows the module.
export const GLYPHS = {
  chart: '<path d="M3 20h18"/><rect x="5" y="10" width="3.4" height="7" rx="1"/><rect x="10.3" y="6" width="3.4" height="11" rx="1"/><rect x="15.6" y="13" width="3.4" height="4" rx="1"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  alert: '<path d="M12 4 2.7 20h18.6z"/><path d="M12 10v4M12 17.4v.2"/>',
  wrench: '<path d="M15.5 4.5a4.5 4.5 0 0 0-5.9 5.9L4 16v4h4l5.6-5.6a4.5 4.5 0 0 0 5.9-5.9L17 11l-3-3z"/>',
  fuel: '<path d="M12 3s5 5.6 5 9a5 5 0 0 1-10 0c0-3.4 5-9 5-9z"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M9 12h6M9 9.5h6M11.7 12c0 2-.9 3.2-2.4 3.6"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 9.5 4.1-1.9 7-5.3 7-9.5V6z"/><path d="m9.2 12 2 2 3.6-3.6"/>',
  hourglass: '<path d="M7 3h10M7 21h10"/><path d="M7 3c0 4 5 5.2 5 9s-5 5-5 9"/><path d="M17 3c0 4-5 5.2-5 9s5 5 5 9"/>',
  trend: '<path d="M3 17l5.5-5.5 3.5 3.5L21 6"/><path d="M15.5 6H21v5.5"/>',
  cycle: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/>',
  flask: '<path d="M10 3h4M11 3v6L5.6 18A2 2 0 0 0 7.3 21h9.4a2 2 0 0 0 1.7-3L13 9V3"/><path d="M8.4 14h7.2"/>',
  microscope: '<path d="M5.5 20.5h13"/><path d="M10 20.5a5.5 5.5 0 0 0 5.6-8.4"/><path d="M8.5 16.6h4.2"/><path d="M13.4 5.2 16.1 7.9l-3.6 3.6-2.7-2.7z"/><path d="m11.2 7.4-1.7 1.7"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.3 2.5-5.4 5.5-5.4s5.5 2.1 5.5 5.4"/><path d="M16.5 6.3a3 3 0 0 1 0 5.8M17.5 14.9c1.9.6 3.2 2.4 3.2 5.1"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.6 3-6 7-6s7 2.4 7 6"/>',
  building: '<path d="M4 21V6l8-3 8 3v15"/><path d="M4 21h16"/><path d="M9 21v-5h6v5"/><path d="M8.5 9.5h1.5M14 9.5h1.5M8.5 13h1.5M14 13h1.5"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
  tag: '<path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1a1 1 0 0 1 .7.3l7 7a1 1 0 0 1 0 1.4l-8.1 8.1a1 1 0 0 1-1.4 0l-7-7a1 1 0 0 1-.3-.7z"/><circle cx="8" cy="8" r="1.4"/>',
  truck: '<path d="M2.5 16V7h10v9"/><path d="M12.5 10H17l4 3.4V16"/><circle cx="6.5" cy="17.6" r="1.9"/><circle cx="17" cy="17.6" r="1.9"/><path d="M8.4 17.6h6.7"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="1"/>',
  layers: '<path d="m12 3 8.5 4.5L12 12 3.5 7.5z"/><path d="m4.5 12 7.5 4 7.5-4"/><path d="m4.5 16.5 7.5 4 7.5-4"/>',
  box: '<path d="M20.5 7.6 12 3 3.5 7.6v8.8L12 21l8.5-4.6z"/><path d="M3.7 7.7 12 12.2l8.3-4.5M12 12.2V21"/>',
  phone: '<rect x="6.5" y="2.6" width="11" height="18.8" rx="2.4"/><path d="M10.6 5.4h2.8"/><path d="M11 18.4h2"/>',
  star: '<path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1.1 5.9-5.3-2.9-5.3 2.9 1.1-5.9L3.5 9.8l5.9-.8z"/>',
  chat: '<path d="M20.5 12.6c0 4-3.8 7.2-8.5 7.2a10 10 0 0 1-2.8-.4L4 21l1.4-3.7A6.9 6.9 0 0 1 3.5 12.6c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.7h17M8.5 3v4M15.5 3v4"/>',
  image: '<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2"/><circle cx="9" cy="10" r="1.7"/><path d="m4.4 17.6 4.9-4.5 3.6 3.1 3-2.5 3.7 3.2"/>',
  globe: '<circle cx="12" cy="12" r="8.6"/><path d="M3.6 12h16.8"/><path d="M12 3.4c2.4 2.6 3.6 5.6 3.6 8.6S14.4 18 12 20.6C9.6 18 8.4 15 8.4 12S9.6 6 12 3.4z"/>',
  link: '<path d="M10.2 13.8a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7l-1.3 1.3"/><path d="M13.8 10.2a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 1 0 5.7 5.7l1.3-1.3"/>',
  edit: '<path d="M4 20h4L19.2 8.8a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.8 4.2 19.8 9.2"/>',
  receipt: '<path d="M6 3h12v18l-3-1.8-3 1.8-3-1.8L6 21z"/><path d="M9.2 8h5.6M9.2 12h5.6"/>',
  funnel: '<path d="M3.6 4.5h16.8L14 12.4V19l-4 2v-8.6z"/>',
  gauge: '<path d="M4 17a8.5 8.5 0 1 1 16 0"/><path d="m12 17 4-5.4"/><circle cx="12" cy="17" r="1.2"/>',
  factory: '<path d="M3 21h18"/><path d="M3.5 21V11l5.3 3.4V11l5.3 3.4V7.6L19.5 11v10"/><path d="M7 17.4h1.6M12 17.4h1.6M16.8 17.4h1.4"/>',
  rupee: '<path d="M7.5 4.5h9M7.5 9h9M15 4.5c0 3.3-3 4.5-6 4.5l7.5 10.5"/>',
};

// Each module: a saturated colour for the big tile (white glyph on it) and a
// tint for its sub-tiles, so a sub-screen always reads as belonging to the
// module it came from.
export const ADMIN_MODULES = [
  {
    key: "directors-dashboard",
    label: "Directors Dashboard",
    icon: "chart",
    colour: "#1F6FB2",
    tint: "#E2EEF7",
    to: "/reports", // opens straight away — no sub-grid
    screens: [],
  },
  {
    key: "production",
    label: "Production",
    icon: "factory",
    colour: "#C75B12",
    tint: "#FBEDE3",
    screens: [
      // The Manager dashboard, reachable by an Administrator all along
      // (App.jsx guards it manager+administrator) but never linked from here.
      // Labelled by what it shows, not whose screen it is. First in the
      // module at the user's request — it is the overview the rest explain.
      { key: "plant-manager", label: "Plant Manager", icon: "gauge", to: "/manager" },
      { key: "production-target", label: "Production Target", icon: "target", view: "production-target" },
      { key: "correct-order", label: "Correct Order", icon: "edit", view: "orders" },
      { key: "correct-tickets", label: "Correct Tickets", icon: "receipt", view: "tickets" },
      { key: "daily-production-report", label: "Daily Production Report", icon: "doc", to: "/production-report" },
      { key: "trip-allowance-report", label: "Trip Allowance Report", icon: "cash", to: "/trip-allowance-report" },
      { key: "cycle-time-report", label: "Cycle Time Report", icon: "cycle", to: "/cycle-time-report" },
      { key: "charts", label: "Charts", icon: "trend", to: "/charts" },
      { key: "delay-justification", label: "Delay Justification Report", icon: "hourglass", to: "/delay-justification-report" },
      { key: "time-cross-check", label: "Time Cross Check", icon: "clock", to: "/trip-time-crosscheck" },
    ],
  },
  {
    key: "fuel-lubricants",
    label: "Fuel & Lubricants",
    icon: "fuel",
    colour: "#B4890F",
    tint: "#F7F0DC",
    screens: [
      { key: "fuel-report", label: "Fuel and Lubricant Report", icon: "doc", to: "/fuel-report" },
      { key: "fuel-analysis", label: "360° Fuel Analysis", icon: "gauge", to: "/fuel-analysis" },
      { key: "fuel-stations", label: "Fuel Stations & Equipment", icon: "building", view: "fuel" },
    ],
  },
  {
    key: "plant-equipment",
    label: "Plant & Equipment’s",
    icon: "wrench",
    colour: "#2F7D6E",
    tint: "#E2F1EE",
    screens: [
      { key: "statutory-compliance", label: "Statutory Compliance", icon: "shield", to: "/compliance" },
      { key: "trucks-pumps", label: "Trucks & Pumps", icon: "truck", view: "fleet" },
      { key: "equipment-breakdowns", label: "Equipment Breakdowns", icon: "alert", to: "/breakdowns" },
      { key: "maintenance", label: "Maintenance & Best Driver", icon: "star", to: "/maintenance" },
      { key: "maintenance-action-points", label: "Maintenance Action Points", icon: "wrench", view: "maintenance-action-points" },
      { key: "plant-locations", label: "Plant Location (Geofence)", icon: "globe", view: "plant-locations" },
    ],
  },
  {
    key: "quality-control",
    label: "Quality Control",
    icon: "flask",
    colour: "#7A4BA8",
    tint: "#F0E9F7",
    screens: [
      // The Lab Technician screen, first at the user's request — the lab is
      // where the day's work is, the rest of this module is reference.
      { key: "laboratory", label: "Laboratory", icon: "microscope", to: "/lab-technician" },
      { key: "mix-assignments", label: "Approved Mix Designs", icon: "layers", view: "mix-assignments" },
      { key: "mix-designs-approve", label: "Mix Designs (Approve)", icon: "flask", view: "mix-designs" },
      { key: "cube-test-report", label: "Cube Test Report", icon: "doc", to: "/lab-technician/cube-test-report" },
      { key: "cube-strength-analysis", label: "Cube Strength Analysis", icon: "chart", to: "/cube-qc-dashboard" },
    ],
  },
  {
    key: "sales-collection",
    label: "Sales and Collection",
    icon: "rupee",
    colour: "#1D7A55",
    tint: "#E3F2EC",
    screens: [
      { key: "customers", label: "Customer", icon: "building", view: "customers" },
      { key: "sites", label: "Projects & Sites", icon: "pin", view: "sites" },
      { key: "outstanding-collection", label: "Outstanding Collection Report", icon: "receipt", to: "/outstanding-collection-report" },
      { key: "booking-links", label: "Booking Links & Requests", icon: "link", to: "/customer-booking" },
      { key: "website-content", label: "Website Content", icon: "globe", to: "/site-content" },
      { key: "home-screen-photos", label: "Home Screen Photos", icon: "image", to: "/home-screen-photos" },
      { key: "sales-dashboard", label: "Sales Executive Dashboard", icon: "gauge", to: "/sales" },
      { key: "sales-performance", label: "Sales Performance", icon: "trend", to: "/sales-performance" },
      { key: "sales-forecast", label: "Sales Forecast", icon: "calendar", to: "/sales-forecast" },
      { key: "assign-lead", label: "Assign a Lead", icon: "funnel", view: "assign-lead" },
      { key: "browse-leads", label: "Browse Leads", icon: "people", to: "/leads" },
      { key: "customer-feedback", label: "Customer Feedback", icon: "chat", to: "/customer-feedback" },
      { key: "rates", label: "Concrete Grade & Rates", icon: "tag", view: "rates" },
      { key: "site-contacts", label: "Site Contacts", icon: "phone", view: "site-contacts" },
      { key: "salespersons", label: "Salespersons", icon: "user", view: "salespersons" },
    ],
  },
  {
    key: "material-module",
    label: "Raw Material Module",
    icon: "box",
    colour: "#8A5A2B",
    tint: "#F4EBE1",
    to: "/material-module",
    screens: [],
  },
  {
    // Round 154 — the weighbridge feed. A module of its own rather than a
    // sub-tile of the Raw Material Module, because the people who open it
    // daily (Store, and the Plant Operator answering "what did that lorry
    // weigh") are not the people doing purchase orders, and burying it one
    // level down would cost them a tap every time.
    key: "weighbridge-receipts",
    label: "Weighbridge",
    icon: "gauge",
    colour: "#3F6B52",
    tint: "#E6EFE9",
    to: "/weighbridge",
    screens: [],
  },
  {
    // Round 157 — the batching plant. Deliberately a sibling of Weighbridge
    // rather than a tile under Production: the two are the same kind of thing,
    // a machine's own record arriving here on its own, and they are read by
    // the same people for the same reason — what actually happened, as against
    // what somebody typed in.
    key: "plant-production",
    label: "Plant Production",
    icon: "factory",
    colour: "#4A5A7B",
    tint: "#E8EBF2",
    to: "/plant-production",
    screens: [],
  },
  {
    // Round 158 — sits beside Weighbridge and Plant Production because it is
    // the same kind of thing: a disagreement between what a machine measured
    // and what a human wrote down. The badge is the point — a Manager should
    // be able to see there is a decision waiting without opening anything.
    key: "receipt-differences",
    label: "Receipt Differences",
    icon: "target",
    colour: "#8A4B52",
    tint: "#F4E9EA",
    to: "/receipt-differences",
    screens: [],
  },
  {
    key: "users-roles",
    label: "Users & Roles",
    icon: "people",
    colour: "#47566B",
    tint: "#E9ECF1",
    view: "users",
    screens: [],
  },
];

// Every screen, flattened, for the pin picker and for looking a key up.
// A module that opens directly is a screen in its own right.
export const ALL_SCREENS = ADMIN_MODULES.flatMap((m) =>
  m.screens.length
    ? m.screens.map((s) => ({ ...s, moduleKey: m.key, moduleLabel: m.label, colour: m.colour, tint: m.tint }))
    : [{ key: m.key, label: m.label, icon: m.icon, to: m.to, view: m.view, moduleKey: m.key, moduleLabel: m.label, colour: m.colour, tint: m.tint }]
);

export const SCREEN_BY_KEY = Object.fromEntries(ALL_SCREENS.map((s) => [s.key, s]));

export function moduleByKey(key) {
  return ADMIN_MODULES.find((m) => m.key === key) || null;
}

// What a brand-new Administrator sees pinned before they change anything.
export const DEFAULT_PINS = [
  "directors-dashboard",
  "material-module",
  "correct-tickets",
  "daily-production-report",
  "outstanding-collection",
  "mix-designs-approve",
];

// A module's badge is the total of what is waiting inside it, so the home
// screen can say "something needs you in here" without listing what.
export function moduleBadge(module, badges) {
  if (!badges) return 0;
  if (!module.screens.length) return badges[module.key] || 0;
  return module.screens.reduce((sum, s) => sum + (badges[s.key] || 0), 0);
}
