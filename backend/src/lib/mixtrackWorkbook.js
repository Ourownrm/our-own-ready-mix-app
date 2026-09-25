// ROUND 160 — the MixTrack ticket workbook's Load sheet, as data.
//
// BPR107a.xlsm is the customer's own ticket. We do not re-implement its
// calculations; we write values into its Load sheet and let Excel do the rest.
// This file is the SINGLE SOURCE OF TRUTH for which cell receives what, so the
// fill step, the checker and the docket schema cannot drift apart.
//
// Three cells changed hands in this round. M32 (Recipe Name), AZ32 (Driver
// Name) and AZ34 (Order No) used to be formulas the sheet worked out for
// itself; the user removed them, and MixTrack now supplies all three.
//
// Removing them fixed a live defect rather than merely moving work:
//
//   AZ32 looked the driver up from the registration against an 11-row table.
//   The plant has run 17 trucks and 28 drivers. Eleven of those trucks were
//   absent from the table, so the lookup returned #N/A; registrations also
//   disagree on spacing ("KL14AF2789" vs "KL14 AF 2789", one with a trailing
//   space), which breaks exact-match lookup even where the truck IS listed.
//
//   M32 looked the recipe name up from the code. Recipe_Code and Recipe_Name
//   are different strings on 210 of 2,495 real loads ("M30 B" vs "M30B"), so
//   the lookup could not have reproduced the name.
//
// Both fields are populated on all 2,495 loads in the live database, so
// writing them straight through is strictly better than deriving them.

// Every cell MixTrack writes. `source` names the MCI370 field the plant agent
// reads it from, or "manual" for the one figure a person types.
//
// Nothing else on the sheet is touched. In particular the sheet's own
// formulas — I40 (which numbered sheet prints) and the per-batch weight
// calculations on sheets 1-10 — are left alone deliberately.
export const LOAD_SHEET_CELLS = [
  { cell: "J17",  field: "batch_date",        label: "Batch Date",          source: "Batch_Dat_Trans.Batch_Date" },
  { cell: "K19",  field: "batch_start_time",  label: "Batch Start Time",    source: "Batch_Dat_Trans.Batch_Start_Time" },
  { cell: "K21",  field: "batch_end_time",    label: "Batch End Time",      source: "Batch_Dat_Trans.Batch_End_Time + QC delay" },
  { cell: "AN26", field: "batch_number",      label: "Batch/Docket Number", source: "Batch_Dat_Trans.Batch_No" },
  { cell: "M26",  field: "customer_name",     label: "Customer",            source: "Batch_Dat_Trans.Order_No (mapped)" },
  { cell: "M29",  field: "recipe_code",       label: "Recipe Code",         source: "Batch_Dat_Trans.Recipe_Code" },
  // ROUND 161 — H45 was `=M29`, and the two cells do DIFFERENT JOBS.
  //
  // M29 is what the ticket PRINTS: every numbered sheet reads it as
  // `J14 = Load!M29`. H45 is the LOOKUP KEY: rows 46-48 do
  // `VLOOKUP(Load!$H$45, 'Mix Design'!B3:W65, n, FALSE)` for all thirteen
  // ingredients, and the numbered sheets read those into B23/B25/B26 before
  // computing the moisture-corrected target.
  //
  // The plant writes `M25A` where the Mix Design sheet has `M 25 A`, so the
  // two cannot be the same string. Splitting them means the ticket shows the
  // plant's own code (the user's rule: everything as MCI370 has it) while the
  // lookup uses the mapped one (the user's rule: row 46 finds the mix). One
  // cell could not satisfy both.
  { cell: "H45",  field: "lookup_code",       label: "Mix lookup key",      source: "mixtrack_recipe_map -> the Mix Design sheet's own code" },
  { cell: "M32",  field: "recipe_name",       label: "Recipe Name",         source: "Batch_Dat_Trans.Recipe_Name" },
  { cell: "M34",  field: "site_name",         label: "Site",                source: "Batch_Dat_Trans.Site (mapped)" },
  { cell: "BG29", field: "truck_number",      label: "Truck Registration",  source: "Batch_Dat_Trans.Truck_No" },
  { cell: "AZ32", field: "driver_name",       label: "Driver Name",         source: "Batch_Dat_Trans.Truck_Driver" },
  { cell: "AZ34", field: "order_no",          label: "Order No",            source: "Batch_Dat_Trans.Order_No" },
  { cell: "AO29", field: "production_qty_m3", label: "Production Qty m3",   source: "manual" },
  { cell: "AO32", field: "mixer_capacity_m3", label: "Mixer Capacity",      source: "Batch_Dat_Trans.Batch_Size" },
  { cell: "AO34", field: "moisture_pct",      label: "Moisture %",          source: "Batch_Transaction.Gate*_Moisture" },
  { cell: "BN26", field: "order_qty_m3",      label: "Order Qty",           source: "Batch_Dat_Trans.Ordered_Qty" },
  { cell: "BE26", field: "with_this_load_m3", label: "With This Load",      source: "Batch_Dat_Trans.WithThisLoad" },
];

