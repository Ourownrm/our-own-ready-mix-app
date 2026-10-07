// ROUND 188 (v10.17) — the Admin & QC screens of MixTrack.
//
// Saved dockets    — every docket prints as it is saved; this is where a
//                    mistake is corrected (Edit, with a reason, logged), a
//                    ticket is reprinted, or a failed print is retried.
// Plant batch data — Store 1: the plant's own record, copied from MCI370 by
//                    the plant agent. One row per load; open it for every
//                    batch's actual / target kg and the moisture. Read-only.
// Printed tickets  — Store 2: what the ticket actually printed, read back from
//                    the workbook after each print. Read-only.
// ROUND 191: both stores share one list table and one batch-report table
// (BatchReport), drawn in the printed docket's layout.
//
// The operator never sees these; the server refuses them for the operator role
// as well, so hiding the buttons is presentation, not the guard.

import { Fragment, useEffect, useState } from "react";
import { solitaireApi } from "../../lib/solitaireApi.js";
import { istDay } from "../../lib/istDate.js";

const STATUS_LABEL = { printed: "Printed", printing: "Printing…", failed: "Failed", saved: "Saved", none: "No docket" };

function n2(v, dp = 2) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(dp) : String(v);
}
// A quantity as the operator typed it: 2.5 stays 2.5, 8 stays 8.
function qty(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : String(v);
}
function kg(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return Math.abs(n) < 50 ? n.toFixed(2) : Math.round(n).toLocaleString("en-IN");
}

/* --------------------------------------------------------- saved dockets */

const EDIT_FIELDS = [
  ["customer_text", "Customer"], ["site_text", "Site"], ["truck_text", "Truck registration"], ["driver_name", "Driver"],
  ["order_no", "Order number"], ["with_this_load_m3", "With This Load m³"], ["production_qty_m3", "Production Qty m³"],
];

function docketToDraft(d) {
  return {
    customer_text: d.customer_name || "", site_text: d.site_name || "", truck_text: d.truck_number || "",
    driver_name: d.driver_name || "", order_no: d.order_no || "",
    with_this_load_m3: d.with_this_load_m3 == null ? "" : String(Number(d.with_this_load_m3)),
    production_qty_m3: d.production_qty_m3 == null ? "" : String(Number(d.production_qty_m3)),
    reason: "",
  };
}

