// Round 193 — the Supplier Ledger tab of the Material Module.
//
// Built to the approved mock-up ("Supplier Ledger & Payments", v2): an
// overview of every supplier, one supplier's statement, Record payment and
// Opening balance forms, and printed PDFs of both. All figures come from the
// backend's lib/supplierLedger.js — this screen never adds anything up itself
// except the per-row presentation, so the screen, the PDF and the credit check
// on a new order always agree.
//
// Owner's rules shown here: a bill is the ACCEPTED quantity; loads weighed in
// with no receipt (and receipts still pending) are "received, not billed" —
// owed, flagged, and counted toward the credit limit; over the limit only warns.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { printMaterialReport } from "../lib/materialReportPdf.js";

// ---------- small helpers ----------
function todayIst() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
// Whole rupees print as such; anything with paise prints both decimals
// (₹4,40,423.20, never ₹4,40,423.2).
function amt(v) {
  const a = Math.abs(Number(v));
  const whole = Math.abs(a - Math.round(a)) < 0.005;
  return a.toLocaleString("en-IN", whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function money(n) {
  if (n === null || n === undefined || n === "") return "–";
  const v = Number(n);
  return `${v < 0 ? "-" : ""}₹${amt(v)}`;
}
// A balance reads Cr (we owe) or Dr (advance with the supplier).
function bal(n) {
  const v = Number(n || 0);
  if (Math.abs(v) < 0.005) return "₹0";
  return `₹${amt(v)} ${v > 0 ? "Cr" : "Dr"}`;
}
function fmtDate(d) {
  if (!d) return "–";
  const [y, m, day] = String(d).slice(0, 10).split("-");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
  return `${day}-${mon}-${y}`;
}
const MODES = [["neft", "NEFT"], ["rtgs", "RTGS"], ["cheque", "Cheque"], ["upi", "UPI"], ["cash", "Cash"], ["other", "Other"]];

const input = { width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 10px", border: "1px solid var(--border-strong)", borderRadius: 8, fontFamily: "inherit" };
const th = { textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--slate)", fontWeight: 500, padding: "8px 6px", borderBottom: "1px solid var(--border-strong)", whiteSpace: "nowrap" };
const td = { padding: "8px 6px", borderBottom: "1px solid var(--border)", fontSize: 12.5, verticalAlign: "top" };
const num = { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
const pill = (on) => ({ fontSize: 12, padding: "5px 11px", borderRadius: 999, border: `1px solid ${on ? "var(--charcoal)" : "var(--border-strong)"}`, background: on ? "var(--charcoal)" : "var(--surface)", color: on ? "#fff" : "var(--charcoal)" });

function Kpi({ label, value, sub, tone }) {
  const tones = {
    red: { color: "var(--alert-red)" }, amber: { color: "var(--amber)" }, green: { color: "var(--signal-green)" },
    warn: { background: "var(--amber-bg)", borderColor: "#E2CFA6", color: "#7A5410" },
    dark: { background: "var(--charcoal)", borderColor: "var(--charcoal)", color: "#fff" },
  };
  const t = tones[tone] || {};
  const boxed = tone === "warn" || tone === "dark";
  return (
    <div className="card" style={{ padding: "12px 14px", margin: 0, ...(boxed ? { background: t.background, borderColor: t.borderColor } : {}) }}>
      <div className="kpi-label" style={boxed ? { color: t.color, opacity: 0.85 } : undefined}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 700, marginTop: 2, color: t.color }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: boxed ? t.color : "var(--slate)", opacity: boxed ? 0.85 : 1 }}>{sub}</div>}
    </div>
  );
}

function Badge({ tone, children }) {
  const map = { red: "badge-danger", amber: "badge-warning", green: "badge-success", blue: "badge-info", grey: "badge-neutral" };
  return <span className={`badge ${map[tone] || "badge-neutral"}`} style={{ fontSize: 10.5, whiteSpace: "nowrap" }}>{children}</span>;
}

function LimitBar({ pct, over, limit }) {
  if (limit == null) return <span style={{ fontSize: 11, color: "var(--slate)" }}>no limit set</span>;
  const p = Math.max(0, pct || 0);
  const colour = over ? "var(--alert-red)" : p >= 75 ? "var(--amber)" : "var(--signal-green)";
  return (
    <div style={{ minWidth: 110 }}>
      <div style={{ height: 6, borderRadius: 3, background: "#ECEAE4", overflow: "hidden" }}>
        <div style={{ height: 6, width: `${Math.min(p, 100)}%`, background: colour }} />
      </div>
      <div style={{ fontSize: 11, marginTop: 3, color: over ? "var(--alert-red)" : "var(--slate)", fontWeight: over ? 700 : 400 }}>
        {over ? `Over limit · ${money(limit)}` : `${p}% of ${money(limit)}`}
      </div>
    </div>
  );
}

function statusOf(s) {
  if (s.overdue > 0) return { tone: "red", text: `${money(s.overdue)} overdue · ${s.oldest_overdue_days} days` };
  if (s.balance < -0.004) return { tone: "blue", text: "Advance paid" };
  if (s.balance > 0.004 && s.due_7_days > 0) return { tone: "amber", text: `${money(s.due_7_days)} due in 7 days` };
  if (s.balance > 0.004) return { tone: "grey", text: "Not due yet" };
  return { tone: "green", text: "Settled" };
}

function Modal({ title, sub, onClose, children, wide }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 60, overflowY: "auto", padding: "24px 12px" }}
         onMouseDown={(e) => { if (e.target === e.currentTarget) e.currentTarget.dataset.down = "1"; }}
         onClick={(e) => { if (e.target === e.currentTarget && e.currentTarget.dataset.down === "1") onClose(); e.currentTarget.dataset.down = ""; }}>
      <div style={{ background: "#fff", borderRadius: 14, width: "100%", maxWidth: wide ? 780 : 640, padding: "18px 20px", boxShadow: "0 12px 40px rgba(0,0,0,.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
            {sub && <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>{sub}</div>}
          </div>
          <button type="button" aria-label="Close" onClick={onClose} style={{ border: "none", background: "none", fontSize: 22, lineHeight: 1, padding: "2px 8px", color: "var(--slate)" }}>&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Label({ text, children, style }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--slate)", ...style }}>
      {text}
      {children}
    </label>
  );
}

