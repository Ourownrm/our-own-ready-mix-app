// Round 215 — maintenance payments: supplier bills from GRVs and workshop
// bills from outside repairs (an approved estimate can take an advance before
// the real bill). A bill held for the Administrator can't be paid.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { useLoad, useAction, Loading, Msg, Kpi, fmtRs, fmtDate, todayIst, H2, MUTED, ROW, GRID, Field, Table, SMALL_BTN } from "./mntUi.jsx";

const STATE = {
  on_hold: ["On hold — Administrator", "badge-danger"],
  overdue: ["Overdue", "badge-danger"],
  open: ["To pay", "badge-warning"],
  estimate: ["Estimate · advance only", "badge-info"],
  paid: ["Paid", "badge-success"],
};
const MODES = ["Bank transfer", "Cheque", "UPI", "Cash"];

export default function MntPayments() {
  const { can } = usePermissions();
  const bills = useLoad("/maintenance-module/bills");
  const [filter, setFilter] = useState("unpaid");
  const [sel, setSel] = useState(null);

  if (!bills.data) return <Loading error={bills.error} />;
  const all = bills.data;
  const shown = all.filter((b) => (filter === "unpaid" ? b.state !== "paid" : filter === "paid" ? b.state === "paid" : true));
  const sum = (f) => all.filter(f).reduce((s, b) => s + b.balance, 0);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(165px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Kpi label="To pay" value={fmtRs(sum((b) => ["open", "overdue"].includes(b.state)))} />
        <Kpi label="Overdue" value={fmtRs(sum((b) => b.state === "overdue"))} tone={sum((b) => b.state === "overdue") ? "bad" : undefined} />
        <Kpi label="On hold" value={all.filter((b) => b.state === "on_hold").length} tone={all.some((b) => b.state === "on_hold") ? "warn" : undefined} sub="bill above approved" />
        <Kpi label="Approved estimates" value={fmtRs(sum((b) => b.state === "estimate"))} sub="advances can be paid" />
      </div>
      <div style={{ ...ROW, marginBottom: 12 }}>
        {[["unpaid", "Unpaid"], ["paid", "Paid"], ["all", "All"]].map(([k, l]) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}
            style={{ padding: "7px 13px", fontSize: 12.5, borderRadius: 20, background: filter === k ? "var(--charcoal)" : "#fff", color: filter === k ? "#fff" : "var(--charcoal)" }}>{l}</button>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <section className="card" style={{ flex: "999 1 600px", minWidth: 0 }}>
          {shown.length === 0 ? <div style={MUTED}>No bills here.</div> : (
            <Table minWidth={720}>
              <thead><tr><th>Payee</th><th>Against</th><th>Bill</th><th>Due</th><th style={{ textAlign: "right" }}>Amount</th><th style={{ textAlign: "right" }}>Balance</th><th>State</th></tr></thead>
              <tbody>
                {shown.map((b) => (
                  <tr key={b.id} onClick={() => setSel(b.id)} style={{ cursor: "pointer", background: sel === b.id ? "var(--concrete)" : undefined }}>
                    <td><b>{b.payee}</b></td>
                    <td>{b.against}</td>
                    <td>{b.bill_no || "—"}<div style={MUTED}>{b.bill_date ? fmtDate(b.bill_date) : ""}</div></td>
                    <td>{b.due_date ? fmtDate(b.due_date) : "—"}</td>
                    <td style={{ textAlign: "right" }}>{fmtRs(b.amount, 2)}</td>
                    <td style={{ textAlign: "right" }}><b>{fmtRs(b.balance, 2)}</b></td>
                    <td><span className={`badge ${STATE[b.state][1]}`}>{STATE[b.state][0]}</span></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
        {sel && all.find((b) => b.id === sel) && (
          <BillPanel key={sel} bill={all.find((b) => b.id === sel)} canPay={can("mnt.payments", "create")} onClose={() => setSel(null)} onPaid={() => bills.load()} />
        )}
      </div>
    </>
  );
}

function BillPanel({ bill, canPay, onClose, onPaid }) {
  const pays = useLoad(`/maintenance-module/bills/${bill.id}/payments`, [bill.id, bill.paid]);
  const [f, setF] = useState({ amount: "", tds: "", paid_on: todayIst(), mode: "Bank transfer", reference: "" });
  const act = useAction(() => { pays.load(); onPaid(); setF({ ...f, amount: "", tds: "", reference: "" }); });

  return (
    <section className="card" style={{ flex: "1 1 340px", minWidth: 0 }}>
      <div style={ROW}>
        <h2 style={{ ...H2, flex: 1 }}>{bill.payee}</h2>
        <button type="button" style={SMALL_BTN} onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div style={MUTED}>{bill.against}{bill.note ? ` · ${bill.note}` : ""}</div>
      <div style={{ ...GRID(100), margin: "10px 0" }}>
        <div><div className="kpi-label">Amount</div><b>{fmtRs(bill.amount, 2)}</b></div>
        <div><div className="kpi-label">Paid</div><b>{fmtRs(bill.paid, 2)}</b></div>
        <div><div className="kpi-label">Balance</div><b>{fmtRs(bill.balance, 2)}</b></div>
      </div>
      {bill.state === "on_hold" && <div style={{ ...MUTED, color: "var(--alert-red)", marginBottom: 10 }}>The bill is above the approved amount — the Administrator has to approve it on the Outside tab before it can be paid.</div>}
      {bill.state === "estimate" && <div style={{ ...MUTED, marginBottom: 10 }}>Approved estimate — pay an advance here; the balance follows the real bill when the repair comes back.</div>}
      <Msg msg={act.msg} err={act.err} />
      {canPay && bill.state !== "on_hold" && bill.balance > 0 && (
        <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={GRID(130)}>
            <Field label="Amount ₹"><input inputMode="decimal" placeholder={String(bill.balance)} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="TDS ₹"><input inputMode="decimal" value={f.tds} onChange={(e) => setF({ ...f, tds: e.target.value })} /></Field>
            <Field label="Paid on"><input type="date" value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} /></Field>
            <Field label="Mode"><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>{MODES.map((m) => <option key={m}>{m}</option>)}</select></Field>
          </div>
          <Field label="Reference (UTR / cheque no.)" style={{ marginTop: 8 }}><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
          <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 10 }}>
            <button type="button" className="btn-primary" disabled={act.busy} onClick={() => act.run(() => apiRequest(`/maintenance-module/bills/${bill.id}/payments`, { method: "POST", body: f }), "Payment recorded.")}>Record payment</button>
          </div>
        </div>
      )}
      <h3 style={{ fontSize: 13, margin: "8px 0 4px" }}>Payments</h3>
      {!pays.data ? <div style={MUTED}>Loading…</div> : pays.data.length === 0 ? <div style={MUTED}>None yet.</div> : (
        <Table minWidth={300}>
          <tbody>
            {pays.data.map((p) => (
              <tr key={p.id}>
                <td>{fmtDate(p.paid_on)}<div style={MUTED}>{p.mode || ""}{p.reference ? ` · ${p.reference}` : ""} · {p.by_name}</div></td>
                <td style={{ textAlign: "right" }}>{fmtRs(p.amount, 2)}{Number(p.tds) > 0 && <div style={MUTED}>TDS {fmtRs(p.tds, 2)}</div>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
