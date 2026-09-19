// Where each role lands after signing in — shared by Login (initial redirect)
// and TopBar (the "back to my dashboard" link from shared screens like Orders).
export const ROLE_HOME = {
  // Round 143 — was "/reports". The Administrator's home is now the icon-view
  // dashboard, which is the point of it: signing in lands on the grid, and
  // the Reports page it used to land on is the "Directors Dashboard" tile on
  // that grid. This also stops the dashboard itself showing TopBar's own
  // "Back to my dashboard" link, which pointed at a different page.
  administrator: "/administrator",
  manager: "/manager",
  plant_operator: "/plant-operator",
  qc_engineer: "/qc",
  driver: "/driver",
  site_supervisor: "/site-supervisor",
  accountant: "/accountant",
  sales_executive: "/sales",
  store: "/store",
  lab_technician: "/lab-technician",
  // Round 133 — no page of their own; FuelFilling.jsx's request form/history
  // (already shared by driver/site_supervisor/plant_operator) is their whole
  // job, so it's also their home.
  loader_operator: "/fuel",
};

export const ROLE_LABEL = {
  administrator: "Administrator",
  manager: "Manager",
  plant_operator: "Plant Operator",
  qc_engineer: "QC Engineer",
  driver: "Driver",
  site_supervisor: "Site Supervisor",
  accountant: "Accountant",
  sales_executive: "Sales Executive",
  store: "Store",
  lab_technician: "Lab Technician",
  loader_operator: "Loader Operator",
};
