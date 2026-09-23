#!/usr/bin/env node
// Round 154 — the weighbridge sync agent.
//
// Runs on the weighbridge PC (Windows, the machine SmartWeigh is installed on).
// Reads the SmartWeigh MySQL database, posts finished tickets to the app, and
// does nothing else. It never writes to MySQL, and the account it connects with
// should have SELECT and nothing more — see README.md for the GRANT.
//
// THREE DESIGN DECISIONS WORTH KNOWING BEFORE EDITING THIS:
//
// 1. There is no offline queue, deliberately. The obvious design is to spool
//    unsent tickets to disk when the network is down. But the weighbridge's own
//    MySQL database IS the queue — every ticket is still sitting there, and the
//    agent can always re-read it. A disk spool would be a second copy of the
//    truth that can drift from the first. So on a failed post the agent simply
//    does not advance its cursor and tries the same range again next cycle.
//    The plant can be offline for a week and lose nothing.
//
// 2. Column names are discovered at runtime, not hard-coded. SmartWeigh's own
//    schema mixes conventions wildly (TicketNumber, materialcode, plantName,
//    drivername all in one table), and a V2.0.2 that renames one column would
//    otherwise break the agent silently. So it reads the table's real columns
//    once and matches case-insensitively, and says plainly at startup which
//    ones it could not find.
//
// 3. Only State = 'Second Transaction' rows are sent. A 'First Transaction' row
//    is a lorry that has been weighed once and is still on the weighbridge —
//    it has no net weight yet. Sending it would put a half-finished receipt in
//    front of Store. It gets picked up on a later poll once it completes, which
//    the trailing window below guarantees.
//
// The app side is backend/src/routes/weighbridge.js. The analysis of the live
// data this is written against is in claude/weighbridge-integration-notes.md.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";

const AGENT_VERSION = "1.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = process.env.WB_CONFIG || path.join(__dirname, "config.json");
const STATE_PATH = process.env.WB_STATE || path.join(__dirname, "state.json");

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`No config file at ${CONFIG_PATH}. Copy config.example.json to config.json and fill it in.`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  for (const required of ["mysql", "appUrl", "apiKey"]) {
    if (!cfg[required]) {
      console.error(`config.json is missing "${required}".`);
      process.exit(1);
    }
  }
  return {
    pollSeconds: 60,
    // Only this month, per the plant's decision — the weighbridge holds 2,478
    // tickets back to Dec 2023 and the app does not need that history.
    // Widen this date and restart if the backlog is ever wanted.
    startDate: "2026-09-01",
    // How far back to re-check on every poll. SmartWeigh has no updated_at
    // column, so this window is the only way a ticket edited after the fact
    // reaches the app. The server compares a hash and does nothing for
    // unchanged rows, so a wide window is cheap — it costs one SELECT here and
    // one hash comparison there.
    trailingDays: 30,
    batchSize: 500,
    table: "transaction",
    ...cfg,
  };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { highestSent: 0 };
  }
}

function saveState(state) {
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);   // atomic, so a power cut mid-write cannot corrupt it
}

// ---------------------------------------------------------------------------
// Column discovery
// ---------------------------------------------------------------------------

// What we want -> the names SmartWeigh might call it. First match wins.
// The left-hand names are what the app's API expects.
const WANTED = {
  ticket_number:     ["TicketNumber"],
  raw_vehicle:       ["VehicleNumber"],
  raw_material:      ["Materialname", "MaterialName"],
  raw_material_code: ["materialcode", "MaterialCode"],
  raw_supplier:      ["SupplierName"],
  // NOT a material — this column holds the transaction PURPOSE
  // ('Production Usage', 'Ready Mix Invoicing', 'Internal',
  // 'Scrap / Stock Transfer'). The name is SmartWeigh's, not ours.
  purpose:           ["firstTransactionMaterial"],
  challan_number:    ["Challanno", "ChallanNo"],
  driver_name:       ["drivername", "DriverName"],
  site_name:         ["sitename", "SiteName"],
  shift:             ["Shift"],
  load_status:       ["loadstatus", "LoadStatus"],
  remarks:           ["Remarks"],
  charges:           ["Charges"],
  concrete_grade:    ["concretegrade", "ConcreteGrade"],
  empty_weight_kg:   ["EmptyWeight"],
  loaded_weight_kg:  ["LoadedWeight"],
  net_weight_kg:     ["NetWeight"],
  _date:             ["Date"],
  _time:             ["Time"],
  _emptyDate:        ["EmptyWeightDate"],
  _emptyTime:        ["EmptyWeightTime"],
  _loadDate:         ["LoadWeightDate"],
  _loadTime:         ["LoadWeightTime"],
  _state:            ["State"],
};

