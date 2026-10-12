// Round 205 — one-time import of the quotations issued from the owner's Excel
// (sheet "Quotations List"). The file is read here; every row is shown with
// its matched customer, site and grades, and the Administrator sets what each
// one is (accepted → price list, sent → follow-ups, lost → history) before
// anything is saved.
import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { apiRequest } from "../../lib/api.js";
import { todayStr } from "../../lib/istDate.js";
import { inr, fmtDate } from "../../lib/quotationTerms.js";
import { readQuotationSheet, matchRows, toPayload } from "../../lib/quotationImport.js";
import { TH, TD, row, Banner, Empty } from "./ui.jsx";

const TYPE_LABEL = { cash: "Cash", pay_after_delivery: "Pay after delivery", credit: "Credit", credit_qty: "Credit & qty", price_only: "Price only" };
const sel = { padding: "5px 6px", fontSize: 12.5, border: "1px solid var(--border-strong)", borderRadius: 6, maxWidth: 230, width: "100%" };

export default function QuotationImport({ onDone }) {
  const [ref, setRef] = useState(null);
  const [rows, setRows] = useState(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    Promise.all([
      apiRequest("/master/customers"), apiRequest("/master/sites"), apiRequest("/master/mix-grades"),
      apiRequest("/quotation-import/existing"),
      apiRequest("/accounts/rate-migration").catch(() => ({ rates: [] })),
    ]).then(([customers, sites, grades, existing, mig]) => {
      // Where the old rate file already prices the customer — a hint that
      // the quotation was accepted.
      const priced = new Set(), pricedSite = new Set();
      for (const r of mig.rates || []) { priced.add(String(r.customer_id)); if (r.site_id) pricedSite.add(String(r.site_id)); }
      const inApp = new Map((existing.in_app || []).map((q) => [q.quote_no, q]));
      setRef({ customers, sites, grades, existing: existing.quote_nos, next_serial: existing.next_serial, priced, pricedSite, inApp });
    }).catch((e) => setError(e.message));
  }, []);

  async function pick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(""); setRows(null); setResult(null); setFileName(file.name);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const got = readQuotationSheet(wb, XLSX);
      if (!got || !got.rows.length) { setError('No sheet with a "Quotation Number" column was found in this file.'); return; }
      const matched = matchRows(got.rows, { ...ref, today: todayStr() }).map((r) => {
        const supplying = r.site_choice !== "new" ? ref.pricedSite.has(r.site_choice) : r.customer_choice !== "new" && ref.priced.has(r.customer_choice);
        return { ...r, supplying };
      });
      setRows(matched);
    } catch (err) { setError(`Could not read the file: ${err.message}`); }
  }

  const set = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const customersById = useMemo(() => new Map((ref?.customers || []).map((c) => [String(c.id), c])), [ref]);

  const shown = useMemo(() => (rows || []).filter((r) => {
    if (filter === "check") return r.issues.length && !r.already;
    if (filter === "accepted") return r.status === "accepted";
    if (filter === "sent") return r.status === "sent";
    if (filter === "lost") return r.status === "lost";
    if (filter === "already") return r.already;
    return true;
  }), [rows, filter]);

  async function doImport() {
    const todo = rows.filter((r) => r.include && !r.already);
    if (!todo.length) { setError("Nothing selected to import."); return; }
    if (!window.confirm(`Import ${todo.length} quotations? ${todo.filter((r) => r.status === "accepted").length} accepted ones become their site's price list.`)) return;
    setBusy(true); setError("");
    try { setResult(await apiRequest("/quotation-import", { method: "POST", body: { quotations: todo.map(toPayload) } })); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }

  if (!ref) return <><Banner>{error}</Banner><Empty>Loading…</Empty></>;
  const counts = rows ? {
    all: rows.length, check: rows.filter((r) => r.issues.length && !r.already).length, accepted: rows.filter((r) => r.status === "accepted").length,
    sent: rows.filter((r) => r.status === "sent").length, lost: rows.filter((r) => r.status === "lost").length, already: rows.filter((r) => r.already).length,
  } : null;
  const maxSerial = rows ? Math.max(0, ...rows.map((r) => Number((r.quote_no.match(/-(\d{4})R?\d*$/) || [])[1]) || 0)) : 0;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <button type="button" onClick={onDone}>← Back</button>
        <h2 style={{ margin: 0, fontSize: 18 }}>Import quotations from the Excel</h2>
      </div>
      <Banner>{error}</Banner>
      {result ? (
        <div className="card" style={{ fontSize: 13.5, display: "flex", flexDirection: "column", gap: 6 }}>
          <b style={{ fontSize: 15 }}>Imported {result.imported} quotations</b>
          <span>{result.accepted} accepted — now their sites' price lists · {result.customers_created} new customers · {result.sites_created} new sites</span>
          {result.held_invoiced > 0 && <span>{result.held_invoiced} delivery invoice(s) that were held for want of a price were raised. Invoices that already existed were not changed.</span>}
          {result.skipped.length > 0 && <span>Already in the app, skipped: {result.skipped.join(", ")}</span>}
          {result.failed.length > 0 && <span style={{ color: "var(--alert-red)" }}>Not imported: {result.failed.map((f) => `${f.quote_no} (${f.error})`).join("; ")}</span>}
          <span>Next new quotation number: <b>{String(result.next_serial).padStart(4, "0")}</b></span>
          <div><button type="button" className="btn-primary" onClick={onDone}>Open the register</button></div>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 12, fontSize: 13 }}>
            <label className="field-input" style={{ display: "block" }}>
              <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>The quotations Excel (sheet "Quotations List")</span>
              <input type="file" accept=".xlsx,.xls,.xlsm" onChange={pick} />
            </label>
            <div style={{ color: "var(--slate)", marginTop: 6 }}>
              Nothing is saved until you press Import. A number already in the app is skipped. Accepted quotations become the site's price list from the date shown;
              existing invoices are not changed. Afterwards the next number continues after the highest one in the file.
            </div>
          </div>
          {rows && (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                {[["all", "All"], ["check", "To check"], ["accepted", "Accepted"], ["sent", "Sent"], ["lost", "History"], ["already", "Already in"]].map(([k, l]) => (
                  <button key={k} type="button" className={`btn-tab ${filter === k ? "active" : ""}`} style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setFilter(k)}>{l} ({counts[k]})</button>
                ))}
                <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--slate)" }}>{fileName} · highest number {String(maxSerial).padStart(4, "0")} → next {String(Math.max(maxSerial + 1, ref.next_serial || 0)).padStart(4, "0")}</span>
              </div>
              <div className="card" style={{ marginBottom: 10, fontSize: 12.5, color: "var(--slate)" }}>
                Older than 60 days start as <b>History</b>, newer ones as <b>Sent</b> (follow-ups). Mark as <b>Accepted</b> the quotations the customer agreed to — the ones you are supplying on. "Supplying now" marks a customer or site the old rate file already prices.
                <button type="button" style={{ marginLeft: 8, fontSize: 12, padding: "3px 10px" }}
                  onClick={() => setRows((rs) => rs.map((r) => (r.supplying && !r.already ? { ...r, status: "accepted" } : r)))}>Mark all "supplying now" as accepted</button>
              </div>
              {!shown.length ? <Empty>Nothing here.</Empty> : (
                <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1180 }}>
                    <thead><tr style={{ background: "var(--concrete)" }}>
                      <th style={TH} /><th style={TH}>Number · date</th><th style={TH}>Customer</th><th style={TH}>Project → site</th>
                      <th style={TH}>Grades (incl. GST)</th><th style={TH}>Agreement</th><th style={TH}>Comes in as</th><th style={TH}>Check</th>
                    </tr></thead>
                    <tbody>
                      {shown.map((r) => {
                        const custSites = r.customer_choice === "new" ? [] : ref.sites.filter((s) => String(s.customer_id) === r.customer_choice);
                        const near = r.near_customers.map((id) => customersById.get(String(id))).filter(Boolean);
                        return (
                          <tr key={r.key} style={{ ...row, opacity: r.already ? 0.5 : 1 }}>
                            <td style={TD}><input type="checkbox" checked={r.include && !r.already} disabled={r.already} onChange={(e) => set(r.key, { include: e.target.checked })} style={{ width: "auto" }} aria-label="Include" /></td>
                            <td style={{ ...TD, whiteSpace: "nowrap" }}><b>{r.quote_no}</b><div style={{ fontSize: 11.5, color: "var(--slate)" }}>{fmtDate(r.quote_date)}{r.attention ? ` · Attn ${r.attention}` : ""}</div></td>
                            <td style={TD}>
                              <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 3 }}>{r.customer}</div>
                              <select style={sel} value={r.customer_choice} disabled={r.already} onChange={(e) => set(r.key, { customer_choice: e.target.value, site_choice: "new" })} aria-label="Customer">
                                <option value="new">New customer: {r.customer.slice(0, 40)}</option>
                                {near.map((c) => <option key={`n${c.id}`} value={String(c.id)}>≈ {c.name}</option>)}
                                {ref.customers.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                              </select>
                            </td>
                            <td style={TD}>
                              <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 3 }}>{r.project}</div>
                              <select style={sel} value={r.site_choice} disabled={r.already} onChange={(e) => set(r.key, { site_choice: e.target.value })} aria-label="Site">
                                <option value="new">New site: {r.project.slice(0, 40)}</option>
                                {custSites.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
                              </select>
                            </td>
                            <td style={{ ...TD, fontSize: 12 }}>
                              {r.lines.map((l, i) => (
                                <div key={i} style={{ color: l.bad ? "var(--alert-red)" : undefined }}>
                                  <b>{l.grade_name || l.item_label || l.grade}</b> {l.specification && <span style={{ color: "var(--slate)" }}>{l.specification}</span>} · ₹{inr(l.rate_total)}{l.qty_m3 ? ` · ${l.qty_m3} m³` : ""}
                                </div>
                              ))}
                              {(r.notes || []).map((n, i) => <div key={`note${i}`} style={{ color: "var(--slate)", fontStyle: "italic" }}>Note: {n}</div>)}
                            </td>
                            <td style={TD}>
                              <select style={sel} value={r.agreement_type} disabled={r.already} onChange={(e) => set(r.key, { agreement_type: e.target.value })} aria-label="Agreement">
                                {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                              </select>
                              {(r.credit_days || r.credit_limit) && <div style={{ fontSize: 11, color: "var(--slate)" }}>{r.credit_days ? `${r.credit_days} d` : ""}{r.credit_limit ? ` · ₹${inr(r.credit_limit)}` : ""}</div>}
                            </td>
                            <td style={TD}>
                              <select style={sel} value={r.status} disabled={r.already} onChange={(e) => set(r.key, { status: e.target.value })} aria-label="Status">
                                <option value="accepted">Accepted</option><option value="sent">Sent (follow up)</option><option value="lost">History</option>
                              </select>
                              {r.status === "accepted" && (
                                <label style={{ display: "block", fontSize: 11, color: "var(--slate)", marginTop: 3 }}>price list from
                                  <input type="date" value={r.rates_from || ""} onChange={(e) => set(r.key, { rates_from: e.target.value })} style={{ ...sel, marginTop: 2 }} />
                                </label>
                              )}
                            </td>
                            <td style={{ ...TD, fontSize: 11.5 }}>
                              {r.already && <span className="badge badge-neutral">Already in</span>}
                              {r.already && ref.inApp.get(r.quote_no) && (
                                <div style={{ color: "var(--alert-red)" }}>
                                  This number was given to a quotation made in the app ({ref.inApp.get(r.quote_no).customer_name}, {fmtDate(ref.inApp.get(r.quote_no).quote_date)}) — a different quotation. Re-issue one of the two under a new number.
                                </div>
                              )}
                              {r.supplying && !r.already && <div><span className="badge badge-info">Supplying now</span></div>}
                              {r.two_prices && <div style={{ color: "var(--info)" }}>Two prices for a grade — kept as price options</div>}
                              {r.issues.map((x, i) => <div key={i} style={{ color: "var(--amber)" }}>{x}</div>)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <button type="button" onClick={onDone}>Cancel</button>
                <button type="button" className="btn-primary" disabled={busy} onClick={doImport}>
                  {busy ? "Importing…" : `Import ${rows.filter((r) => r.include && !r.already).length} quotations`}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