export function SavedDockets({ toast }) {
  const [show, setShow] = useState("today");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(null); // docket row
  const [draft, setDraft] = useState(null);
  const [history, setHistory] = useState([]);
  const [err, setErr] = useState("");

  const load = () => solitaireApi.savedDockets(show, q)
    .then((r) => { setRows(r); setLoading(false); })
    .catch((e) => { setErr(e.message); setLoading(false); });

  useEffect(() => { setLoading(true); load(); }, [show]); // eslint-disable-line react-hooks/exhaustive-deps
  // Printing… resolves within seconds, so poll while anything is in flight.
  useEffect(() => {
    if (!rows.some((r) => r.status === "printing")) return undefined;
    const t = setTimeout(load, 5000);
    return () => clearTimeout(t);
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  function startEdit(d) {
    setEditing(d);
    setDraft(docketToDraft(d));
    setErr("");
    solitaireApi.docketEdits(d.id).then(setHistory).catch(() => setHistory([]));
  }

  async function saveEdit(reprint) {
    if (!draft.reason.trim()) { setErr("Say why the docket is being changed."); return; }
    const before = docketToDraft(editing);
    const body = { reason: draft.reason.trim(), reprint };
    for (const [f] of EDIT_FIELDS) if (String(draft[f]).trim() !== String(before[f]).trim()) body[f] = draft[f];
    setBusy(`edit-${editing.id}`);
    setErr("");
    try {
      const r = await solitaireApi.editDocket(editing.id, body);
      toast(`✔ Docket ${editing.batch_number} ${r.changed.length ? "corrected" : "unchanged"}${reprint ? " and sent to print" : ""}.`);
      setEditing(null);
      load();
    } catch (e) { setErr(e.message); } finally { setBusy(null); }
  }

  async function printAgain(d) {
    setBusy(`p-${d.id}`);
    try {
      if (d.status === "failed" && d.job_id) await solitaireApi.retryPrintJob(d.job_id);
      else await solitaireApi.reprintDocket(d.id);
      toast(`✔ Docket ${d.batch_number} sent to the plant printer.`);
      load();
    } catch (e) { toast(`✕ ${e.message}`); } finally { setBusy(null); }
  }

  return (
    <div>
      <div className="mt-filters">
        <label>Show
          <select value={show} onChange={(e) => setShow(e.target.value)}>
            <option value="today">Today</option><option value="failed">Failed</option><option value="all">All</option>
          </select>
        </label>
        <label>Search
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }}
                 placeholder="docket no, customer, truck, driver" style={{ width: 260 }} />
        </label>
        <button type="button" className="mt-btn" onClick={load}>Search</button>
        <span style={{ marginLeft: "auto", color: "#3b3b3b" }}>Every docket prints when it is saved. Reprint here, or retry one that failed.</span>
      </div>
      {err && !editing && <div className="sol-error-msg">{err}</div>}

      {editing && draft && (
        <div className="mt-edit">
          <div style={{ display: "flex", gap: 12, alignItems: "baseline", marginBottom: 8 }}>
            <b>Edit docket {editing.batch_number}</b>
            <span className="mt-sub">Corrects this docket only — the plant's own batch record is not changed. Every change is logged.</span>
          </div>
          <div className="mt-edit-grid">
            {EDIT_FIELDS.map(([f, label]) => (
              <label key={f}>{label}
                <input value={draft[f]} type={f.endsWith("_m3") ? "number" : "text"} step="0.5"
                       style={f.endsWith("_m3") ? { textAlign: "right", fontFamily: "Consolas,monospace" } : undefined}
                       onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} />
              </label>
            ))}
            <label>Reason for change
              <input value={draft.reason} placeholder="e.g. wrong driver entered on panel"
                     onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
            </label>
          </div>
          {err && <div className="sol-error-msg">{err}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
            <button type="button" className="mt-btn" onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="mt-btn" disabled={!!busy} onClick={() => saveEdit(false)}>Save</button>
            <button type="button" className="mt-btn primary" disabled={!!busy} onClick={() => saveEdit(true)}>Save &amp; Reprint</button>
          </div>
          {history.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 11.5 }}>
              <b>Changes so far</b>
              {history.map((h) => (
                <div key={h.id} style={{ borderTop: "1px solid #eee", padding: "4px 0" }}>
                  <span className="mono">{h.changed_at}</span> · {h.changed_by_name || "—"} · <i>{h.reason}</i>
                  {h.reprinted ? " · reprinted" : ""}
                  <div className="mt-sub">
                    {Object.keys(h.after_json || {}).map((k) => `${(EDIT_FIELDS.find((x) => x[0] === k) || [k, k])[1]}: ${h.before_json?.[k] ?? "—"} → ${h.after_json[k] ?? "—"}`).join(" · ")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <table className="mt-table">
        <thead>
          <tr>
            <th>Docket</th><th>Saved</th><th>Customer / site</th><th>Truck · driver</th><th>Recipe</th>
            <th className="num">This load / Prod.</th><th className="num">Sheet</th><th className="num">Order</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td className="mono"><b>{d.batch_number}</b>{d.edits ? <div className="mt-sub">edited ×{d.edits}</div> : null}</td>
              <td>{d.saved_label}</td>
              <td>{d.customer_name || "—"}<div className="mt-sub">{d.site_name || ""}</div></td>
              <td className="mono">{d.truck_number || "—"}<div className="mt-sub" style={{ fontFamily: "inherit" }}>{d.driver_name || ""}</div></td>
              <td className="mono">{d.recipe_code || "—"}</td>
              <td className="num">{qty(d.with_this_load_m3)} / {qty(d.production_qty_m3)}</td>
              <td className="num">{d.sheet_number ?? "—"}</td>
              <td className="num">{qty(d.order_qty_m3)}</td>
              <td>
                <span className={`mt-badge ${d.status}`}>{STATUS_LABEL[d.status] || d.status}</span>
                {d.status === "failed" && d.job_error && <div className="mt-sub" style={{ color: "#7a2b12", maxWidth: 220 }}>{d.job_error}</div>}
              </td>
              <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                {d.has_pdf && <a href={solitaireApi.docketPdfUrl(d.id)} target="_blank" rel="noreferrer" style={{ fontSize: 12, marginRight: 8 }}>PDF</a>}
                <button type="button" className="mt-btn" onClick={() => startEdit(d)}>Edit</button>{" "}
                <button type="button" className={`mt-btn${d.status === "failed" ? " primary" : ""}`}
                        disabled={d.status === "printing" || busy === `p-${d.id}`} onClick={() => printAgain(d)}>
                  {d.status === "failed" ? "Retry print" : "Reprint"}
                </button>
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr><td colSpan={10} style={{ textAlign: "center", color: "#777", padding: 18 }}>
              {loading ? "Loading…" : show === "today" ? "No dockets saved today." : "No dockets found."}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------------- filters shared by the stores */

function useRange() {
  const today = istDay();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [q, setQ] = useState("");
  return { from, setFrom, to, setTo, q, setQ };
}

function RangeFilters({ r, onGo, placeholder, summary }) {
  return (
    <div className="mt-filters">
      <label>From<input type="date" value={r.from} onChange={(e) => r.setFrom(e.target.value)} /></label>
      <label>To<input type="date" value={r.to} onChange={(e) => r.setTo(e.target.value)} /></label>
      <label>Search
        <input value={r.q} onChange={(e) => r.setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onGo(); }}
               placeholder={placeholder} style={{ width: 260 }} />
      </label>
      <button type="button" className="mt-btn" onClick={onGo}>Show</button>
      <span style={{ marginLeft: "auto", fontSize: 13 }}>{summary}</span>
    </div>
  );
}

/* ------------------------------------------------- the batch report table */

// ROUND 191 (v10.20) — ONE table for both stores. The server turns a plant load
// (Store 1) and a printed ticket (Store 2) into the same shape — the printed
// docket's own layout: the ticket's material columns in the ticket's order,
// recipe targets, then per batch moisture / set (corrected target) / actual,
// then totals (lib/mixtrackWorkbook.js batchReportFromPlant/FromTicket). This
// component draws that shape and nothing else, so the two stores cannot drift
// apart.

const HEADER_LEFT = [
  ["batch_date", "Batch Date"], ["start_time", "Batch Start Time"], ["end_time", "Batch End Time"],
  ["docket_no", "Batch / Docket Number"], ["customer", "Customer"], ["site", "Site"],
  ["recipe_code", "Recipe Code"], ["recipe_name", "Recipe Name"], ["truck", "Truck Number"],
  ["driver", "Truck Driver"], ["order_no", "Order Number"],
];
const HEADER_RIGHT = [
  ["ordered_qty", "Ordered Quantity", "m³"], ["production_qty", "Production Quantity", "m³"],
  ["with_this_load", "With This Load", "m³"], ["mixer_capacity", "Mixer Capacity", "m³"],
  ["batch_size", "Batch Size", "m³"], ["batches", "Batches", ""],
];

function hv(v, unit) {
  if (v === null || v === undefined || String(v).trim() === "") return "—";
  if (!unit) return String(v);
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? `${n.toFixed(2)} ${unit}` : `${v} ${unit}`;
}
// Both stores show dates as the docket prints them: 04-Oct-2026.
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function docketDate(v) {
  const t = String(v || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[3]}-${MON[Number(m[2]) - 1]}-${m[1]}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t); // the ticket's own 04-10-2026
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1].padStart(2, "0")}-${MON[Number(m[2]) - 1]}-${m[3]}`;
  return v;
}
function pct(v) { return v === null || v === undefined ? "—" : n2(v); }

export function BatchReport({ report }) {
  if (!report) return null;
  const { header = {}, columns = [], targets = [], batches = [], totals = [] } = report;
  // Group header spans, in column order (Aggregate | Cement | Water | …).
  const groups = [];
  for (const c of columns) {
    const g = groups[groups.length - 1];
    if (g && g.name === c.group) g.span += 1; else groups.push({ name: c.group, span: 1 });
  }
  const showMoist = batches.some((b) => b.cells.some((x) => x.moisture_pct != null || x.absorption_pct != null));
  const rowsPerBatch = showMoist ? 3 : 2;
  return (
    <div className="mt-report">
      <div className="mt-report-head">
        <dl>{HEADER_LEFT.map(([k, label]) => <Fragment key={k}><dt>{label}</dt><dd>{hv(k === "batch_date" ? docketDate(header[k]) : header[k])}</dd></Fragment>)}</dl>
        <dl>{HEADER_RIGHT.map(([k, label, unit]) => <Fragment key={k}><dt>{label}</dt><dd>{hv(header[k], unit)}</dd></Fragment>)}</dl>
      </div>
      {!columns.length ? <div className="mt-sub">No material figures on this load.</div> : (
        <div style={{ overflowX: "auto" }}>
          <table className="mt-grid mt-report-grid">
            <thead>
              <tr className="grp">
                <th colSpan={2} />
                {groups.map((g, i) => <th key={i} colSpan={g.span}>{g.name}</th>)}
              </tr>
              <tr>
                <th colSpan={2} />
                {columns.map((c) => <th key={c.key}>{c.name}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr className="tgt">
                <td className="lbl" colSpan={2}>Recipe Targets kg/m³</td>
                {targets.map((v, i) => <td key={i}>{kg(v)}</td>)}
              </tr>
              {batches.map((b) => (
                <Fragment key={b.batch}>
                  {showMoist && (
                    <tr className="blk">
                      <td className="lbl" rowSpan={rowsPerBatch}>
                        Batch {b.batch}
                        {(b.time || b.m3 != null) && <div className="mt-sub">{[b.time, b.m3 != null ? `${n2(b.m3)} m³` : null].filter(Boolean).join(" · ")}</div>}
                      </td>
                      <td className="lbl2">Abs / Moist %</td>
                      {b.cells.map((x, i) => (
                        <td key={i}>{x.absorption_pct == null && x.moisture_pct == null ? "" : `${pct(x.absorption_pct)} / ${pct(x.moisture_pct)}`}</td>
                      ))}
                    </tr>
                  )}
                  <tr className={showMoist ? "" : "blk"}>
                    {!showMoist && (
                      <td className="lbl" rowSpan={rowsPerBatch}>
                        Batch {b.batch}
                        {(b.time || b.m3 != null) && <div className="mt-sub">{[b.time, b.m3 != null ? `${n2(b.m3)} m³` : null].filter(Boolean).join(" · ")}</div>}
                      </td>
                    )}
                    <td className="lbl2">Set kg</td>
                    {b.cells.map((x, i) => <td key={i}>{kg(x.set_kg)}</td>)}
                  </tr>
                  <tr>
                    <td className="lbl2">Actual kg</td>
                    {b.cells.map((x, i) => <td key={i} className="act">{kg(x.actual_kg)}</td>)}
                  </tr>
                </Fragment>
              ))}
              <tr className="total">
                <td className="lbl" rowSpan={2}>Total</td>
                <td className="lbl2">Set kg</td>
                {totals.map((t, i) => <td key={i}>{kg(t.set_kg)}</td>)}
              </tr>
              <tr className="total2">
                <td className="lbl2">Actual kg</td>
                {totals.map((t, i) => <td key={i} className="act">{kg(t.actual_kg)}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------- the list table shared by both stores */

// Same columns for both stores; only the last column differs (the plant load's
// docket status, the printed ticket's PDF).
function StoreList({ rows, rowKey, cells, lastHead, last, load, empty }) {
  const [open, setOpen] = useState({}); // key -> {report} | "loading" | {error}
  function toggle(row) {
    const k = rowKey(row);
    if (open[k]) { const n = { ...open }; delete n[k]; setOpen(n); return; }
    setOpen((o) => ({ ...o, [k]: "loading" }));
    load(row)
      .then((d) => setOpen((o) => ({ ...o, [k]: d })))
      .catch((e) => setOpen((o) => ({ ...o, [k]: { error: e.message } })));
  }
  return (
    <table className="mt-table">
      <thead>
        <tr>
          <th /><th>Batch / docket no</th><th>Date · start → end</th><th>Customer / site</th><th>Recipe</th><th>Truck</th><th>Driver</th>
          <th className="num">Prod. m³</th><th className="num">Batches</th><th>{lastHead}</th>
        </tr>
      </thead>
      <tbody>
        {(rows || []).map((row) => {
          const k = rowKey(row);
          const det = open[k];
          const c = cells(row);
          return (
            <Fragment key={k}>
              <tr className={det ? "mt-detail" : ""} style={{ cursor: "pointer" }} onClick={() => toggle(row)}>
                <td style={{ fontWeight: 700 }}>{det ? "▾" : "▸"}</td>
                <td className="mono"><b>{c.no || "—"}</b></td>
                <td className="mono" style={{ whiteSpace: "nowrap" }}>{c.start || "—"} → {c.end || "—"}<div className="mt-sub">{c.date || ""}</div></td>
                <td>{c.customer || "—"}<div className="mt-sub">{c.site || ""}</div></td>
                <td className="mono">{c.recipe || "—"}</td>
                <td className="mono">{c.truck || "—"}</td>
                <td>{c.driver || "—"}</td>
                <td className="num">{c.m3 == null || c.m3 === "" ? "—" : n2(c.m3)}</td>
                <td className="num">{c.batches ?? "—"}</td>
                <td onClick={(e) => e.stopPropagation()}>{last(row)}</td>
              </tr>
              {det && (
                <tr className="mt-detail">
                  <td />
                  <td colSpan={9}>
                    {det === "loading" ? "Loading…" : det.error ? <span className="sol-error-msg">{det.error}</span> : <BatchReport report={det.report} />}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
        {rows && !rows.length && <tr><td colSpan={10} style={{ textAlign: "center", color: "#777", padding: 18 }}>{empty}</td></tr>}
        {!rows && <tr><td colSpan={10} style={{ textAlign: "center", color: "#777", padding: 18 }}>Loading…</td></tr>}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------- Store 1: plant batch data */

export function PlantBatchData() {
  const r = useRange();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  const load = () => solitaireApi.plantBatches(r.from, r.to, r.q).then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const t = data?.totals;
  return (
    <div>
      <div className="mt-sub" style={{ marginBottom: 8 }}>
        Store 1 — a copy of MCI370's batch records, sent by the plant agent as each batch completes. Open a load for its batch report. Read-only.
      </div>
      <RangeFilters r={r} onGo={load} placeholder="batch no, customer, truck, recipe"
                    summary={t ? <b>{t.loads} loads · {n2(t.m3, 1)} m³ · {t.batches} batches</b> : null} />
      {err && <div className="sol-error-msg">{err}</div>}
      <StoreList
        rows={err ? [] : data?.loads}
        rowKey={(l) => `${l.plant_no}|${l.batch_year}|${l.batch_no}`}
        cells={(l) => ({ no: l.batch_no, date: docketDate(l.batch_date), start: l.start_time, end: l.end_time, customer: l.customer, site: l.site,
                         recipe: l.recipe_code, truck: l.truck_no, driver: l.driver, m3: l.made_m3, batches: l.batches })}
        lastHead="Docket"
        last={(l) => <span className={`mt-badge ${l.docket_status}`}>{STATUS_LABEL[l.docket_status] || l.docket_status}</span>}
        load={(l) => solitaireApi.plantBatchDetail(l)}
        empty="No plant batches in this period."
      />
      <div className="mt-sub" style={{ marginTop: 8, maxWidth: 1000 }}>
        Set kg = the plant's own target for that batch (moisture-corrected by MCI370); actual kg = what the load cells weighed.
        The plant records no water absorption, so that figure shows "—".
      </div>
    </div>
  );
}

/* ------------------------------------------------ Store 2: printed tickets */

export function PrintedTickets() {
  const r = useRange();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  const load = () => solitaireApi.printedTickets(r.from, r.to, r.q).then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tot = data?.totals;
  return (
    <div>
      <div className="mt-sub" style={{ marginBottom: 8 }}>
        Store 2 — what the ticket printed, read back from the workbook straight after each print. Open a ticket for its batch report. Read-only.
      </div>
      <RangeFilters r={r} onGo={load} placeholder="docket no, customer, truck, recipe"
                    summary={tot ? <b>{tot.tickets} tickets · {n2(tot.m3, 1)} m³ · {tot.batches} batches</b> : null} />
      {err && <div className="sol-error-msg">{err}</div>}
      <StoreList
        rows={err ? [] : data?.tickets}
        rowKey={(t) => t.id}
        cells={(t) => ({ no: t.docket_no, date: docketDate(t.batch_date), start: t.start_time, end: t.end_time, customer: t.customer, site: t.site,
                         recipe: t.recipe_code, truck: t.truck, driver: t.driver, m3: t.production_qty, batches: t.batches || t.sheet_number })}
        lastHead="Printed · PDF"
        last={(t) => (
          <>
            <div className="mt-sub">{t.printed_label}</div>
            {t.has_pdf
              ? <a href={solitaireApi.docketPdfUrl(t.docket_id)} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>{t.pdf_filename || "PDF"}</a>
              : <span className="mt-sub">{t.pdf_filename ? "PDF on the plant PC" : "—"}</span>}
          </>
        )}
        load={(t) => solitaireApi.printedTicket(t.id)}
        empty="No printed tickets in this period. (Tickets appear here once the plant PC runs print agent 1.1.0 or later.)"
      />
      <div className="mt-sub" style={{ marginTop: 8, maxWidth: 1000 }}>
        Same table as Plant batch data. The printed "actual" weights are generated inside the ticket workbook from the set weight,
        so they will not equal the load-cell figures in Plant batch data.
      </div>
    </div>
  );
}