// Columns deliberately NOT read, and why — so nobody "helpfully" adds them:
//   moisturepercentage  VARCHAR the operators type into ('N/A', 'NONE', 'N|A').
//                       Never a number in three years of data. Moisture
//                       deduction belongs in the app, against a real figure.
//   actualweight        VARCHAR, same problem, plus values like '35610+91'.
//                       NetWeight is the only weight worth importing.
//   ConcreteVolume      Has been used to store driver names.
//   username/systemid/  Always 'admin' / 'Rajesh-PC' / 'Plant 1'. No
//   plantName           per-operator identity exists to import.

async function discoverColumns(conn, table) {
  const [cols] = await conn.query(`SHOW COLUMNS FROM \`${table}\``);
  const actual = new Map(cols.map((c) => [c.Field.toLowerCase(), c.Field]));
  const found = {};
  const missing = [];
  for (const [ours, candidates] of Object.entries(WANTED)) {
    const hit = candidates.map((c) => actual.get(c.toLowerCase())).find(Boolean);
    if (hit) found[ours] = hit;
    else missing.push(ours);
  }
  return { found, missing };
}

// SmartWeigh splits every timestamp into a DATE column and a separate TIME
// column. Recombine, and reject the '0001-01-01' sentinel it writes where a
// weighing never happened.
function combine(dateVal, timeVal) {
  if (!dateVal) return null;
  const d = dateVal instanceof Date ? dateVal : new Date(String(dateVal));
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2015) return null;
  const day = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
  let time = "00:00:00";
  if (timeVal) {
    const m = String(timeVal).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) time = `${m[1].padStart(2, "0")}:${m[2]}:${m[3] || "00"}`;
  }
  // The weighbridge clock is plant-local, i.e. IST. Say so explicitly rather
  // than letting whatever timezone this PC is set to decide — that is the bug
  // class that has bitten this app repeatedly.
  return `${day}T${time}+05:30`;
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

const str = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

function toTicket(row, col) {
  const g = (k) => (col[k] ? row[col[k]] : null);
  return {
    ticket_number:     num(g("ticket_number")),
    raw_vehicle:       str(g("raw_vehicle")),
    raw_material:      str(g("raw_material")),
    raw_material_code: str(g("raw_material_code")),
    raw_supplier:      str(g("raw_supplier")),
    purpose:           str(g("purpose")),
    challan_number:    str(g("challan_number")),
    driver_name:       str(g("driver_name")),
    site_name:         str(g("site_name")),
    shift:             str(g("shift")),
    load_status:       str(g("load_status")),
    remarks:           str(g("remarks")),
    charges:           str(g("charges")),
    concrete_grade:    str(g("concrete_grade")),
    empty_weight_kg:   num(g("empty_weight_kg")),
    loaded_weight_kg:  num(g("loaded_weight_kg")),
    net_weight_kg:     num(g("net_weight_kg")),
    ticket_date:       combine(g("_date"), g("_time")),
    empty_weighed_at:  combine(g("_emptyDate"), g("_emptyTime")),
    loaded_weighed_at: combine(g("_loadDate"), g("_loadTime")),
  };
}

// ---------------------------------------------------------------------------
// One cycle
// ---------------------------------------------------------------------------