// ======================================================================
export default function SupplierLedgerTab() {
  const { can } = usePermissions();
  const mayPay = can("material.supplier-payments", "create");
  const mayCancel = can("material.supplier-payments", "delete");
  const [asOn, setAsOn] = useState(todayIst());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState(null);      // supplier statement open
  const [paying, setPaying] = useState(null);      // { supplierId } | null
  const [opening, setOpening] = useState(null);    // { supplierId } | null
  const [showLoads, setShowLoads] = useState(false);

  async function load() {
    setError("");
    try { setData(await apiRequest(`/material-module/supplier-ledger?as_on=${asOn}`)); }
    catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, [asOn]); // eslint-disable-line react-hooks/exhaustive-deps

  function done(msg) { setNotice(msg); setPaying(null); setOpening(null); load(); }

  if (openId) {
    return (
      <>
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 10 }}>{notice}</div>}
        <SupplierStatement supplierId={openId} onBack={() => { setOpenId(null); setNotice(""); load(); }}
          mayPay={mayPay} mayCancel={mayCancel} setNotice={setNotice} />
      </>
    );
  }

  const suppliers = data ? data.suppliers : [];
  const q = search.trim().toLowerCase();
  const counts = {
    all: suppliers.length,
    balance: suppliers.filter((s) => s.balance > 0.004).length,
    overdue: suppliers.filter((s) => s.overdue > 0).length,
    advance: suppliers.filter((s) => s.balance < -0.004).length,
    limit: suppliers.filter((s) => s.over_limit).length,
  };
  const shown = suppliers.filter((s) => {
    if (q && !s.supplier.name.toLowerCase().includes(q)) return false;
    if (filter === "balance") return s.balance > 0.004;
    if (filter === "overdue") return s.overdue > 0;
    if (filter === "advance") return s.balance < -0.004;
    if (filter === "limit") return s.over_limit;
    return true;
  });
  const t = data ? data.totals : null;

  function printOverview() {
    printMaterialReport({
      title: "Supplier Ledger — all suppliers",
      landscape: true,
      meta: [`As on ${fmtDate(asOn)}`, filter !== "all" ? `Filter: ${filter}` : "", q ? `Search: ${search}` : ""].filter(Boolean),
      columns: [
        { header: "Supplier" }, { header: "Credit days", align: "right" }, { header: "Opening", align: "right" },
        { header: "Purchases", align: "right" }, { header: "Paid", align: "right" }, { header: "Balance", align: "right" },
        { header: "Overdue", align: "right" }, { header: "Not billed yet", align: "right" }, { header: "Credit limit", align: "right" },
        { header: "Last payment" },
      ],
      rows: shown.map((s) => [
        s.supplier.name, s.supplier.credit_days ?? "–", s.opening ? bal(s.opening_signed) : "–", money(s.purchases), money(s.paid),
        bal(s.balance), s.overdue ? money(s.overdue) : "–",
        s.not_billed_count ? `${money(s.not_billed_value)} (${s.not_billed_count})` : "–",
        s.supplier.credit_limit != null ? `${money(s.supplier.credit_limit)}${s.over_limit ? " - OVER" : ` (${s.limit_used_pct}%)`}` : "–",
        s.last_payment ? `${fmtDate(s.last_payment.date)} ${money(s.last_payment.amount)}` : "–",
      ]),
      foot: t ? [["Total", "", money(t.opening), money(t.purchases), money(t.paid), bal(t.balance), money(t.overdue), money(t.not_billed), "", ""]] : [],
      extraTables: data && data.pending_loads.length ? [{
        title: "Received, not billed yet (owed, not in the balances above)",
        columns: [{ header: "Supplier" }, { header: "Load" }, { header: "Date" }, { header: "Material" }, { header: "Qty", align: "right" }, { header: "Value", align: "right" }],
        rows: data.pending_loads.map((n) => [
          n.supplier_name, n.kind === "weighbridge" ? `WB #${n.id}${n.vehicle ? ` · ${n.vehicle}` : ""}` : `Receipt R-${String(n.id).padStart(4, "0")} (pending)`,
          fmtDate(n.date), n.material_name, n.qty != null ? `${n.qty} ${n.unit}` : `${n.net_kg} kg`, n.value != null ? money(n.value) : "no rate",
        ]),
      }] : [],
      filename: `supplier-ledger-${asOn}.pdf`,
    }).catch((e) => setError(e.message));
  }

  return (
    <div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 10 }}>{notice}</div>}

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Supplier ledger</div>
          <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>What we owe each supplier: opening balance + bills (accepted qty) − payments.</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Label text="As on"><input type="date" value={asOn} max={todayIst()} onChange={(e) => setAsOn(e.target.value || todayIst())} style={{ ...input, width: 150 }} /></Label>
          {mayPay && <button type="button" onClick={() => setOpening({ supplierId: "" })}>+ Opening balance</button>}
          <button type="button" onClick={printOverview} disabled={!data}>Print (PDF)</button>
          {mayPay && <button type="button" className="btn-primary" onClick={() => setPaying({ supplierId: "" })}>Record payment</button>}
        </div>
      </div>

      {!data ? <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div> : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 12 }}>
            <Kpi label="Total payable" value={money(t.payable)} sub={t.advance > 0 ? `advances ${money(t.advance)}` : `${counts.balance} supplier${counts.balance === 1 ? "" : "s"}`} />
            <Kpi label="Overdue" value={money(t.overdue)} tone={t.overdue > 0 ? "red" : undefined} sub="past each supplier's credit days" />
            <Kpi label="Due in next 7 days" value={money(t.due_7_days)} tone={t.due_7_days > 0 ? "amber" : undefined} />
            <Kpi label="Paid this month" value={money(t.paid_this_month)} tone="green" sub={`${t.payments_this_month} payment${t.payments_this_month === 1 ? "" : "s"}`} />
            <Kpi label="Received, not billed" value={money(t.not_billed)} tone={t.not_billed_count ? "warn" : undefined} sub={`${t.not_billed_count} load${t.not_billed_count === 1 ? "" : "s"} · no receipt yet`} />
          </div>

          {t.not_billed_count > 0 && (
            <div style={{ background: "#FBF6EC", border: "1px solid #E2CFA6", borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 12.5, color: "#5E420C", lineHeight: 1.5 }}>
              <b>{t.not_billed_count} load{t.not_billed_count === 1 ? "" : "s"} received but not billed</b> — we owe for {t.not_billed_count === 1 ? "it" : "these"} too
              (about {money(t.not_billed)}), but {t.not_billed_count === 1 ? "it is" : "they are"} not in any balance until Store prepares the receipt
              {t.oldest_not_billed_days > 0 ? ` (oldest ${t.oldest_not_billed_days} day${t.oldest_not_billed_days === 1 ? "" : "s"})` : ""}.{" "}
              <button type="button" onClick={() => setShowLoads(!showLoads)} style={{ fontSize: 12, padding: "3px 10px", marginLeft: 4 }}>{showLoads ? "Hide loads" : "Show loads"}</button>
              {showLoads && (
                <div style={{ overflowX: "auto", marginTop: 8 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr><th style={th}>Supplier</th><th style={th}>Load</th><th style={th}>Date</th><th style={th}>Material</th><th style={{ ...th, ...num }}>Qty</th><th style={{ ...th, ...num }}>Value</th></tr></thead>
                    <tbody>
                      {data.pending_loads.map((n) => (
                        <tr key={`${n.kind}${n.id}`}>
                          <td style={td}>{n.supplier_name}</td>
                          <td style={td}>{n.kind === "weighbridge" ? `WB #${n.id}` : `R-${String(n.id).padStart(4, "0")} pending`}<div style={{ fontSize: 11, color: "var(--slate)" }}>{n.vehicle || ""}{n.kind === "weighbridge" && n.days_waiting ? ` · ${n.days_waiting} day${n.days_waiting === 1 ? "" : "s"} waiting` : ""}</div></td>
                          <td style={td}>{fmtDate(n.date)}</td>
                          <td style={td}>{n.material_name}</td>
                          <td style={{ ...td, ...num }}>{n.qty != null ? `${n.qty} ${n.unit}` : `${n.net_kg} kg`}</td>
                          <td style={{ ...td, ...num }}>{n.value != null ? money(n.value) : <span style={{ color: "var(--amber)" }}>no rate</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="card" style={{ padding: "12px 14px" }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
              <input type="search" aria-label="Search suppliers" placeholder="Search supplier" value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...input, width: 220 }} />
              {[["all", "All"], ["balance", "With balance"], ["overdue", "Overdue"], ["limit", "Over limit"], ["advance", "Advance paid"]].map(([k, l]) => (
                <button key={k} type="button" style={pill(filter === k)} onClick={() => setFilter(k)}>{l} · {counts[k]}</button>
              ))}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Supplier</th>
                    <th style={{ ...th, ...num }}>Opening</th>
                    <th style={{ ...th, ...num }}>Purchases</th>
                    <th style={{ ...th, ...num }}>Paid</th>
                    <th style={{ ...th, ...num }}>Balance</th>
                    <th style={th}>Credit limit used</th>
                    <th style={{ ...th, ...num }}>Not billed yet</th>
                    <th style={th}>Status</th>
                    <th style={th}>Last payment</th>
                    <th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s) => {
                    const st = statusOf(s);
                    return (
                      <tr key={s.supplier.id}>
                        <td style={td}>
                          <div style={{ fontWeight: 600 }}>{s.supplier.name}</div>
                          <div style={{ fontSize: 11, color: "var(--slate)" }}>
                            {s.supplier.materials || "—"} · {s.supplier.credit_days != null ? `${s.supplier.credit_days} days credit` : "no credit days set"}
                          </div>
                        </td>
                        <td style={{ ...td, ...num, color: "var(--slate)" }}>{s.opening ? bal(s.opening_signed) : "—"}</td>
                        <td style={{ ...td, ...num }}>{money(s.purchases)}</td>
                        <td style={{ ...td, ...num }}>{money(s.paid)}</td>
                        <td style={{ ...td, ...num, fontWeight: 700 }}>{bal(s.balance)}</td>
                        <td style={td}><LimitBar pct={s.limit_used_pct} over={s.over_limit} limit={s.supplier.credit_limit} /></td>
                        <td style={{ ...td, ...num, color: s.not_billed_count ? "#7A5410" : "var(--slate)" }}>{s.not_billed_count ? `${money(s.not_billed_value)} · ${s.not_billed_count}` : "—"}</td>
                        <td style={td}><Badge tone={st.tone}>{st.text}</Badge></td>
                        <td style={{ ...td, fontSize: 11.5, color: "var(--slate)", whiteSpace: "nowrap" }}>{s.last_payment ? <>{fmtDate(s.last_payment.date)}<div>{money(s.last_payment.amount)}</div></> : "—"}</td>
                        <td style={{ ...td, textAlign: "right" }}><button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => { setNotice(""); setOpenId(s.supplier.id); }}>Ledger →</button></td>
                      </tr>
                    );
                  })}
                  {!shown.length && <tr><td style={td} colSpan={10}><span style={{ color: "var(--slate)" }}>No suppliers match.</span></td></tr>}
                  {shown.length > 0 && filter === "all" && !q && (
                    <tr>
                      <td style={{ ...td, fontWeight: 700, borderTop: "1px solid var(--border-strong)" }}>Total · {shown.length}</td>
                      <td style={{ ...td, ...num, fontWeight: 700, borderTop: "1px solid var(--border-strong)" }}>{bal(t.opening)}</td>
                      <td style={{ ...td, ...num, fontWeight: 700, borderTop: "1px solid var(--border-strong)" }}>{money(t.purchases)}</td>
                      <td style={{ ...td, ...num, fontWeight: 700, borderTop: "1px solid var(--border-strong)" }}>{money(t.paid)}</td>
                      <td style={{ ...td, ...num, fontWeight: 700, borderTop: "1px solid var(--border-strong)" }}>{bal(t.balance)}</td>
                      <td style={{ ...td, borderTop: "1px solid var(--border-strong)" }}></td>
                      <td style={{ ...td, ...num, fontWeight: 700, borderTop: "1px solid var(--border-strong)", color: "#7A5410" }}>{money(t.not_billed)}</td>
                      <td colSpan={3} style={{ ...td, borderTop: "1px solid var(--border-strong)" }}></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 8, lineHeight: 1.5 }}>
            Bills come from receipts: the <b>accepted</b> quantity × order rate (+ freight on a delivered order) + GST — a short supply is
            never billed. "Not billed yet" is loads weighed in with no receipt, and receipts waiting for a Manager, valued at the order rate.
            Credit limit used = balance + not billed. Credit days and limit are set on each supplier (Suppliers tab).
          </div>
        </>
      )}

      {paying && <PaymentForm supplierId={paying.supplierId} suppliers={suppliers} onClose={() => setPaying(null)} onDone={done} />}
      {opening && <OpeningForm supplierId={opening.supplierId} suppliers={suppliers} onClose={() => setOpening(null)} onDone={done} />}
    </div>
  );
}

// ======================================================================
// One supplier's statement
function SupplierStatement({ supplierId, onBack, mayPay, mayCancel, setNotice }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(todayIst());
  const [kind, setKind] = useState("all");
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [paying, setPaying] = useState(false);
  const [opening, setOpening] = useState(false);
  const [cancelling, setCancelling] = useState(null);

  async function load() {
    setError("");
    try {
      const qs = new URLSearchParams({ to });
      if (from) qs.set("from", from);
      const r = await apiRequest(`/material-module/supplier-ledger/${supplierId}?${qs}`);
      setD(r);
      if (!from) setFrom(r.from);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, [supplierId, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  const lines = useMemo(() => (d ? d.lines.filter((l) => kind === "all" || l.type === kind || (kind === "bill" && l.type === "opening")) : []), [d, kind]);

  if (!d) {
    return (
      <div>
        <button type="button" onClick={onBack} style={{ fontSize: 12.5, marginBottom: 10 }}>← All suppliers</button>
        <div className="card" style={{ fontSize: 13, color: error ? "var(--alert-red)" : "var(--slate)" }}>{error || "Loading…"}</div>
      </div>
    );
  }
  const s = d.supplier;
  const overdueBills = d.open_bills.filter((b) => b.overdue);
  const ageing = [
    ["not yet due", d.open_bills.filter((b) => !b.overdue).reduce((t, b) => t + b.outstanding, 0), "var(--amber)"],
    ["1–30 days late", d.open_bills.filter((b) => b.overdue && b.days_late <= 30).reduce((t, b) => t + b.outstanding, 0), "var(--alert-red)"],
    ["31–60 days late", d.open_bills.filter((b) => b.days_late > 30 && b.days_late <= 60).reduce((t, b) => t + b.outstanding, 0), "#8E2B21"],
    ["over 60 days", d.open_bills.filter((b) => b.days_late > 60).reduce((t, b) => t + b.outstanding, 0), "#5A1A14"],
  ];
  const ageTotal = ageing.reduce((t, a) => t + a[1], 0);

  function printStatement() {
    const rows = [];
    if (d.brought_forward != null) rows.push([fmtDate(d.from), "", "Balance brought forward", "", "", bal(d.brought_forward)]);
    for (const l of d.lines) rows.push([fmtDate(l.date), l.type === "bill" ? "Bill" : l.type === "payment" ? "Payment" : "Opening",
      `${l.text}${l.refs ? ` — ${l.refs}` : ""}`, l.debit ? money(l.debit) : "", l.credit ? money(l.credit) : "", bal(l.balance)]);
    printMaterialReport({
      title: `Supplier Ledger — ${s.name}`,
      meta: [
        `Period ${fmtDate(d.from)} to ${fmtDate(d.to)}`,
        s.gstin ? `GSTIN ${s.gstin}` : "",
        s.credit_days != null ? `Credit ${s.credit_days} days` : "",
        s.credit_limit != null ? `Limit ${money(s.credit_limit)}` : "",
        `Closing balance ${bal(d.balance)}`,
        d.overdue ? `Overdue ${money(d.overdue)}` : "",
      ].filter(Boolean),
      columns: [{ header: "Date", width: 22 }, { header: "Type", width: 18 }, { header: "Particulars" },
        { header: "Debit (paid)", align: "right", width: 26 }, { header: "Credit (billed)", align: "right", width: 26 }, { header: "Balance", align: "right", width: 30 }],
      rows,
      foot: [["", "", "Total for the period", money(d.period_debit), money(d.period_credit), bal(d.balance)]],
      extraTables: [
        { title: `Unpaid bills as on ${fmtDate(d.to)}`,
          columns: [{ header: "Bill" }, { header: "Bill date" }, { header: "Due" }, { header: "Billed", align: "right" }, { header: "Outstanding", align: "right" }, { header: "Status" }],
          rows: d.open_bills.map((b) => [b.no, fmtDate(b.date), fmtDate(b.due_date), money(b.amount), money(b.outstanding), b.overdue ? `${b.days_late} days late` : "not due"]) },
        { title: "Received, receipt not yet prepared (not in the balance above)",
          columns: [{ header: "Load" }, { header: "Date" }, { header: "Material" }, { header: "Qty", align: "right" }, { header: "Value", align: "right" }],
          rows: d.not_billed.map((n) => [n.kind === "weighbridge" ? `WB #${n.id}` : `R-${String(n.id).padStart(4, "0")} (pending)`, fmtDate(n.date), n.material_name,
            n.qty != null ? `${n.qty} ${n.unit}` : `${n.net_kg} kg`, n.value != null ? money(n.value) : "no rate"]) },
      ],
      filename: `ledger-${s.name.replace(/[^\w]+/g, "-").toLowerCase()}-${d.to}.pdf`,
    }).catch((e) => setError(e.message));
  }

  async function reload(msg) { setNotice(msg); setPaying(false); setOpening(false); setCancelling(null); await load(); }

  return (
    <div>
      <button type="button" onClick={onBack} style={{ fontSize: 12.5, marginBottom: 10 }}>← All suppliers</button>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700 }}>{s.name}</div>
          <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 3, lineHeight: 1.5 }}>
            {s.gstin ? `GSTIN ${s.gstin} · ` : ""}{s.contact_person ? `${s.contact_person} · ` : ""}{s.phone ? `${s.phone} · ` : ""}
            {s.credit_days != null ? `Credit ${s.credit_days} days` : "No credit days set"}
            {s.credit_limit != null && <> · Credit limit {money(s.credit_limit)}{d.over_limit
              ? <b style={{ color: "var(--alert-red)" }}> — over by {money(d.over_limit_by)} counting loads not yet billed</b>
              : ` (${d.limit_used_pct}% used)`}</>}
            {s.materials ? ` · ${s.materials}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
          {mayPay && <button type="button" onClick={() => setOpening(true)}>Opening balance</button>}
          <button type="button" onClick={printStatement}>Print (PDF)</button>
          {mayPay && <button type="button" className="btn-primary" onClick={() => setPaying(true)}>Record payment</button>}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 12 }}>
        <Kpi label={d.opening ? `Opening · ${fmtDate(d.opening.as_on)}` : "Opening"} value={d.opening ? bal(d.opening_signed) : "not set"} />
        <Kpi label="Purchases" value={money(d.purchases)} sub={`${d.lines.filter((l) => l.type === "bill").length} bills in the period`} />
        <Kpi label="Paid" value={money(d.paid)} tone="green" />
        <Kpi label="Received, not billed" value={money(d.not_billed_value)} tone={d.not_billed_count ? "warn" : undefined} sub={`${d.not_billed_count} load${d.not_billed_count === 1 ? "" : "s"}`} />
        <Kpi label="Balance payable" value={bal(d.balance)} tone="dark" sub={d.overdue ? `${money(d.overdue)} overdue` : "nothing overdue"} />
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div className="card" style={{ flex: "999 1 560px", minWidth: 0, margin: 0, padding: "12px 14px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 8 }}>
            <Label text="From"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={{ ...input, width: 150 }} /></Label>
            <Label text="To"><input type="date" value={to} max={todayIst()} onChange={(e) => setTo(e.target.value || todayIst())} style={{ ...input, width: 150 }} /></Label>
            {[["all", "All entries"], ["bill", "Bills"], ["payment", "Payments"]].map(([k, l]) => (
              <button key={k} type="button" style={pill(kind === k)} onClick={() => setKind(k)}>{l}</button>
            ))}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr><th style={th}>Date</th><th style={th}>Type</th><th style={th}>Particulars</th>
                  <th style={{ ...th, ...num }}>Debit (paid)</th><th style={{ ...th, ...num }}>Credit (billed)</th><th style={{ ...th, ...num }}>Balance</th>
                  {mayCancel && <th style={th}></th>}</tr>
              </thead>
              <tbody>
                {d.brought_forward != null && kind === "all" && (
                  <tr><td style={{ ...td, color: "var(--slate)" }}>{fmtDate(d.from)}</td><td style={td}><Badge tone="blue">B/F</Badge></td>
                    <td style={td}>Balance brought forward</td><td style={td}></td><td style={td}></td>
                    <td style={{ ...td, ...num, fontWeight: 600 }}>{bal(d.brought_forward)}</td>{mayCancel && <td style={td}></td>}</tr>
                )}
                {lines.map((l, i) => (
                  <tr key={`${l.type}${l.ref_id || i}`}>
                    <td style={{ ...td, color: "var(--slate)", whiteSpace: "nowrap" }}>{fmtDate(l.date)}</td>
                    <td style={td}><Badge tone={l.type === "payment" ? "green" : l.type === "opening" ? "blue" : "grey"}>{l.type === "bill" ? "Bill" : l.type === "payment" ? "Payment" : "Opening"}</Badge></td>
                    <td style={td}>{l.text}<div style={{ fontSize: 11, color: "var(--slate)" }}>{l.refs}</div></td>
                    <td style={{ ...td, ...num }}>{l.debit ? money(l.debit) : ""}</td>
                    <td style={{ ...td, ...num }}>{l.credit ? money(l.credit) : ""}</td>
                    <td style={{ ...td, ...num, fontWeight: 600 }}>{kind === "all" ? bal(l.balance) : ""}</td>
                    {mayCancel && <td style={{ ...td, textAlign: "right" }}>
                      {l.type === "payment" && <button type="button" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => setCancelling(l)}>Cancel</button>}
                    </td>}
                  </tr>
                ))}
                {!lines.length && d.brought_forward == null && <tr><td style={td} colSpan={7}><span style={{ color: "var(--slate)" }}>Nothing in this period.</span></td></tr>}
                <tr>
                  <td colSpan={3} style={{ ...td, fontWeight: 700, borderTop: "1px solid var(--border-strong)" }}>Closing balance · {fmtDate(d.to)}</td>
                  <td style={{ ...td, ...num, fontWeight: 700, borderTop: "1px solid var(--border-strong)" }}>{money(d.period_debit)}</td>
                  <td style={{ ...td, ...num, fontWeight: 700, borderTop: "1px solid var(--border-strong)" }}>{money(d.period_credit)}</td>
                  <td style={{ ...td, ...num, fontWeight: 700, borderTop: "1px solid var(--border-strong)" }}>{bal(d.balance)}</td>
                  {mayCancel && <td style={{ ...td, borderTop: "1px solid var(--border-strong)" }}></td>}
                </tr>
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 6 }}>
            Cr = we owe the supplier · Dr = advance with the supplier. Each bill is the accepted quantity; the invoice quantity is shown when it differs.
          </div>
        </div>

        <div style={{ flex: "1 1 300px", display: "flex", flexDirection: "column", gap: 12 }}>
          {d.not_billed.length > 0 && (
            <div className="card" style={{ margin: 0, padding: "12px 14px", background: "#FBF6EC", borderColor: "#E2CFA6" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#7A5410" }}>Received, receipt not prepared</div>
              <div style={{ fontSize: 11.5, color: "#7A5410", marginBottom: 6 }}>We owe for these too. Valued at the open order rate until a receipt is made.</div>
              {d.not_billed.map((n) => (
                <div key={`${n.kind}${n.id}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "7px 0", borderTop: "1px solid #E2CFA6", fontSize: 12 }}>
                  <div>
                    <b>{n.kind === "weighbridge" ? `WB #${n.id}` : `R-${String(n.id).padStart(4, "0")}`}</b> · {fmtDate(n.date)}
                    <div style={{ fontSize: 11, color: "#7A5410" }}>
                      {n.vehicle ? `${n.vehicle} · ` : ""}{n.qty != null ? `${n.qty} ${n.unit}` : `${n.net_kg} kg`}
                      {n.kind === "weighbridge" ? ` · ${n.days_waiting} day${n.days_waiting === 1 ? "" : "s"}` : " · waiting for a Manager"}
                    </div>
                  </div>
                  <div style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{n.value != null ? money(n.value) : "no rate"}</div>
                </div>
              ))}
            </div>
          )}

          <div className="card" style={{ margin: 0, padding: "12px 14px" }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Open bills</div>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 6 }}>Payments settle the oldest bill first unless allocated by hand.</div>
            {!d.open_bills.length && <div style={{ fontSize: 12, color: "var(--slate)" }}>Nothing outstanding.</div>}
            {d.open_bills.map((b) => (
              <div key={`${b.kind}${b.id}`} style={{ padding: "8px 0", borderTop: "1px solid var(--border)", fontSize: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><b>{b.no}</b><b>{money(b.outstanding)}</b></div>
                <div style={{ fontSize: 11, color: "var(--slate)" }}>{b.detail}{b.settled ? ` · ${money(b.settled)} paid` : ""}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 3 }}>
                  <Badge tone={b.overdue ? "red" : "amber"}>{b.overdue ? `${b.days_late} days late` : "not due yet"}</Badge>
                  <span style={{ fontSize: 11, color: "var(--slate)" }}>due {fmtDate(b.due_date)}</span>
                </div>
              </div>
            ))}
          </div>

          {ageTotal > 0 && (
            <div className="card" style={{ margin: 0, padding: "12px 14px" }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Ageing of {money(ageTotal)}</div>
              <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: "#ECEAE4" }}>
                {ageing.filter((a) => a[1] > 0).map((a) => <div key={a[0]} title={`${a[0]}: ${money(a[1])}`} style={{ width: `${(a[1] / ageTotal) * 100}%`, background: a[2] }} />)}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6, marginTop: 8, fontSize: 11, color: "var(--slate)" }}>
                {ageing.map((a) => <div key={a[0]}><b style={{ color: "var(--charcoal)", fontSize: 12 }}>{money(a[1])}</b><div>{a[0]}</div></div>)}
              </div>
              {overdueBills.length > 0 && <div style={{ fontSize: 11, color: "var(--alert-red)", marginTop: 6 }}>{overdueBills.length} bill{overdueBills.length === 1 ? "" : "s"} overdue</div>}
            </div>
          )}
        </div>
      </div>

      {paying && <PaymentForm supplierId={supplierId} suppliers={[{ supplier: s, balance: d.balance, overdue: d.overdue }]} onClose={() => setPaying(false)} onDone={reload} />}
      {opening && <OpeningForm supplierId={supplierId} suppliers={[{ supplier: s, opening: d.opening }]} onClose={() => setOpening(false)} onDone={reload} />}
      {cancelling && <CancelPayment line={cancelling} onClose={() => setCancelling(null)} onDone={reload} />}
    </div>
  );
}

