// Where each role lands after signing in — shared by Login (initial redirect)
// and TopBar (the "back to my dashboard" link from shared screens like Orders).
export const ROLE_HOME = {
  administrator: "/reports",
  manager: "/manager",
  plant_operator: "/plant-operator",
  qc_engineer: "/qc",
  driver: "/driver",
  site_supervisor: "/site-supervisor",
  accountant: "/accountant",
};

export const ROLE_LABEL = {
  administrator: "Administrator",
  manager: "Manager",
  plant_operator: "Plant Operator",
  qc_engineer: "QC Engineer",
  driver: "Driver",
  site_supervisor: "Site Supervisor",
  accountant: "Accountant",
};