async function post(cfg, tickets) {
  const res = await fetch(new URL("/api/weighbridge/sync", cfg.appUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", "x-weighbridge-key": cfg.apiKey },
    body: JSON.stringify({ agent_version: AGENT_VERSION, tickets }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`app replied ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function cycle(cfg, state) {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: cfg.mysql.host || "localhost",
      port: cfg.mysql.port || 3306,
      user: cfg.mysql.user,
      password: cfg.mysql.password,
      database: cfg.mysql.database || "weighsoftdb",
      // The weighbridge stores dates as DATE/DATETIME in local time. Ask for
      // strings and do the timezone arithmetic ourselves in combine(), rather
      // than letting the driver interpret them in this PC's timezone.
      dateStrings: true,
      connectTimeout: 15_000,
    });

    const { found, missing } = await discoverColumns(conn, cfg.table);
    if (missing.includes("ticket_number")) {
      throw new Error(`Could not find a TicketNumber column on \`${cfg.table}\`. Found: ${Object.values(found).join(", ")}`);
    }
    if (missing.length) log(`note: these columns were not found and will be sent empty: ${missing.join(", ")}`);

    const c = (k) => `\`${found[k]}\``;
    const params = [];

    // Two things are fetched on every poll:
    //   * everything newer than the high-water mark (the new tickets), and
    //   * everything inside the trailing window (to catch an edit to a ticket
    //     already sent — SmartWeigh has no updated_at, so this is the only way).
    // Both are floored at the configured start date so the 2023-2025 backlog is
    // never touched.
    const where = [];
    if (found._state) {
      where.push(`${c("_state")} = 'Second Transaction'`);
    }
    const dateCol = found._loadDate ? c("_loadDate") : (found._date ? c("_date") : null);
    if (dateCol) {
      where.push(`(${dateCol} IS NULL OR ${dateCol} >= ?)`);
      params.push(cfg.startDate);
    }

    const windowStart = new Date(Date.now() - cfg.trailingDays * 86400_000).toISOString().slice(0, 10);
    const fresh = [];
    fresh.push(`${c("ticket_number")} > ?`);
    params.push(state.highestSent || 0);
    if (dateCol) {
      fresh.push(`${dateCol} >= ?`);
      params.push(windowStart > cfg.startDate ? windowStart : cfg.startDate);
    }
    where.push(`(${fresh.join(" OR ")})`);

    const sql =
      `SELECT * FROM \`${cfg.table}\` WHERE ${where.join(" AND ")} ` +
      `ORDER BY ${c("ticket_number")} ASC`;
    const [rows] = await conn.query(sql, params);

    if (!rows.length) {
      // Still check in, so the app can tell "nothing new" from "agent stopped".
      const r = await post(cfg, []);
      log(`nothing to send. app holds up to ticket ${r.highest_ticket ?? "—"}.`);
      return;
    }

    const tickets = rows.map((r) => toTicket(r, found)).filter((t) => Number.isInteger(t.ticket_number));
    log(`${tickets.length} ticket(s) to send (${tickets[0].ticket_number} … ${tickets[tickets.length - 1].ticket_number}).`);

    let highest = state.highestSent || 0;
    for (let i = 0; i < tickets.length; i += cfg.batchSize) {
      const chunk = tickets.slice(i, i + cfg.batchSize);
      const r = await post(cfg, chunk);
      log(`  batch ${i / cfg.batchSize + 1}: +${r.inserted} new, ${r.updated} changed, ${r.unchanged} unchanged` +
          (r.rejected ? `, ${r.rejected} rejected` : ""));
      // Trust the app's own high-water mark over our arithmetic: if its
      // database is ever restored from a backup, this pulls the cursor back
      // automatically and the missing tickets re-send on the next cycle.
      if (Number.isInteger(r.highest_ticket)) highest = r.highest_ticket;
    }
    // Only advance after every batch has landed. A failure part-way through
    // leaves the cursor where it was and the whole range is retried — the
    // upsert on the app side makes that harmless.
    saveState({ ...state, highestSent: highest, lastOkAt: new Date().toISOString() });
    state.highestSent = highest;
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const cfg = loadConfig();
  const state = loadState();
  log(`weighbridge agent ${AGENT_VERSION} starting.`);
  log(`  reading  ${cfg.mysql.database || "weighsoftdb"}.${cfg.table} on ${cfg.mysql.host || "localhost"} as ${cfg.mysql.user}`);
  log(`  sending  ${new URL("/api/weighbridge/sync", cfg.appUrl).toString()}`);
  log(`  tickets from ${cfg.startDate} onwards, re-checking the last ${cfg.trailingDays} days, every ${cfg.pollSeconds}s`);
  log(`  resuming from ticket ${state.highestSent || 0}`);

  if (process.argv.includes("--once")) {
    await cycle(cfg, state);
    return;
  }

  for (;;) {
    try {
      await cycle(cfg, state);
    } catch (err) {
      // Never exit on an error. The weighbridge PC may be offline, MySQL may be
      // mid-restart, the app may be redeploying. All of those resolve on their
      // own, and an agent that quits needs a human to notice and restart it.
      log(`cycle failed (will retry): ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
