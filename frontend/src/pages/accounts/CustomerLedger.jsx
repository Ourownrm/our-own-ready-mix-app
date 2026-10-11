// Round 204 — customer ledger: invoices debit, receipts credit, the opening
// balance, a running balance, ageing and the credit position. A receipt not
// yet set against an invoice is the customer's advance.
import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { inr2, fmtDate } from "../../lib/quotationTerms.js";
import { TH, TD, NUM, row, money, Banner, Empty, Table } from "./ui.jsx";
import { ReceiptModal } from "./BankReceipts.jsx";

export default function CustomerLedger({ params, go }) {
  const cid = params.get("customer_id");
  if (cid) return <Statement customerId={cid} go={go} />;
  return <Balances go={go} />;
}

function Balances({ go }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [onlyDue, setOnlyDue] = useState(true);
  useEffect(() => { apiRequest("/accounts/ledger").then(setRows).catch((e) => setError(e.message)); }, []);
  const shown = useMemo(() => (rows || []).filter((r) =>
    (!onlyDue || Math.abs(Number(r.balance)) > 0.5) && (!search || r.name.toLowerCase().includes(search.toLowerCase()))), [rows, search, onlyDue]);
  const total = shown.reduce((t, r) => t + Number(r.balance), 0);
  const overdue = shown.reduce((t, r) => t + Number(r.overdue_30), 0);
  return (
    <>
      <Banner>{error}</Banner>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Customer balances</h2>
        <span style={{ fontSize: 13 }}>Outstanding <b>{money(total)}</b> · over 30 days <b style={{ color: "var(--alert-red)" }}>{money(overdue)}</b></span>
        <label style={{ marginLeft: "auto", fontSize: 12.5, display: "flex", gap: 5, alignItems: "center" }}>
          <input type="checkbox" checked={onlyDue} onChange={(e) => setOnlyDue(e.target.checked)} style={{ width: "auto" }} /> Only with a balance
        </label>
        <input type="search" placeholder="Search customer" value={search} onChange={(e) => setSearch(e.target.value)} style={{ padding: "7px 10px", border: "1px solid var(--border-strong)", borderRadius: 7 }} />
      </div>
      {!rows ? <Empty>Loading…</Empty> : !shown.length ? <Empty>Nothing to show.</Empty> : (
        <Table minWidth={720} head={<>
          <th style={TH}>Customer</th><th style={{ ...TH, textAlign: "right" }}>Billed</th><th style={{ ...TH, textAlign: "right" }}>Received</th>
          <th style={{ ...TH, textAlign: "right" }}>Balance</th><th style={{ ...TH, textAlign: "right" }}>Over 30 days</th><th style={{ ...TH, textAlign: "right" }}>Advance</th><th style={TH}>Last receipt</th>
        </>}>
          {shown.map((r) => (
            <tr key={r.id} style={{ ...row, cursor: "pointer" }} onClick={() => go("ledger", { customer_id: String(r.id) })}>
              <td style={{ ...TD, fontWeight: 600 }}>{r.name}</td>
              <td style={NUM}>{inr2(r.billed)}</td>
              <td style={NUM}>{inr2(r.received)}</td>
              <td style={{ ...NUM, fontWeight: 700, color: Number(r.balance) > 0 ? "var(--charcoal)" : "var(--signal-green)" }}>{Number(r.balance) < 0 ? `${inr2(-r.balance)} Cr` : inr2(r.balance)}</td>
              <td style={{ ...NUM, color: Number(r.overdue_30) > 0 ? "var(--alert-red)" : "var(--slate)" }}>{Number(r.overdue_30) > 0 ? inr2(r.overdue_30) : "—"}</td>
              <td style={NUM}>{Number(r.unallocated) > 0.5 ? inr2(r.unallocated) : "—"}</td>
              <td style={{ ...TD, fontSize: 12 }}>{fmtDate(r.last_receipt_on)}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

function Statement({ customerId, go }) {
  const { can } = usePermissions();
  const [range, setRange] = useState({ from: "", to: "" });
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [receipt, setReceipt] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const qs = new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString();
    apiRequest(`/accounts/ledger/${customerId}?${qs}`).then(setD).catch((e) => setError(e.message));
  }, [customerId, range, tick]);

  async function applyAdvance() {
    setError(""); setMsg("");
    try {
      const r = await apiRequest(`/accounts/ledger/${customerId}/apply-advance`, { method: "POST" });
      setMsg(r.applied.length ? `Advance set against ${r.applied.map((a) => `${a.label} (₹${inr2(a.amount)})`).join(", ")}.` : "Nothing to set it against.");
      setTick((t) => t + 1);
    } catch (e) { setError(e.message); }
  }
  function exportXlsx() {
    const rows = [["Date", "Particulars", "Details", "Debit", "Credit", "Balance"]];
    if (d.opening_balance != null) rows.push([range.from, "Balance brought forward", "", "", "", d.opening_balance]);
    for (const l of d.lines) rows.push([l.on_date, l.particulars, l.detail || "", Number(l.debit) || "", Number(l.credit) || "", l.balance]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 11 }, { wch: 24 }, { wch: 48 }, { wch: 12 }, { wch: 12 }, { wch: 13 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ledger");
    XLSX.writeFile(wb, `Ledger - ${d.customer.name}.xlsx`);
  }

  if (error && !d) return <><button type="button" onClick={() => go("ledger")}>← All customers</button><Banner>{error}</Banner></>;
  if (!d) return <Empty>Loading…</Empty>;
  const pos = d.position;
  const inp = { padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 7, fontSize: 13 };
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <button type="button" onClick={() => go("ledger")}>← All customers</button>
        <h2 style={{ margin: 0, fontSize: 18 }}>{d.customer.name}</h2>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={inp} /> to
          <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={inp} />
          <button type="button" onClick={exportXlsx}>Excel</button>
          {can("accounts.bank-receipts", "create") && <button type="button" className="btn-primary" onClick={() => setReceipt(true)}>Record receipt</button>}
        </span>
      </div>
      <Banner>{error}</Banner><Banner kind="ok">{msg}</Banner>
      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 26, flexWrap: "wrap", fontSize: 13 }}>
        <div><div className="kpi-label">Balance</div><div style={{ fontSize: 22, fontWeight: 800 }}>{money(pos.balance, 2)}</div></div>
        <div><div className="kpi-label">Billed · received</div>{money(pos.billed)} · {money(pos.received)}</div>
        {Number(pos.unallocated) > 0.5 && (
          <div><div className="kpi-label">Advance not yet set</div>{money(pos.unallocated, 2)}
            {can("accounts.bank-receipts", "create") && <button type="button" style={{ marginLeft: 8, fontSize: 12, padding: "3px 8px" }} onClick={applyAdvance}>Set against invoices</button>}
          </div>
        )}
        {d.credit && (
          <div><div className="kpi-label">Credit ({d.credit.quote_no})</div>
            {d.credit.limit != null ? <>limit {money(d.credit.limit)} · {Number(pos.balance) > Number(d.credit.limit) ? <b style={{ color: "var(--alert-red)" }}>over by {money(pos.balance - d.credit.limit)}</b> : <>{money(d.credit.limit - pos.balance)} left</>}</> : "—"}
            {d.credit.days != null && <> · {d.credit.days} days</>}
          </div>
        )}
        <div><div className="kpi-label">Ageing of what is due</div>
          {Object.entries(d.aging).map(([k, v]) => <span key={k} style={{ marginRight: 10, color: k === "60+" && v > 0 ? "var(--alert-red)" : undefined }}>{k} d: <b>{money(v)}</b></span>)}
        </div>
      </div>
      <Table minWidth={760} head={<>
        <th style={TH}>Date</th><th style={TH}>Particulars</th><th style={TH}>Details</th>
        <th style={{ ...TH, textAlign: "right" }}>Debit</th><th style={{ ...TH, textAlign: "right" }}>Credit</th><th style={{ ...TH, textAlign: "right" }}>Balance</th>
      </>}>
        {d.opening_balance != null && (
          <tr style={row}><td style={TD}>{fmtDate(range.from)}</td><td style={{ ...TD, fontWeight: 600 }} colSpan={4}>Balance brought forward</td><td style={NUM}>{inr2(d.opening_balance)}</td></tr>
        )}
        {d.lines.map((l) => (
          <tr key={`${l.kind}-${l.id}`} style={row}>
            <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmtDate(l.on_date)}</td>
            <td style={{ ...TD, fontWeight: l.kind === "invoice" ? 600 : 400 }}>{l.particulars}</td>
            <td style={{ ...TD, fontSize: 12, color: "var(--slate)" }}>{l.detail}</td>
            <td style={NUM}>{Number(l.debit) ? inr2(l.debit) : ""}</td>
            <td style={{ ...NUM, color: "var(--signal-green)" }}>{Number(l.credit) ? inr2(l.credit) : ""}</td>
            <td style={{ ...NUM, fontWeight: 600 }}>{l.balance < 0 ? `${inr2(-l.balance)} Cr` : inr2(l.balance)}</td>
          </tr>
        ))}
        {!d.lines.length && <tr><td style={TD} colSpan={6}>No entries in this period.</td></tr>}
      </Table>
      {receipt && <ReceiptModal customerId={customerId} onClose={() => setReceipt(false)} onDone={(r) => { setReceipt(false); setMsg(`Receipt saved${r.applied.length ? ` — set against ${r.applied.map((a) => a.label).join(", ")}` : ""}${r.advance ? `; ₹${inr2(r.advance)} kept as advance` : ""}.`); setTick((t) => t + 1); }} />}
    </>
  );
}
