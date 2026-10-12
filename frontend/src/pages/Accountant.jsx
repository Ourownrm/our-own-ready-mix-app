// Round 205 — the Accountant home, reworked (owner, 12 Oct 2026; mockup
// "Accountant Home Rework"). Every rupee figure comes from the server's one
// calculation (backend lib/receivables.js): billed − received, advances
// counted, aged from the delivery date in 0–7 / 8–14 / 15–30 / over 30 days —
// the same numbers as Accounts → Customer ledger, the Outstanding Collection
// report and the Director dashboard.
//
// Gone from here: the old "Record payment" (replaced by Record a receipt,
// which keeps any extra as an advance), the rate recalculation and "Concrete
// grades and rates" (prices now come only from accepted quotations), and the
// pump charge review (now under Accounts → Invoices → Charges left out).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { IfCan, usePermissions } from "../lib/PermissionContext.jsx";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import FollowupsDue from "../lib/FollowupsDue.jsx";
import { todayStr } from "../lib/istDate.js";
import { fmtDate } from "../lib/quotationTerms.js";
import { ReceiptModal } from "./accounts/ReceiptModal.jsx";
import { Modal, money } from "./accounts/ui.jsx";

const AGE = [["d0_7", "0–7 days"], ["d8_14", "8–14 days"], ["d15_30", "15–30 days"], ["d30p", "Over 30 days"]];
const AGE_COLOR = { d0_7: "var(--signal-green)", d8_14: "var(--amber)", d15_30: "var(--rebar)", d30p: "var(--alert-red)" };
const th = { padding: "7px 8px", textAlign: "left", fontSize: 11.5, fontWeight: 600, color: "var(--slate)", whiteSpace: "nowrap" };
const td = { padding: "8px 6px", fontSize: 13, verticalAlign: "top", borderTop: "1px solid var(--border)" };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const num = { ...td, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

export default function Accountant() {
  const { can } = usePermissions();
  const [home, setHome] = useState(null);
  const [allowances, setAllowances] = useState([]);
  const [creditNotes, setCreditNotes] = useState([]);
  const [everyone, setEveryone] = useState(null); // "Show everyone who owes"
  const [receiptFor, setReceiptFor] = useState(null); // {customerId} | {} | null
  const [notice, setNotice] = useState("");
  const [showOpeningBalances, setShowOpeningBalances] = useState(false);
  const [showReprice, setShowReprice] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(null);

  async function load() {
    try {
      const [h, a, cn] = await Promise.all([
        apiRequest("/accountant/home"),
        apiRequest("/accountant/trip-allowances").catch(() => []),
        apiRequest("/accountant/credit-notes").catch(() => []),
      ]);
      setHome(h); setAllowances(a); setCreditNotes(cn);
      if (everyone) setEveryone(await apiRequest("/accountant/customers-outstanding"));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function clearCreditNote(ticketId) {
    setError("");
    try { await apiRequest(`/accountant/credit-notes/${ticketId}/clear`, { method: "POST" }); load(); }
    catch (err) { setError(err.message); }
  }

  async function exportOutstanding(kind) {
    setExporting(kind); setError("");
    try {
      const rows = await apiRequest("/accountant/customers-outstanding");
      if (!rows.length) { setError("Nothing outstanding to export."); return; }
      const total = (k) => rows.reduce((t, r) => t + Number(r[k] || 0), 0);
      const cols = ["Customer", "Billed", "Received", "Balance", "0–7 days", "8–14 days", "15–30 days", "Over 30 days", "Oldest due", "Last receipt"];
      const line = (r) => [r.customer_name, r.total_invoiced, r.total_paid, r.balance, r.d0_7, r.d8_14, r.d15_30, r.d30p,
        r.oldest_unpaid_date ? fmtDate(r.oldest_unpaid_date) : "", r.last_receipt_on ? fmtDate(r.last_receipt_on) : ""];
      const foot = ["Total", total("total_invoiced"), total("total_paid"), total("balance"), total("d0_7"), total("d8_14"), total("d15_30"), total("d30p"), `${rows.length} customers`, ""];
      if (kind === "pdf") {
        const { jsPDF } = await import("jspdf");
        await import("jspdf-autotable");
        const doc = new jsPDF({ orientation: "landscape" });
        const rs = (v) => (typeof v === "number" ? `Rs. ${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : v);
        doc.setFontSize(14); doc.text("Our Own Ready Mix", 14, 14);
        doc.setFontSize(11); doc.text("Customer-wise Outstanding (aged from delivery date)", 14, 21);
        doc.setFontSize(8); doc.text(`As on ${fmtDate(todayStr())}`, 14, 27);
        doc.autoTable({
          startY: 32, head: [cols], body: rows.map((r) => line(r).map((v, i) => (i >= 1 && i <= 7 ? rs(Number(v)) : v))),
          foot: [foot.map((v) => rs(v))], styles: { fontSize: 8 }, headStyles: { fillColor: [199, 91, 18] },
        });
        doc.save(`Customer_Outstanding_${todayStr()}.pdf`);
      } else {
        const XLSX = await import("xlsx");
        const aoa = [cols, ...rows.map((r) => line(r).map((v, i) => (i >= 1 && i <= 7 ? Number(v) : v))), foot];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Outstanding");
        XLSX.writeFile(wb, `Customer_Outstanding_${todayStr()}.xlsx`);
      }
    } catch (err) {
      setError(err.message || "Couldn't export.");
    } finally {
      setExporting(null);
    }
  }

  if (showOpeningBalances) {
    return (
      <>
        <TopBar title="Accountant · Opening balances" />
        <div style={{ maxWidth: 700, margin: "0 auto", padding: "0 16px 32px" }}>
          <button onClick={() => { setShowOpeningBalances(false); load(); }} style={{ marginBottom: 16 }}>← Back</button>
          <OpeningBalancesPanel />
        </div>
      </>
    );
  }

  const k = home?.kpis;
  const n = home?.needs;
  const ageTotal = home ? AGE.reduce((t, [key]) => t + home.ageing[key], 0) : 0;
  const chase = everyone
    ? everyone.map((r) => ({ id: r.customer_id, name: r.customer_name, balance: r.balance, d0_7: r.d0_7, d8_14: r.d8_14, d15_30: r.d15_30, d30p: r.d30p, credit: r.credit, last_receipt_on: r.last_receipt_on, advance: r.advance }))
    : home?.chase || [];
  const canLedger = can("accounts.customer-ledger", "view");
  const hasCredit = chase.some((c) => c.credit);
  const canReceipt = can("accounts.bank-receipts", "create");

  const needs = n ? [
    n.bank_lines > 0 && { key: "bank", tone: "var(--rebar)", title: `${n.bank_lines} bank credit${n.bank_lines > 1 ? "s" : ""} to post`, sub: `${money(n.bank_amount)} · ${n.bank_matched} with a suggested customer`, to: "/accounts?tab=receipts" },
    n.held_loads > 0 && { key: "held", tone: "var(--alert-red)", title: `${n.held_loads} load${n.held_loads > 1 ? "s" : ""} held — no price`, sub: `${Number(n.held_m3).toLocaleString("en-IN")} m³ delivered, not invoiced until the site has an accepted price`, to: "/accounts?tab=invoices&view=held" },
    n.credit_notes > 0 && { key: "cn", tone: "var(--amber)", title: `${n.credit_notes} credit note${n.credit_notes > 1 ? "s" : ""} to issue`, sub: `${money(n.credit_note_amount)} returned at site — see below`, href: "#credit-notes" },
    n.duplicate_opening_balances > 0 && { key: "dob", tone: "var(--alert-red)", title: `${n.duplicate_opening_balances} customer${n.duplicate_opening_balances > 1 ? "s" : ""} with two opening balances`, sub: "Their dues are counted twice — open Opening balances and remove the duplicate", onClick: () => setShowOpeningBalances(true) },
    n.reprice_review > 0 && { key: "rp", tone: "var(--amber)", title: `${n.reprice_review} paid invoice${n.reprice_review > 1 ? "s" : ""} with a new rate`, sub: "The customer accepted a new quotation, but money was already set against these — not changed automatically", onClick: () => setShowReprice(true) },
    (n.charges_left_out > 0 || n.pump_recheck > 0) && { key: "wv", tone: "var(--slate)", title: `${n.charges_left_out + n.pump_recheck} charge${n.charges_left_out + n.pump_recheck > 1 ? "s" : ""} to look at`, sub: `${n.charges_left_out} left out by the Manager · ${n.pump_recheck} pump charge to recheck`, to: "/accounts?tab=invoices&view=waivers" },
  ].filter(Boolean) : [];

  return (
    <>
      <TopBar title="Accountant" />
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {notice && <div className="card" style={{ color: "var(--signal-green)", background: "var(--signal-green-bg)", fontSize: 13, marginBottom: 12 }}>{notice}</div>}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
          {canReceipt && <button type="button" className="btn-primary" onClick={() => setReceiptFor({})}>+ Record a receipt</button>}
          <IfCan perm="accounts.bank-receipts"><Link to="/accounts?tab=receipts" className="btn-link">Bank receipts</Link></IfCan>
          <IfCan perm="accounts.customer-ledger"><Link to="/accounts?tab=ledger" className="btn-link">Customer ledger</Link></IfCan>
          <IfCan perm="accounts.outstanding"><Link to="/outstanding-collection-report" className="btn-link">Outstanding Collection</Link></IfCan>
          <button type="button" className="btn-link" onClick={() => setShowOpeningBalances(true)}>Opening balances</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
          <Kpi label="Outstanding" value={k ? money(k.outstanding) : "–"} sub={k ? `${plural(k.customers_owing, "customer")}${k.advances > 0.5 ? ` · after ${money(k.advances)} advances` : ""}` : ""} />
          <Kpi label="Over 30 days" value={k ? money(k.over_30) : "–"} sub={k ? plural(k.over_30_customers, "customer") : ""} tone={k?.over_30 > 0 ? "var(--alert-red)" : undefined} />
          <Kpi label="Received today" value={k ? money(k.received_today) : "–"} sub={k ? `${k.received_today_count} receipt${k.received_today_count === 1 ? "" : "s"}` : ""} />
          <Kpi label="Received this month" value={k ? money(k.received_month) : "–"} sub={k ? `billed ${money(k.billed_month)}` : ""} />
          <Kpi label="Advances held" value={k ? money(k.advances) : "–"} sub="paid ahead, pays next invoices" />
          <Kpi label="Held — no price" value={n ? `${n.held_loads} loads` : "–"} sub={n ? `${Number(n.held_m3).toLocaleString("en-IN")} m³ not invoiced` : ""} tone={n?.held_loads > 0 ? "var(--alert-red)" : undefined} />
        </div>

        {home && ageTotal > 0 && (
          <div className="card" style={{ marginBottom: 14, padding: "12px 14px" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--slate)", marginBottom: 6 }}>Outstanding by age (from the delivery date)</div>
            <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden", background: "var(--concrete)" }}>
              {AGE.map(([key]) => home.ageing[key] > 0 && <div key={key} title={key} style={{ width: `${(home.ageing[key] / ageTotal) * 100}%`, background: AGE_COLOR[key] }} />)}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", marginTop: 6, fontSize: 12.5 }}>
              {AGE.map(([key, label]) => (
                <span key={key}><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: AGE_COLOR[key], marginRight: 5 }} />{label}: <b>{money(home.ageing[key])}</b></span>
              ))}
            </div>
          </div>
        )}

        <div className="acct-home-grid">
          <div style={{ minWidth: 0 }}>
            <div className="card" style={{ padding: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "12px 14px" }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{everyone ? "Everyone who owes" : "Who to chase"}</div>
                <span style={{ fontSize: 12, color: "var(--slate)" }}>{everyone ? "largest balance first" : "oldest money first"}</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button type="button" style={{ fontSize: 12, padding: "4px 9px" }} onClick={async () => {
                    if (everyone) { setEveryone(null); return; }
                    try { setEveryone(await apiRequest("/accountant/customers-outstanding")); } catch (e) { setError(e.message); }
                  }}>{everyone ? "Top 25" : "Show everyone"}</button>
                  <button type="button" onClick={() => exportOutstanding("pdf")} disabled={!!exporting} style={{ fontSize: 12, padding: "4px 9px" }}>{exporting === "pdf" ? "…" : "PDF"}</button>
                  <button type="button" onClick={() => exportOutstanding("excel")} disabled={!!exporting} style={{ fontSize: 12, padding: "4px 9px" }}>{exporting === "excel" ? "…" : "Excel"}</button>
                </div>
              </div>
              {!home ? <div style={{ padding: 14, fontSize: 13, color: "var(--slate)" }}>Loading…</div>
                : !chase.length ? <div style={{ padding: 14, fontSize: 13, color: "var(--slate)" }}>Nothing outstanding — everyone has paid.</div> : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: hasCredit ? 720 : 640 }}>
                    <thead><tr style={{ background: "var(--concrete)" }}>
                      <th style={th}>Customer</th><th style={{ ...th, textAlign: "right" }}>Balance</th>
                      {AGE.map(([key, label]) => <th key={key} style={{ ...th, textAlign: "right" }}>{label.replace(" days", "")}</th>)}
                      {hasCredit && <th style={th}>Credit</th>}<th style={th}>Last receipt</th><th style={th} />
                    </tr></thead>
                    <tbody>
                      {chase.map((c) => (
                        <tr key={c.id}>
                          <td style={td}><b style={{ fontWeight: 600 }}>{c.name}</b>{c.advance > 0.5 && <div style={{ fontSize: 11.5, color: "var(--signal-green)" }}>advance {money(c.advance)}</div>}</td>
                          <td style={{ ...num, fontWeight: 700 }}>{money(c.balance)}</td>
                          {AGE.map(([key]) => <td key={key} style={{ ...num, color: c[key] > 0.5 ? (key === "d30p" ? "var(--alert-red)" : undefined) : "var(--slate)" }}>{c[key] > 0.5 ? money(c[key]) : "—"}</td>)}
                          {hasCredit && <td style={{ ...td, fontSize: 12 }}>
                            {c.credit ? (c.credit.limit != null ? (c.credit.over_by > 0
                              ? <span style={{ color: "var(--alert-red)", fontWeight: 600 }}>over by {money(c.credit.over_by)}</span>
                              : <>limit {money(c.credit.limit)}</>) : "credit") : <span style={{ color: "var(--slate)" }}>—</span>}
                            {c.credit?.days != null && <div style={{ color: "var(--slate)" }}>{c.credit.days} days</div>}
                          </td>}
                          <td style={{ ...td, fontSize: 12 }}>{c.last_receipt_on ? fmtDate(c.last_receipt_on) : <span style={{ color: "var(--slate)" }}>none</span>}</td>
                          <td style={{ ...td, whiteSpace: "nowrap", textAlign: "right" }}>
                            {canLedger && <Link to={`/accounts?tab=ledger&customer_id=${c.id}`} style={{ fontSize: 12.5, marginRight: 6 }}>Ledger</Link>}
                            {canReceipt && <button type="button" style={{ fontSize: 12, padding: "3px 8px" }} onClick={() => setReceiptFor({ customerId: c.id, name: c.name })}>Receipt</button>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="card">
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Needs you</div>
              {!n ? <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>
                : !needs.length ? <div style={{ fontSize: 13, color: "var(--signal-green)" }}>All clear.</div>
                : needs.map((x) => {
                  const inner = (
                    <div style={{ borderLeft: `3px solid ${x.tone}`, padding: "6px 10px", marginBottom: 8, background: "var(--concrete)", borderRadius: 6 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--charcoal)" }}>{x.title} ›</div>
                      <div style={{ fontSize: 12, color: "var(--slate)" }}>{x.sub}</div>
                    </div>
                  );
                  return x.to ? <Link key={x.key} to={x.to} style={{ textDecoration: "none" }}>{inner}</Link>
                    : x.href ? <a key={x.key} href={x.href} style={{ textDecoration: "none" }}>{inner}</a>
                    : <div key={x.key} role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={x.onClick} onKeyDown={(e) => e.key === "Enter" && x.onClick()}>{inner}</div>;
                })}
            </div>

            <div className="card">
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Received today</div>
              {!home?.received_today.length ? <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing yet today.</div>
                : home.received_today.map((r) => (
                  <div key={`${r.kind}${r.id}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, padding: "4px 0", borderTop: "1px solid var(--border)" }}>
                    <span>{r.customer_name}<span style={{ color: "var(--slate)", fontSize: 11.5 }}> · {String(r.mode).replace("_", " ")}{r.reference_number ? ` · ${r.reference_number}` : ""}</span></span>
                    <b style={{ whiteSpace: "nowrap" }}>{money(r.amount)}</b>
                  </div>
                ))}
            </div>

            <div className="card">
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>Driver trip allowance</div>
                <span style={{ fontSize: 12, color: "var(--slate)" }}>this month</span>
                <b style={{ marginLeft: "auto" }}>{home ? money(home.trip_allowance.total) : ""}</b>
              </div>
              {allowances.slice(0, 8).map((a) => (
                <div key={a.driver_name} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
                  <span>{a.driver_name}</span><span>{money(a.total)}</span>
                </div>
              ))}
              {!allowances.length && <div style={{ fontSize: 13, color: "var(--slate)" }}>No completed trips yet this month.</div>}
              <IfCan perm="reports.trip-allowance"><Link to="/trip-allowance-report" style={{ fontSize: 12.5, display: "inline-block", marginTop: 6 }}>Trip allowance report ›</Link></IfCan>
            </div>

            <div style={{ fontSize: 12.5 }}>
              <IfCan perm="reports.fuel"><Link to="/fuel-report">Fuel and lubricant report ›</Link></IfCan>
            </div>
          </div>
        </div>

        {creditNotes.length > 0 && (
          <div id="credit-notes" className="card" style={{ marginTop: 16, borderLeft: "3px solid var(--amber)", overflowX: "auto" }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Credit notes to issue ({creditNotes.length})</div>
            <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>
              Part of the load was returned at site. The invoice is already reduced to the accepted m³ — if the full invoice reached the customer, issue a credit note for the returned concrete, then mark it issued.
            </div>
            <table style={{ fontSize: 12.5, borderCollapse: "collapse", minWidth: 680, width: "100%" }}>
              <thead><tr><th style={th}>DC No.</th><th style={th}>Customer · site</th><th style={th}>Date</th><th style={th}>Returned</th><th style={{ ...th, textAlign: "right" }}>Credit</th><th style={th}>Reason</th><th style={th} /></tr></thead>
              <tbody>
                {creditNotes.map((c) => (
                  <tr key={c.ticket_id}>
                    <td style={td}>{c.ticket_number}</td>
                    <td style={td}>{c.customer_name}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{c.site_name}</div></td>
                    <td style={td}>{fmtDate(String(c.ticket_date).slice(0, 10))}</td>
                    <td style={td}>{Number(c.rejected_quantity_m3)} m³</td>
                    <td style={{ ...num, fontWeight: 600 }}>{c.credit_note_amount != null ? money(c.credit_note_amount) : "–"}</td>
                    <td style={{ ...td, fontSize: 11.5 }}>{c.rejection_reason || c.credit_note_reason || "—"}</td>
                    <td style={td}><button style={{ fontSize: 11.5, padding: "3px 8px" }} onClick={() => clearCreditNote(c.ticket_id)}>Mark issued</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: 16 }}><FollowupsDue /></div>
      </div>

      {receiptFor && (
        <ReceiptModal customerId={receiptFor.customerId} onClose={() => setReceiptFor(null)}
          onDone={(r) => {
            setReceiptFor(null);
            setNotice(`Receipt saved${receiptFor.name ? ` for ${receiptFor.name}` : ""}${r.applied.length ? ` — set against ${r.applied.map((a) => a.label).join(", ")}` : ""}${r.advance ? `; ${money(r.advance)} kept as advance` : ""}.`);
            load();
          }} />
      )}
      {showReprice && <RepriceReview onClose={() => { setShowReprice(false); load(); }} />}
    </>
  );
}

function Kpi({ label, value, sub, tone }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={tone ? { color: tone } : undefined}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// Paid invoices a newly accepted rate could not change by itself.
function RepriceReview({ onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const load = () => apiRequest("/accountant/reprice-review").then(setRows).catch((e) => { setError(e.message); setRows([]); });
  useEffect(() => { load(); }, []);
  async function seen(id) {
    try { await apiRequest(`/accountant/reprice-review/${id}/seen`, { method: "POST" }); load(); } catch (e) { setError(e.message); }
  }
  return (
    <Modal title="Paid invoices with a new rate" onClose={onClose} width={620}>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 10 }}>
        The customer accepted a new quotation dated before these deliveries, but money was already set against the invoice, so it was not changed. Settle the difference with the customer, then mark it done.
      </div>
      {!rows ? "Loading…" : !rows.length ? <div style={{ fontSize: 13 }}>Nothing left to review.</div> : rows.map((r) => (
        <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", borderTop: "1px solid var(--border)", fontSize: 13 }}>
          <div style={{ flex: 1 }}>{r.message}</div>
          <button type="button" style={{ fontSize: 12, padding: "4px 9px" }} onClick={() => seen(r.id)}>Done</button>
        </div>
      ))}
    </Modal>
  );
}

function OpeningBalancesPanel() {
  const [balances, setBalances] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [showUpload, setShowUpload] = useState(false);

  async function load() {
    try {
      const [b, c] = await Promise.all([apiRequest("/accountant/opening-balances"), apiRequest("/master/customers")]);
      setBalances(b); setCustomers(c);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  // Round 206 — a second opening balance for the same customer.
  async function removeDuplicate(b) {
    if (!window.confirm(`Remove this duplicate opening balance of ₹${Number(b.amount).toLocaleString("en-IN")} for ${b.customer_name}? Any money set against it is kept and set against the customer's other dues (or kept as an advance).`)) return;
    setError(""); setNotice("");
    try {
      const r = await apiRequest(`/accountant/opening-balances/${b.id}/remove-duplicate`, { method: "POST" });
      setNotice(`Duplicate removed${r.payments_moved ? ` — ${r.payments_moved} payment(s) kept as receipts` : ""}${r.applied?.length ? ` and set against ${r.applied.map((a) => a.label).join(", ")}` : ""}.`);
      load();
    } catch (err) { setError(err.message); }
  }

  async function remove(id) {
    if (!window.confirm("Delete this opening balance entry?")) return;
    setError("");
    try {
      await apiRequest(`/accountant/opening-balances/${id}`, { method: "DELETE" });
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--slate)", marginBottom: 16 }}>
        Pre-existing outstanding from before this app was in use — entered once here, it's
        blended into every outstanding/aging figure across the app automatically, and can be
        paid down by Record a receipt like any other due. A customer has <b>one</b> opening balance — a second one for the same
        customer is marked as a duplicate and can be removed.
      </div>
      {balances.some((b) => b.duplicate) && (
        <div style={{ color: "var(--alert-red)", background: "var(--alert-red-bg)", borderRadius: 8, padding: "8px 10px", fontSize: 13, marginBottom: 12 }}>
          {balances.filter((b) => b.duplicate).length} duplicate opening balance(s) — the customer's dues are counted twice until removed.
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={() => { setShowManual(!showManual); setShowUpload(false); }}>{showManual ? "Hide" : "+ Add one manually"}</button>
        <button onClick={() => { setShowUpload(!showUpload); setShowManual(false); }}>{showUpload ? "Hide" : "Upload from Excel"}</button>
      </div>

      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 12 }}>{notice}</div>}

      {showManual && (
        <ManualOpeningBalanceForm
          customers={customers}
          setError={setError}
          onDone={() => { setNotice("Added."); setShowManual(false); load(); }}
        />
      )}
      {showUpload && (
        <ExcelUploadForm
          customers={customers}
          setError={setError}
          onDone={(count, skipped) => { setNotice(`${count} opening balance(s) imported${skipped ? `; ${skipped} skipped — the customer already has one` : ""}.`); setShowUpload(false); load(); }}
        />
      )}

      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>All opening balances on file</div>
        {balances.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>None entered yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 13 }}>
              <thead><tr><th>Customer</th><th>Amount</th><th>Paid</th><th>As of</th><th>Notes</th><th>Entered by</th><th></th></tr></thead>
              <tbody>
                {balances.map((b) => (
                  <tr key={b.id} style={b.duplicate ? { background: "var(--alert-red-bg)" } : undefined}>
                    <td>{b.customer_name}{b.duplicate && <div style={{ fontSize: 11, color: "var(--alert-red)", fontWeight: 600 }}>duplicate</div>}</td>
                    <td>₹{b.amount}</td>
                    <td>₹{b.paid_amount}</td>
                    <td>{new Date(b.as_of_date).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}</td>
                    <td>{b.notes || "–"}</td>
                    <td>{b.entered_by_name || "–"}</td>
                    <td>
                      {b.duplicate ? (
                        <button className="btn-danger" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => removeDuplicate(b)}>Remove duplicate</button>
                      ) : Number(b.paid_amount) === 0 && (
                        <button className="btn-danger" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => remove(b.id)}>Delete</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ManualOpeningBalanceForm({ customers, setError, onDone }) {
  const [customerId, setCustomerId] = useState("");
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await apiRequest("/accountant/opening-balances", {
        method: "POST",
        body: { customer_id: customerId, amount, days_outstanding: days, notes },
      });
      onDone();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, marginBottom: 16 }}>
      <div>
        <div style={{ color: "var(--slate)" }}>Customer</div>
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
          <option value="">Select</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div><div style={{ color: "var(--slate)" }}>Outstanding amount (₹)</div><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
      <div><div style={{ color: "var(--slate)" }}>Days outstanding (as of today)</div><input type="number" value={days} onChange={(e) => setDays(e.target.value)} placeholder="e.g. 45" required /></div>
      <div><div style={{ color: "var(--slate)" }}>Notes (optional)</div><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. carried over from before this app" /></div>
      <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add opening balance"}</button></div>
    </form>
  );
}

// Expects a spreadsheet with columns (any reasonable header name is
// recognized): Customer, Amount, Days Outstanding, and optionally Notes.
function ExcelUploadForm({ customers, setError, onDone }) {
  const [rows, setRows] = useState([]); // parsed + matched preview rows
  const [saving, setSaving] = useState(false);
  const [parsing, setParsing] = useState(false);

  function findHeader(headers, candidates) {
    return headers.find((h) => candidates.includes(h.toLowerCase().trim()));
  }

  function matchCustomer(name) {
    const norm = (s) => s.toLowerCase().trim();
    return customers.find((c) => norm(c.name) === norm(name || ""));
  }

  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setParsing(true); setError("");
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      if (data.length === 0) throw new Error("No rows found in that sheet.");
      const headers = Object.keys(data[0]);
      const customerCol = findHeader(headers, ["customer", "customer name", "name"]);
      const amountCol = findHeader(headers, ["amount", "outstanding amount", "outstanding", "balance"]);
      const daysCol = findHeader(headers, ["days outstanding", "days", "age", "age in days"]);
      const notesCol = findHeader(headers, ["notes", "remarks"]);
      if (!customerCol || !amountCol || !daysCol) {
        throw new Error(`Couldn't find the expected columns. Found: ${headers.join(", ")}. Expecting columns named something like "Customer", "Amount", and "Days Outstanding".`);
      }
      const parsed = data.map((row) => {
        const customerName = String(row[customerCol] || "").trim();
        const match = matchCustomer(customerName);
        return {
          customer_name: customerName,
          customer_id: match?.id || "",
          amount: row[amountCol],
          days_outstanding: row[daysCol],
          notes: notesCol ? row[notesCol] : "",
        };
      }).filter((r) => r.customer_name || r.amount);
      setRows(parsed);
    } catch (err) {
      setError(err.message || "Couldn't read that file.");
    } finally {
      setParsing(false);
      e.target.value = "";
    }
  }

  function updateRowCustomer(index, customerId) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, customer_id: customerId } : r)));
  }

  const unmatchedCount = rows.filter((r) => !r.customer_id).length;
  const readyCount = rows.filter((r) => r.customer_id && r.amount && r.days_outstanding !== "").length;

  async function confirmImport() {
    setSaving(true); setError("");
    try {
      const toImport = rows.filter((r) => r.customer_id && r.amount && r.days_outstanding !== "");
      const result = await apiRequest("/accountant/opening-balances/bulk", { method: "POST", body: { rows: toImport } });
      setRows([]);
      onDone(result.inserted, result.skipped);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Upload from Excel</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>
        Spreadsheet needs three columns: <strong>Customer</strong> (name, matched against your
        existing customer list), <strong>Amount</strong> (outstanding, in ₹), and{" "}
        <strong>Days Outstanding</strong> (how many days old that balance is, as of today) — plus
        an optional <strong>Notes</strong> column. Column names are matched loosely, so
        "Customer Name" or "Outstanding Amount" work fine too.
      </div>
      <input type="file" accept=".xlsx,.xls" onChange={handleFile} disabled={parsing} />

      {rows.length > 0 && (
        <>
          <div style={{ marginTop: 16, marginBottom: 8, fontSize: 12, color: unmatchedCount > 0 ? "var(--alert-red)" : "var(--signal-green)" }}>
            {readyCount} of {rows.length} row(s) ready to import
            {unmatchedCount > 0 ? ` — ${unmatchedCount} customer name(s) didn't match, fix them below before importing` : ""}
          </div>
          <div style={{ overflowX: "auto", marginBottom: 12 }}>
            <table style={{ fontSize: 12 }}>
              <thead><tr><th>Customer (from file)</th><th>Matched to</th><th>Amount</th><th>Days</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={!r.customer_id ? { background: "var(--alert-red-bg, #FBEAEA)" } : undefined}>
                    <td>{r.customer_name}</td>
                    <td>
                      <select value={r.customer_id} onChange={(e) => updateRowCustomer(i, e.target.value)}>
                        <option value="">— no match, select —</option>
                        {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </td>
                    <td>{r.amount || "–"}</td>
                    <td>{r.days_outstanding !== "" ? r.days_outstanding : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={confirmImport} disabled={saving || readyCount === 0}>
            {saving ? "Importing..." : `Import ${readyCount} opening balance(s)`}
          </button>
        </>
      )}
    </div>
  );
}
