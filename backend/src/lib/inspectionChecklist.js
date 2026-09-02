// The digitized "Transit Mixer Weekly Inspection Checklist" (round 98, item
// 11) — transcribed verbatim from the business's own
// TM_Check_list_for_Plant_Incharge.pdf: 5 sections, 36 line items, each
// scored Poor / Satisfactory / Good / Very Good.
//
// Single source of truth: the frontend fetches this from GET
// /api/maintenance/checklist-definition rather than keeping its own copy,
// so the rendered form and the server-side scoring/validation can never
// drift apart (unlike the driver i18n dictionaries, which are deliberately
// duplicated per-bundle — this is static reference data with no per-bundle
// reason to split).

export const RATING_SCALE = [
  { value: 1, label: "Poor" },
  { value: 2, label: "Satisfactory" },
  { value: 3, label: "Good" },
  { value: 4, label: "Very Good" },
];

// Round 133 — a Poor/Satisfactory/Good/Very Good rating doesn't mean
// anything for a safety/documentation checkpoint (business feedback: a fire
// extinguisher is either there or it isn't — asking whether it's
// "Satisfactory" vs "Good" doesn't make sense). These items instead get a
// two-option response, worded per item ("Available" for equipment that's
// either present or not, "Working" for something that operates or doesn't,
// "Yes" for a plain yes/no fact). Deliberately reuses the SAME 1..4 value
// space as RATING_SCALE (1 = negative, 4 = positive, matching Poor/Very
// Good) so scoreFromRatings below needs no changes at all — a "No" scores
// exactly like a "Poor" would have, a "Yes" exactly like "Very Good" (per
// the business's confirmed choice) — and the ratings JSONB column keeps
// storing plain numbers either way. Only the rendered label pair differs.
function binaryScale(positiveLabel, negativeLabel) {
  return [
    { value: 4, label: positiveLabel },
    { value: 1, label: negativeLabel },
  ];
}

export const CHECKLIST_SECTIONS = [
  {
    key: "cleanliness",
    title: "1. Cleanliness",
    items: [
      { key: "cabin_interior", label: "Cabin Interior" },
      { key: "cabin_exterior", label: "Cabin Exterior" },
      { key: "windshield_mirrors", label: "Windshield & Mirrors" },
      { key: "chassis_cleanliness", label: "Chassis Cleanliness" },
      { key: "wheel_mudguard_area", label: "Wheel & Mudguard Area" },
      { key: "branding_plate_visibility", label: "Company Branding & Number Plate Visibility" },
    ],
  },
  {
    key: "drum_discharge",
    title: "2. Drum & Discharge System",
    items: [
      { key: "concrete_buildup", label: "Concrete Build-up on Drum/Chassis/Roller Area" },
      { key: "drum_exterior_condition", label: "Drum Exterior Condition" },
      { key: "drum_mouth_cleanliness", label: "Drum Mouth Cleanliness" },
      { key: "charging_hopper", label: "Charging Hopper" },
      { key: "main_discharge_chute", label: "Main Discharge Chute" },
      { key: "extension_chutes", label: "Extension Chutes" },
      { key: "chute_bags", label: "Chute Bags" },
      { key: "water_tank_condition", label: "Water Tank Condition" },
      { key: "water_spray_system", label: "Water Spray System" },
    ],
  },
  {
    key: "mechanical",
    title: "3. Mechanical Condition",
    items: [
      { key: "engine_condition", label: "Engine Condition" },
      { key: "hydraulic_system", label: "Hydraulic System" },
      { key: "pto_slave_engine", label: "PTO / Slave Engine System" },
      { key: "oil_leakage", label: "Oil Leakage" },
      { key: "coolant_level", label: "Coolant Level" },
      { key: "hydraulic_oil_level", label: "Hydraulic Oil Level" },
      { key: "battery_condition", label: "Battery Condition" },
      { key: "belts_hoses", label: "Belts & Hoses" },
    ],
  },
  {
    key: "tyres_chassis",
    title: "4. Tyres & Chassis",
    items: [
      { key: "front_tyres", label: "Front Tyres" },
      { key: "rear_tyres", label: "Rear Tyres" },
      { key: "tyre_tread_condition", label: "Tyre Tread Condition" },
      { key: "wheel_nuts", label: "Wheel Nuts" },
      { key: "suspension_condition", label: "Suspension Condition" },
      { key: "chassis_condition", label: "Chassis Condition" },
    ],
  },
  {
    key: "safety_docs",
    title: "5. Safety & Documentation",
    items: [
      { key: "fire_extinguisher", label: "Fire Extinguisher", scale: binaryScale("Available", "Not Available") },
      { key: "reverse_alarm", label: "Reverse Alarm", scale: binaryScale("Working", "Not Working") },
      { key: "lights_indicators", label: "Lights & Indicators", scale: binaryScale("Working", "Not Working") },
      { key: "horn", label: "Horn", scale: binaryScale("Working", "Not Working") },
      { key: "reflective_tape_markings", label: "Reflective Tape & Safety Markings", scale: binaryScale("Available", "Not Available") },
      { key: "first_aid_kit", label: "First Aid Kit", scale: binaryScale("Available", "Not Available") },
      { key: "vehicle_documents_available", label: "Vehicle Documents Available", scale: binaryScale("Yes", "No") },
    ],
  },
];

export const CHECKLIST_ITEM_KEYS = CHECKLIST_SECTIONS.flatMap((s) => s.items.map((i) => i.key));

// 1 (Poor) .. 4 (Very Good) -> 0..100, so it combines directly with the
// other 0-100 Best Driver components.
export function scoreFromRatings(ratings) {
  const values = CHECKLIST_ITEM_KEYS.map((k) => Number(ratings?.[k])).filter((v) => v >= 1 && v <= 4);
  if (!values.length) return null;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.round(((avg - 1) / 3) * 1000) / 10;
}