// ROUND 161 — the Mix Design sheet, written before the Load sheet.
//
// The user's rule is that row 46 looks the mix up from the Mix Design sheet
// and passes it to sheets 1-10. That stays exactly as it is. What changes is
// where the SHEET's own numbers come from: QC maintains them in MixTrack, and
// the agent writes them into a working copy of the workbook immediately before
// filling Load. QC gets an edit history and the file is never locked open.
//
// The column letters are the EXACT INVERSE of the Round 152 uploader, and are
// mapped by COLUMN LETTER rather than header text on purpose. That round found
// the sheet's `R3` header reads "20MM%" while the column actually holds the
// first M Sand's MOISTURE — confirmed against the Load sheet's own VLOOKUP
// indexes (W47 -> col 13 = N, W48 -> col 17 = R). Header-driven mapping would
// load moisture into the wrong ingredient in silence.
export const MIX_DESIGN_SHEET_COLUMNS = {
  code: "B",  name: "X",
  msand_kgm3: "C", msand2_kgm3: "D", agg_12mm_kgm3: "E", agg_20mm_kgm3: "F",
  cem1_kgm3: "H", cem2_kgm3: "I", cem3_kgm3: "J",
  admix1_kgm3: "K", admix2_kgm3: "L", water_kgm3: "M",
  absorb_msand_pct: "N", absorb_msand2_pct: "O", absorb_12mm_pct: "P", absorb_20mm_pct: "Q",
  moisture_msand_pct: "R", moisture_msand2_pct: "S", moisture_12mm_pct: "T", moisture_20mm_pct: "U",
  water_var_min_pct: "V", water_var_max_pct: "W",
};

// Recipes start at row 4 (row 3 is the header the Load sheet's own
// `VLOOKUP($R$45, ...)` reads for the material names) and the lookup range
// stops at row 65, so 62 recipes fit. Column G is a gate this plant does not
// use and is left alone.
export const MIX_DESIGN_FIRST_ROW = 4;
export const MIX_DESIGN_LAST_ROW = 65;

// Where PrintOrderandAsPDF files the PDF. The workbook shipped with
// `G:\BPR105\BATCH REPORT 2026` here — a MAPPED DRIVE, which is per-user and
// invisible to the SYSTEM account a scheduled agent runs under, and with the
// year baked into the folder name so it would need editing every January.
// The agent writes this cell itself from a local path on the plant PC.
export const SAVE_FOLDER_CELL = { sheet: "Mix Design", cell: "AF4" };

// Cells that carry a formula we must NOT overwrite. Writing a value into one
// of these destroys the formula permanently — the workbook has no undo once
// the fill step has saved it.
//
// H45 is NO LONGER protected: it held `=M29` and is now written deliberately,
// for the reason given above.
export const PROTECTED_CELLS = ["I40"];

// The Batch Time block the user deleted in this round: W8:AA10 on each
// numbered sheet, and the W12 quantity check that sat beside it. Listed so the
// checker can prove no code has quietly started referencing them again. The
// batch's own timing is now K19/K21 on the Load sheet, straight from MCI370,
// which is why the block became obsolete.
export const REMOVED_CELLS = ["W8", "X8", "Y8", "Z8", "AA8", "W9", "X9", "Y9", "Z9", "AA9", "Y10", "Z10", "AA10", "W12"];

