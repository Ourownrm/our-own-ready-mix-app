// Round 157 — MCI370's twenty material slots, in one place.
//
// This file is the single definition of what a batching-plant mix is made of,
// and it exists because that list is genuinely odd and genuinely fixed. It was
// read out of the real `Batch_Transaction` table in MCI370's own Access
// database (mdbtools, 2026-09-25) — nothing here is inferred from a manual or
// guessed from a field name.
//
// THE SHAPE, AND WHY IT IS LIKE THIS
//
// MCI370 is a VB6 program from a vendor who hard-coded one column per physical
// weigh hopper. So there is no materials table on that side — there are
// `Gate1_Actual`, `Gate1_Target`, `Gate1_Moisture`, then the same for gates 2
// to 6, then four cements, a filler, two waters, silica, slurry, two
// admixtures with two dosing lines each, and a pigment. Twenty slots, always
// present, whether or not the plant has the hopper.
//
// Which physical material each slot holds is decided by the PLANT, not the
// vendor, and MCI370 records that decision in its `NameSetUp` table —
// `Gate1Name`, `Cem1Name`, `Wtr1Name` and so on. The installer copy still
// carries a previous customer's settings, which is how we know the shape:
// Gate1Name "40 MM", Gate2Name "SAND", Gate3Name "10 MM", Gate4Name "20 MM",
// Cem1Name "FLY", Cem2Name "CEM". Unused hoppers are left as "0", "-", blank,
// or a vendor default like "Agg6".
//
// So: the slot is structural, the name is the plant's, and mapping that name
// to one of our materials is a human decision held in plant_silo_aliases —
// exactly the same design as the weighbridge, for exactly the same reason.
//
// THE THREE KINDS OF SLOT
//
//   aggregate  — has a real moisture reading. These are the gates, and their
//                moisture is the only trustworthy moisture figure anywhere in
//                this plant's data (the weighbridge's is free text and has
//                never once held a number).
//   powder     — cement, filler, silica, slurry. Carries a correction rather
//                than moisture.
//   liquid     — water and admixtures. Also a correction. Admixtures have two
//                dosing lines each, which is why adm1 appears twice.
//
// Nothing downstream should hard-code a slot name. Read this list.

/**
 * key        our stable slot identifier, stored in plant_batch_materials.slot
 * kind       aggregate | powder | liquid
 * nameField  the column in MCI370's NameSetUp that names this hopper
 * actual     the Batch_Transaction column holding what was actually weighed, kg
 * target     ... and what the recipe asked for, kg
 * moisture   aggregate slots only
 * correction everything else
 * label      what a person sees before the plant has named the hopper
 */
