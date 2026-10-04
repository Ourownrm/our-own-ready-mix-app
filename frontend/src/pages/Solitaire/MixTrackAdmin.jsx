// ROUND 188 (v10.17) — the Admin & QC screens of MixTrack.
//
// Saved dockets    — every docket prints as it is saved; this is where a
//                    mistake is corrected (Edit, with a reason, logged), a
//                    ticket is reprinted, or a failed print is retried.
// Plant batch data — Store 1: the plant's own record, copied from MCI370 by
//                    the plant agent. One row per load; open it for every
//                    batch's actual / target kg and the moisture. Read-only.
// Printed tickets  — Store 2: what the ticket actually printed, read back from
//                    the workbook after each print. Same layout as Store 1 so
//                    the two can be compared row for row. Read-only.
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

/* ------------------------------------------------- Store 1: plant batch data */

export function PlantBatchData() {
  const r = useRange();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState({}); // key -> detail | "loading"

  const load = () => solitaireApi.plantBatches(r.from, r.to, r.q).then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(l) {
    const k = `${l.plant_no}|${l.batch_year}|${l.batch_no}`;
    if (open[k]) { const n = { ...open }; delete n[k]; setOpen(n); return; }
    setOpen((o) => ({ ...o, [k]: "loading" }));
    solitaireApi.plantBatchDetail(l)
      .then((d) => setOpen((o) => ({ ...o, [k]: d })))
      .catch((e) => setOpen((o) => ({ ...o, [k]: { error: e.message } })));
  }

  const t = data?.totals;
  return (
    <div>
      <div className="mt-sub" style={{ marginBottom: 8 }}>
        Store 1 — a copy of MCI370's batch records, sent by the plant agent as each batch completes. Read-only.
      </div>
      <RangeFilters r={r} onGo={load} placeholder="batch no, customer, truck, recipe"
                    summary={t ? <b>{t.loads} loads · {n2(t.m3, 1)} m³ · {t.batches} batches</b> : null} />
      {err && <div className="sol-error-msg">{err}</div>}
      <table className="mt-table">
        <thead>
          <tr>
            <th /><th>Batch no</th><th>Start → end</th><th>Customer / site</th><th>Recipe</th><th>Truck</th><th>Driver</th>
            <th className="num">Made m³</th><th className="num">Batches</th><th>Docket</th>
          </tr>
        </thead>
        <tbody>
          {(data?.loads || []).map((l) => {
            const k = `${l.plant_no}|${l.batch_year}|${l.batch_no}`;
            const det = open[k];
            return (
              <Fragment key={k}>
                <tr className={det ? "mt-detail" : ""} style={{ cursor: "pointer" }} onClick={() => toggle(l)}>
                  <td style={{ fontWeight: 700 }}>{det ? "▾" : "▸"}</td>
                  <td className="mono"><b>{l.batch_no}</b></td>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>{l.start_time || "—"} → {l.end_time || "—"}<div className="mt-sub">{l.batch_date}</div></td>
                  <td>{l.customer || "—"}<div className="mt-sub">{l.site || ""}</div></td>
                  <td className="mono">{l.recipe_code || "—"}</td>
                  <td className="mono">{l.truck_no || "—"}</td>
                  <td>{l.driver || "—"}</td>
                  <td className="num">{n2(l.made_m3)}</td>
                  <td className="num">{l.batches}</td>
                  <td><span className={`mt-badge ${l.docket_status}`}>{STATUS_LABEL[l.docket_status] || l.docket_status}</span></td>
                </tr>
                {det && (
                  <tr className="mt-detail">
                    <td />
                    <td colSpan={9}>
                      {det === "loading" ? "Loading…" : det.error ? <span className="sol-error-msg">{det.error}</span> : (
                        <>
                          <div style={{ overflowX: "auto" }}>
                            <table className="mt-grid">
                              <thead>
                                <tr>
                                  <th style={{ textAlign: "left" }}>Batch</th>
                                  {det.columns.map((c) => <th key={c.slot}>{c.name}</th>)}
                                  <th>Sand moist.</th><th>m³</th><th>Time</th>
                                </tr>
                              </thead>
                              <tbody>
                                {det.batches.map((b) => (
                                  <tr key={b.batch}>
                                    <td style={{ textAlign: "left" }}>{b.batch}</td>
                                    {b.values.map((v) => <td key={v.slot}>{kg(v.actual_kg)} / {kg(v.target_kg)}</td>)}
                                    <td>{b.sand_moisture_pct == null ? "—" : `${n2(b.sand_moisture_pct, 1)} %`}</td>
                                    <td>{n2(b.m3)}</td>
                                    <td>{b.time || "—"}</td>
                                  </tr>
                                ))}
                                <tr className="total">
                                  <td style={{ textAlign: "left" }}>Total</td>
                                  {det.totals.map((v) => <td key={v.slot}>{kg(v.actual_kg)} / {kg(v.target_kg)}</td>)}
                                  <td /><td>{n2(det.batches.reduce((s, b) => s + (b.m3 || 0), 0))}</td><td />
                                </tr>
                              </tbody>
                            </table>
                          </div>
                          <div className="mt-sub" style={{ paddingTop: 4 }}>Figures are <b>actual / target kg</b>, exactly as the load cells weighed them.</div>
                        </>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {data && !data.loads.length && <tr><td colSpan={10} style={{ textAlign: "center", color: "#777", padding: 18 }}>No plant batches in this period.</td></tr>}
          {!data && !err && <tr><td colSpan={10} style={{ textAlign: "center", color: "#777", padding: 18 }}>Loading…</td></tr>}
        </tbody>
      </table>
      <div className="mt-sub" style={{ marginTop: 8 }}>A report-format view of a load is held for a later version.</div>
    </div>
  );
}

/* ------------------------------------------------ Store 2: printed tickets */

export function PrintedTickets() {
  const r = useRange();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState({});

  const load = () => solitaireApi.printedTickets(r.from, r.to, r.q).then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(t) {
    if (open[t.id]) { const n = { ...open }; delete n[t.id]; setOpen(n); return; }
    setOpen((o) => ({ ...o, [t.id]: "loading" }));
    solitaireApi.printedTicket(t.id)
      .then((d) => setOpen((o) => ({ ...o, [t.id]: d })))
      .catch((e) => setOpen((o) => ({ ...o, [t.id]: { error: e.message } })));
  }

  const tot = data?.totals;
  return (
    <div>
      <div className="mt-sub" style={{ marginBottom: 8 }}>
        Store 2 — what the ticket printed, read back from the workbook straight after each print. Read-only.
      </div>
      <RangeFilters r={r} onGo={load} placeholder="docket no, customer, truck, recipe"
                    summary={tot ? <b>{tot.tickets} tickets · {n2(tot.m3, 1)} m³ · {tot.batches} batches</b> : null} />
      {err && <div className="sol-error-msg">{err}</div>}
      <table className="mt-table">
        <thead>
          <tr>
            <th /><th>Docket</th><th>Printed</th><th>Customer / site</th><th>Recipe</th><th>Truck</th><th>Driver</th>
            <th className="num">Prod. m³</th><th className="num">Sheet</th><th>PDF</th>
          </tr>
        </thead>
        <tbody>
          {(data?.tickets || []).map((t) => {
            const det = open[t.id];
            return (
              <Fragment key={t.id}>
                <tr className={det ? "mt-detail" : ""} style={{ cursor: "pointer" }} onClick={() => toggle(t)}>
                  <td style={{ fontWeight: 700 }}>{det ? "▾" : "▸"}</td>
                  <td className="mono"><b>{t.docket_no}</b></td>
                  <td>{t.printed_label}</td>
                  <td>{t.customer || "—"}<div className="mt-sub">{t.site || ""}</div></td>
                  <td className="mono">{t.recipe_code || "—"}</td>
                  <td className="mono">{t.truck || "—"}</td>
                  <td>{t.driver || "—"}</td>
                  <td className="num">{t.production_qty || "—"}</td>
                  <td className="num">{t.sheet_number ?? "—"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {t.has_pdf
                      ? <a href={solitaireApi.docketPdfUrl(t.docket_id)} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>{t.pdf_filename || "PDF"}</a>
                      : <span className="mt-sub">{t.pdf_filename ? "on the plant PC" : "—"}</span>}
                  </td>
                </tr>
                {det && (
                  <tr className="mt-detail">
                    <td />
                    <td colSpan={9}>
                      {det === "loading" ? "Loading…" : det.error ? <span className="sol-error-msg">{det.error}</span> : (
                        <>
                          <div style={{ overflowX: "auto" }}>
                            <table className="mt-grid">
                              <thead>
                                <tr>
                                  <th style={{ textAlign: "left" }}>Batch</th>
                                  {(det.materials_json || []).map((m) => <th key={m.col}>{m.name}</th>)}
                                  <th>Moisture</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(det.batches_json || []).map((b) => {
                                  const sand = b.values?.[0];
                                  return (
                                    <tr key={b.batch}>
                                      <td style={{ textAlign: "left" }}>{b.batch}</td>
                                      {b.values.map((v) => <td key={v.col}>{kg(v.actual_kg)} / {kg(v.set_kg)}</td>)}
                                      <td>{sand?.moisture_pct == null ? "—" : `${n2(sand.moisture_pct)} %`}</td>
                                    </tr>
                                  );
                                })}
                                <tr className="total">
                                  <td style={{ textAlign: "left" }}>Total</td>
                                  {(det.totals_json || []).map((v) => <td key={v.col}>{kg(v.actual_kg)} / {kg(v.set_kg)}</td>)}
                                  <td />
                                </tr>
                              </tbody>
                            </table>
                          </div>
                          <div className="mt-sub" style={{ paddingTop: 4 }}>
                            Figures are <b>printed actual / set weight kg</b>, exactly as on the customer's ticket.
                          </div>
                        </>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {data && !data.tickets.length && (
            <tr><td colSpan={10} style={{ textAlign: "center", color: "#777", padding: 18 }}>
              No printed tickets in this period. (Tickets appear here once the plant PC runs print agent 1.1.0 or later.)
            </td></tr>
          )}
          {!data && !err && <tr><td colSpan={10} style={{ textAlign: "center", color: "#777", padding: 18 }}>Loading…</td></tr>}
        </tbody>
      </table>
      <div className="mt-sub" style={{ marginTop: 8, maxWidth: 1000 }}>
        Same layout as Plant batch data, so the two can be compared row for row. The printed "actual" weights are generated
        inside the ticket workbook from the target, so they will not equal the load-cell figures in Plant batch data.
      </div>
    </div>
  );
}