// Which pre-built sheet prints.
//
// This MUST match the workbook's own I40 formula, or the fill step and the
// sheet Excel actually prints disagree:
//
//   =IF(AO29<=1,1,IF(AO29<=2,2,...,10))
//
// which is ceil(production quantity), clamped 1..10, and depends on NOTHING
// ELSE. Round 159 and earlier divided by the mixer capacity, which happens to
// agree only because this plant's capacity is exactly 1 m3 — at 0.5 m3 a 4 m3
// load would have filled sheet 8 while Excel printed sheet 4.
export function sheetNumberForLoad(productionQtyM3) {
  const qty = Number(productionQtyM3) || 0;
  if (qty <= 0) return 1;
  return Math.min(10, Math.max(1, Math.ceil(qty)));
}

// Batch End Time = the plant's own end time plus the QC allowance for this
// customer or site. The allowance exists because plant QC procedure runs on
// past the mixer finishing, and the ticket must show when the load was
// actually released rather than when the last batch dropped.
//
// Returns a Date, or null when the plant gave us no end time — in which case
// K21 is left empty rather than guessed at.
export function batchEndWithDelay(plantEndedAt, delayMinutes) {
  if (!plantEndedAt) return null;
  const base = plantEndedAt instanceof Date ? plantEndedAt : new Date(plantEndedAt);
  if (Number.isNaN(base.getTime())) return null;
  const mins = Number(delayMinutes);
  if (!Number.isFinite(mins) || mins <= 0) return base;
  return new Date(base.getTime() + mins * 60000);
}

// Builds the cell -> value map for one docket. Every cell in LOAD_SHEET_CELLS
// appears in the result, empty ones included: the workbook is reused sheet by
// sheet, so a field left out would silently print the PREVIOUS load's value.
// An explicit empty string is what clears it.
export function buildLoadSheetValues(docket) {
  const out = {};
  for (const { cell, field } of LOAD_SHEET_CELLS) {
    const v = docket[field];
    out[cell] = v === undefined || v === null ? "" : v;
  }
  return out;
}

// ROUND 161 — the Mix Design sheet's rows, as the agent will write them.
//
// Returns [{ row, cells: { "B": code, "C": 777.2, ... } }], one entry per
// recipe, in code order so the sheet stays readable to a human who opens it.
//
// Recipes beyond MIX_DESIGN_LAST_ROW are REFUSED rather than silently dropped:
// the Load sheet's VLOOKUP range ends at row 65, so a 63rd recipe written at
// row 66 would exist in the file and be invisible to every lookup — the worst
// kind of failure, because the ticket would print blanks for a recipe that is
// plainly there on the sheet.
export function buildMixDesignRows(designs) {
  const sorted = [...designs].sort((a, b) =>
    String(a.code).localeCompare(String(b.code), undefined, { numeric: true })
  );
  const capacity = MIX_DESIGN_LAST_ROW - MIX_DESIGN_FIRST_ROW + 1;
  if (sorted.length > capacity) {
    throw new Error(
      `${sorted.length} recipes will not fit the Mix Design sheet, which the Load sheet's ` +
      `VLOOKUP range limits to ${capacity} (rows ${MIX_DESIGN_FIRST_ROW}-${MIX_DESIGN_LAST_ROW}). ` +
      `Deactivate recipes that are no longer batched, or the range has to be widened in the workbook first.`
    );
  }
  return sorted.map((d, i) => {
    const cells = {};
    for (const [field, col] of Object.entries(MIX_DESIGN_SHEET_COLUMNS)) {
      const v = d[field];
      cells[col] = v === undefined || v === null ? "" : v;
    }
    return { row: MIX_DESIGN_FIRST_ROW + i, cells };
  });
}

// How many blank rows the agent must clear below the written ones, so a
// shortened recipe list cannot leave an old recipe behind for the lookup to
// find. Cheap insurance: the alternative is a deleted recipe still printing.
export function mixDesignRowsToClear(count) {
  const first = MIX_DESIGN_FIRST_ROW + count;
  return first > MIX_DESIGN_LAST_ROW ? [] :
    Array.from({ length: MIX_DESIGN_LAST_ROW - first + 1 }, (_, i) => first + i);
}