export const PLANT_SLOTS = [
  { key: "gate1",   kind: "aggregate", nameField: "Gate1Name",   actual: "Gate1_Actual",   target: "Gate1_Target",   moisture: "Gate1_Moisture", label: "Aggregate 1" },
  { key: "gate2",   kind: "aggregate", nameField: "Gate2Name",   actual: "Gate2_Actual",   target: "Gate2_Target",   moisture: "Gate2_Moisture", label: "Aggregate 2" },
  { key: "gate3",   kind: "aggregate", nameField: "Gate3Name",   actual: "Gate3_Actual",   target: "Gate3_Target",   moisture: "Gate3_Moisture", label: "Aggregate 3" },
  { key: "gate4",   kind: "aggregate", nameField: "Gate4Name",   actual: "Gate4_Actual",   target: "Gate4_Target",   moisture: "Gate4_Moisture", label: "Aggregate 4" },
  { key: "gate5",   kind: "aggregate", nameField: "Gate5Name",   actual: "Gate5_Actual",   target: "Gate5_Target",   moisture: "Gate5_Moisture", label: "Aggregate 5" },
  { key: "gate6",   kind: "aggregate", nameField: "Gate6Name",   actual: "Gate6_Actual",   target: "Gate6_Target",   moisture: "Gate6_Moisture", label: "Aggregate 6" },

  { key: "cement1", kind: "powder",    nameField: "Cem1Name",    actual: "Cement1_Actual", target: "Cement1_Target", correction: "Cement1_Correction", label: "Cement 1" },
  { key: "cement2", kind: "powder",    nameField: "Cem2Name",    actual: "Cement2_Actual", target: "Cement2_Target", correction: "Cement2_Correction", label: "Cement 2" },
  { key: "cement3", kind: "powder",    nameField: "Cem3Name",    actual: "Cement3_Actual", target: "Cement3_Target", correction: "Cement3_Correction", label: "Cement 3" },
  { key: "cement4", kind: "powder",    nameField: "Cem4Name",    actual: "Cement4_Actual", target: "Cement4_Target", correction: "Cement4_Correction", label: "Cement 4" },
  { key: "filler1", kind: "powder",    nameField: "FillName",    actual: "Filler1_Actual", target: "Filler1_Target", correction: "Filler1_Correction", label: "Filler" },
  { key: "silica",  kind: "powder",    nameField: "SilicaName",  actual: "Silica_Actual",  target: "Silica_Target",  correction: "Silica_Correction",  label: "Silica" },
  { key: "slurry",  kind: "powder",    nameField: "SlurryName",  actual: "Slurry_Actual",  target: "Slurry_Target",  correction: "Slurry_Correction",  label: "Slurry" },

  { key: "water1",  kind: "liquid",    nameField: "Wtr1Name",    actual: "Water1_Actual",  target: "Water1_Target",  correction: "Water1_Correction",  label: "Water 1" },
  { key: "water2",  kind: "liquid",    nameField: "wtr2Name",    actual: "Water2_Actual",  target: "Water2_Target",  correction: "Water2_Correction",  label: "Water 2" },

  // Two admixture units, two dosing lines each. MCI370 names them
  // Admix1Name/Admix12Name and Admix2Name/Admix22Name — note the awkward
  // "12"/"22" meaning "unit 1 line 2" and "unit 2 line 2", not twelve and
  // twenty-two. Left as the vendor spells them so a future reader can grep.
  { key: "adm1a",   kind: "liquid",    nameField: "Admix1Name",  actual: "Adm1_Actual1",   target: "Adm1_Target1",   correction: "Adm1_Correction1", label: "Admixture 1" },
  { key: "adm1b",   kind: "liquid",    nameField: "Admix12Name", actual: "Adm1_Actual2",   target: "Adm1_Target2",   correction: "Adm1_Correction2", label: "Admixture 1b" },
  { key: "adm2a",   kind: "liquid",    nameField: "Admix2Name",  actual: "Adm2_Actual1",   target: "Adm2_Target1",   correction: "Adm2_Correction1", label: "Admixture 2" },
  { key: "adm2b",   kind: "liquid",    nameField: "Admix22Name", actual: "Adm2_Actual2",   target: "Adm2_Target2",   correction: "Adm2_Correction2", label: "Admixture 2b" },

  { key: "pigment", kind: "powder",    nameField: "PigName",     actual: "Pigment_Actual", target: "Pigment_Target", label: "Pigment" },
];

export const SLOT_BY_KEY = Object.fromEntries(PLANT_SLOTS.map((s) => [s.key, s]));

// What a plant writes into NameSetUp for a hopper it does not have. Taken from
// the real file: the previous customer left Gate5Name as "0", wtr2Name and
// SilicaName as "-", and Cem4Name blank. "Agg6" is the vendor's own default
// for an unnamed sixth aggregate.
//
// Matched after normalising, so "Agg 6" and "agg6" are caught too.
// ROUND 159 — "1" added after seeing the live plant: its Admix12Name reads
// literally "1". A bare digit is a panel default nobody has filled in, never a
// material, and leaving it out meant a phantom hopper asking to be mapped.
const UNUSED_SLOT_NAMES = new Set(["", "0", "1", "-", "--", "NA", "NONE", "NIL", "AGG6", "XXX", "DUMMY", "SPARE"]);

/**
 * Is this hopper actually in use?
 *
 * Deliberately requires BOTH a real name and a real weight. A named hopper
 * that weighed nothing on this mix contributes no row (a recipe that uses no
 * silica should not produce twenty silica rows a day reading zero), and a
 * hopper that weighed something but is named "0" is a configuration problem
 * worth seeing rather than data worth trusting — so that one DOES come through
 * and lands in the review queue.
 */
export function slotInUse(slotName, actualKg) {
  // The name never actually gated this — a hopper that weighed something did
  // so whatever the panel calls it, and throwing the row away would lose real
  // consumption. The name decides whether it needs MAPPING, not whether it
  // happened. Kept explicit because the old form read as if it did both.
  return actualKg != null && Number(actualKg) !== 0;
}

export function isPlaceholderName(slotName) {
  return UNUSED_SLOT_NAMES.has(normaliseSlot(slotName));
}

/** Uppercase, keep only A-Z and 0-9 — the same rule the weighbridge uses. */
export function normaliseSlot(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
}
