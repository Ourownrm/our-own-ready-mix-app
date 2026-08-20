// Round 99, item 3 — canonical list of common Transit Mixer breakdown
// issues, so a driver reporting a breakdown can pick from a short list
// instead of typing it out every time. Single source of truth, fetched by
// the frontend via GET /master/breakdown-issue-types (same pattern as
// inspectionChecklist.js's checklist-definition endpoint) rather than
// duplicated in the frontend bundle.
//
// "other" is always last and always paired with a required free-text
// remarks field on the frontend, since it's the escape hatch for anything
// not on this list.
export const BREAKDOWN_ISSUE_TYPES = [
  { value: "tyre_puncture", label: "Tyre puncture / burst" },
  { value: "engine_trouble", label: "Engine won't start / stalls" },
  { value: "overheating", label: "Overheating" },
  { value: "drum_mixer_fault", label: "Drum / mixer motor not turning" },
  { value: "hydraulic_failure", label: "Hydraulic system failure" },
  { value: "battery_electrical", label: "Battery / electrical fault" },
  { value: "brake_failure", label: "Brake failure" },
  { value: "fuel_issue", label: "Fuel shortage / fuel system issue" },
  { value: "clutch_gearbox", label: "Clutch / gearbox issue" },
  { value: "accident", label: "Accident / collision" },
  { value: "other", label: "Other" },
];

export const BREAKDOWN_ISSUE_LABELS = Object.fromEntries(BREAKDOWN_ISSUE_TYPES.map((i) => [i.value, i.label]));