// ======================================================================
function PaymentForm({ supplierId, suppliers, onClose, onDone }) {
  const [sid, setSid] = useState(supplierId ? String(supplierId) : "");
  const [bills, setBills] = useState([]);
  const [info, setInfo] = useState(null);
  const [f, setF] = useState({ paid_on: todayIst(), amount: "", mode: "neft", reference: "", bank_account: "", tds_amount: "", notes: "" });
  const [alloc, setAlloc] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!sid) { setBills([]); setInfo(null); return; }
    apiRequest(`/material-module/supplier-ledger/${sid}`).then((d) => { setBills(d.open_bills); setInfo(d); setAlloc({}); }).catch((e) => setError(e.message));
  }, [sid]);

  const amount = Number(String(f.amount).replace(/,/g, "")) || 0;
  const tds = Number(String(f.tds_amount).replace(/,/g, "")) || 0;
  const allocTotal = Object.values(alloc).reduce((t, v) => t + (Number(v) || 0), 0);
  const left = Math.round((amount + tds - allocTotal) * 100) / 100;

  function oldestFirst() {
    let rest = amount + tds;
    const next = {};
    for (const b of bills) {
      if (rest <= 0) break;
      const take = Math.min(rest, b.outstanding);
      next[`${b.kind}:${b.id}`] = String(Math.round(take * 100) / 100);
      rest -= take;
    }
    setAlloc(next);
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      const allocations = Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([k, v]) => {
        const [kind, id] = k.split(":");
        return { kind, id: Number(id), amount: Number(v) };
      });
      await apiRequest(`/material-module/supplier-ledger/${sid}/payments`, { method: "POST", body: { ...f, allocations } });
      onDone(`Payment of ${money(amount)} saved.`);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  const sel = suppliers.find((x) => String(x.supplier.id) === String(sid));
  return (
    <Modal wide title="Record payment" onClose={onClose}
      sub={info ? `${info.supplier.name} · balance ${bal(info.balance)}${info.overdue ? ` · ${money(info.overdue)} overdue` : ""}` : "Choose the supplier"}>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
          <Label text="Supplier">
            <select required value={sid} onChange={(e) => setSid(e.target.value)} style={input} disabled={!!supplierId && !!sel}>
              <option value="">Select supplier</option>
              {suppliers.map((x) => <option key={x.supplier.id} value={x.supplier.id}>{x.supplier.name}</option>)}
            </select>
          </Label>
          <Label text="Payment date"><input required type="date" value={f.paid_on} max={todayIst()} onChange={(e) => setF({ ...f, paid_on: e.target.value })} style={input} /></Label>
          <Label text="Amount paid (₹)"><input required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={{ ...input, textAlign: "right", fontWeight: 700 }} /></Label>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 4 }}>Mode</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {MODES.map(([k, l]) => <button key={k} type="button" style={pill(f.mode === k)} onClick={() => setF({ ...f, mode: k })}>{l}</button>)}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
          <Label text={f.mode === "cheque" ? "Cheque no." : f.mode === "cash" ? "Receipt / voucher no. (optional)" : "UTR / reference no."}>
            <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} style={input} required={["neft", "rtgs", "cheque", "upi"].includes(f.mode)} />
          </Label>
          <Label text="Paid from (bank / account)"><input value={f.bank_account} onChange={(e) => setF({ ...f, bank_account: e.target.value })} style={input} placeholder="optional" /></Label>
          <Label text="TDS deducted (₹)"><input inputMode="decimal" value={f.tds_amount} onChange={(e) => setF({ ...f, tds_amount: e.target.value })} style={{ ...input, textAlign: "right" }} placeholder="0" /></Label>
        </div>

        {sid && (
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "#F7F5F0" }}>
              <b style={{ fontSize: 13 }}>Settle against bills</b>
              <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={oldestFirst} disabled={!amount || !bills.length}>Oldest first</button>
            </div>
            {!bills.length ? <div style={{ padding: 12, fontSize: 12.5, color: "var(--slate)" }}>No open bills — the whole payment is an advance.</div> : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}>Bill</th><th style={th}>Due</th><th style={{ ...th, ...num }}>Outstanding</th><th style={{ ...th, ...num }}>Settle now</th></tr></thead>
                  <tbody>
                    {bills.map((b) => (
                      <tr key={`${b.kind}${b.id}`}>
                        <td style={td}><b>{b.no}</b> <span style={{ fontSize: 11, color: "var(--slate)" }}>· {fmtDate(b.date)}</span></td>
                        <td style={{ ...td, color: b.overdue ? "var(--alert-red)" : "var(--amber)", fontWeight: 600, whiteSpace: "nowrap" }}>{b.overdue ? `${b.days_late} days late` : `due ${fmtDate(b.due_date)}`}</td>
                        <td style={{ ...td, ...num }}>{money(b.outstanding)}</td>
                        <td style={{ ...td, ...num }}>
                          <input aria-label={`Settle ${b.no}`} inputMode="decimal" value={alloc[`${b.kind}:${b.id}`] || ""} placeholder="0"
                            onChange={(e) => setAlloc({ ...alloc, [`${b.kind}:${b.id}`]: e.target.value })} style={{ ...input, width: 120, textAlign: "right", padding: "6px 8px" }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, background: "#F7F5F0", borderRadius: 10, padding: "10px 12px", fontSize: 11.5, color: "var(--slate)" }}>
          <div>Paid + TDS<div style={{ fontSize: 15, fontWeight: 700, color: "var(--charcoal)" }}>{money(amount + tds)}</div></div>
          <div>Settled against bills<div style={{ fontSize: 15, fontWeight: 700, color: "var(--signal-green)" }}>{money(allocTotal)}</div></div>
          <div>{left < 0 ? "Settled more than paid" : "Rest settles oldest bills / advance"}<div style={{ fontSize: 15, fontWeight: 700, color: left < 0 ? "var(--alert-red)" : "var(--charcoal)" }}>{money(left)}</div></div>
        </div>
        <Label text="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} style={input} placeholder="optional" /></Label>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 11.5, color: "var(--slate)" }}>
            {info ? <>Balance after this payment: <b style={{ color: "var(--charcoal)" }}>{bal(info.balance - amount - tds)}</b>. </> : null}
            A saved payment can only be cancelled (with a reason), never edited.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving || !sid || !amount || left < 0}>{saving ? "Saving..." : "Save payment"}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ======================================================================
function OpeningForm({ supplierId, suppliers, onClose, onDone }) {
  const [sid, setSid] = useState(supplierId ? String(supplierId) : "");
  const existing = suppliers.find((x) => String(x.supplier.id) === String(sid))?.opening || null;
  const [asOn, setAsOn] = useState(existing ? existing.as_on : todayIst());
  const [direction, setDirection] = useState(existing ? existing.direction : "payable");
  const [billWise, setBillWise] = useState(existing ? existing.bills.length > 1 || !!existing.bills[0]?.bill_no : false);
  const [rows, setRows] = useState(existing && existing.bills.length
    ? existing.bills.map((b) => ({ bill_no: b.bill_no || "", bill_date: b.bill_date, amount: String(b.amount) }))
    : [{ bill_no: "", bill_date: "", amount: "" }]);
  const [remarks, setRemarks] = useState(existing ? existing.remarks || "" : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Picking a supplier from the overview loads what it already has.
  useEffect(() => {
    if (supplierId || !sid) return;
    apiRequest(`/material-module/supplier-ledger/${sid}`).then((d) => {
      const o = d.opening;
      if (!o) { setRows([{ bill_no: "", bill_date: "", amount: "" }]); setRemarks(""); return; }
      setAsOn(o.as_on); setDirection(o.direction); setRemarks(o.remarks || "");
      setBillWise(o.bills.length > 1 || !!o.bills[0]?.bill_no);
      setRows(o.bills.map((b) => ({ bill_no: b.bill_no || "", bill_date: b.bill_date, amount: String(b.amount) })));
    }).catch(() => {});
  }, [sid]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = rows.reduce((t, r) => t + (Number(String(r.amount).replace(/,/g, "")) || 0), 0);

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      const bills = billWise ? rows : [{ bill_no: "", bill_date: asOn, amount: rows[0].amount }];
      await apiRequest(`/material-module/supplier-ledger/${sid}/opening`, { method: "PUT", body: { as_on: asOn, direction, bills, remarks } });
      onDone("Opening balance saved.");
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <Modal title="Opening balance" sub="What stood with the supplier on the day the ledger starts. Entered once per supplier; every change is logged." onClose={onClose}>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
          <Label text="Supplier">
            <select required value={sid} onChange={(e) => setSid(e.target.value)} style={input} disabled={!!supplierId}>
              <option value="">Select supplier</option>
              {suppliers.map((x) => <option key={x.supplier.id} value={x.supplier.id}>{x.supplier.name}</option>)}
            </select>
          </Label>
          <Label text="As on"><input required type="date" value={asOn} max={todayIst()} onChange={(e) => setAsOn(e.target.value)} style={input} /></Label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
          {[["payable", "We owe the supplier", "unpaid bills — shown as Cr"], ["advance", "Advance we paid", "supplier owes us — shown as Dr"]].map(([k, l, sub]) => (
            <button key={k} type="button" onClick={() => setDirection(k)}
              style={{ textAlign: "left", padding: "10px 12px", borderRadius: 10, border: direction === k ? "2px solid var(--charcoal)" : "1px solid var(--border-strong)", background: "#fff" }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{l}</div><div style={{ fontSize: 11, color: "var(--slate)" }}>{sub}</div>
            </button>
          ))}
        </div>
        {direction === "payable" && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--slate)" }}>Enter as</span>
            <button type="button" style={pill(!billWise)} onClick={() => setBillWise(false)}>One total</button>
            <button type="button" style={pill(billWise)} onClick={() => setBillWise(true)}>Bill by bill</button>
          </div>
        )}
        {(!billWise || direction === "advance") ? (
          <Label text={direction === "advance" ? "Advance amount (₹)" : "Total owed (₹)"}>
            <input required inputMode="decimal" value={rows[0].amount} onChange={(e) => setRows([{ ...rows[0], amount: e.target.value }])} style={{ ...input, textAlign: "right", fontWeight: 700 }} />
          </Label>
        ) : (
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Supplier bill no.</th><th style={th}>Bill date</th><th style={{ ...th, ...num }}>Unpaid (₹)</th><th style={th}></th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={td}><input aria-label={`Bill number ${i + 1}`} value={r.bill_no} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, bill_no: e.target.value } : x)))} style={{ ...input, padding: "6px 8px" }} /></td>
                    <td style={td}><input aria-label={`Bill date ${i + 1}`} type="date" max={asOn} value={r.bill_date} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, bill_date: e.target.value } : x)))} style={{ ...input, padding: "6px 8px" }} /></td>
                    <td style={td}><input aria-label={`Amount ${i + 1}`} inputMode="decimal" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} style={{ ...input, padding: "6px 8px", textAlign: "right" }} /></td>
                    <td style={td}>{rows.length > 1 && <button type="button" aria-label={`Remove bill ${i + 1}`} style={{ fontSize: 11, padding: "4px 8px" }} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2} style={td}><button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setRows([...rows, { bill_no: "", bill_date: "", amount: "" }])}>+ Add bill</button></td>
                  <td style={{ ...td, ...num, fontWeight: 700 }}>{money(total)}</td><td style={td}></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <Label text="Source / remarks"><input value={remarks} onChange={(e) => setRemarks(e.target.value)} style={input} placeholder="e.g. as per Tally ledger, 31-Mar" /></Label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving || !sid}>{saving ? "Saving..." : "Save opening balance"}</button>
        </div>
      </form>
    </Modal>
  );
}

function CancelPayment({ line, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function go(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest(`/material-module/supplier-payments/${line.ref_id}/cancel`, { method: "POST", body: { reason } });
      onDone("Payment cancelled.");
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  return (
    <Modal title="Cancel payment" sub={`${fmtDate(line.date)} · ${money(line.debit)} · ${line.text}`} onClose={onClose}>
      <form onSubmit={go} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
        <div style={{ fontSize: 12.5, color: "var(--slate)" }}>The payment stays on record as cancelled and stops counting; the bills it settled become unpaid again.</div>
        <Label text="Reason"><input required value={reason} onChange={(e) => setReason(e.target.value)} style={input} /></Label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose}>Keep it</button>
          <button type="submit" className="btn-danger" disabled={saving}>{saving ? "Cancelling..." : "Cancel payment"}</button>
        </div>
      </form>
    </Modal>
  );
}
