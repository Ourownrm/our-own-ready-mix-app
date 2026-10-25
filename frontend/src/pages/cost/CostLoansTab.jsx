// Round 239 — Cost → Loans (owner, 25 Oct 2026: "better to move loans into a
// new page and provide more insights about each loan"). Every loan with what
// is owed, the next instalment, when it closes, the interest still to pay, the
// instalments found on the bank statements (interest / principal / balance
// after each) and the rest of the loan worked forward. Same permission as
// Bank statements (cost.bank). Rules: lib/bankBook.js (loansInsight).
import { useState } from "react";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { useCostData, Loading, Actions, BTN, Tile, Note, downloadExcel, rsL, num, fmtDay, H2, SUB, MUTED, R, NUM, GRID, panel } from "./costUi.jsx";
import { LoanModal } from "./CostBankTab.jsx";

const COLORS = ["#2F6B8A", "#C75B12", "#1D7A55", "#7A4FA0", "#B08A1E", "#4A525C", "#A23B5A", "#3E7F7A"];
const monthName = (ym) => new Date(`${ym}-15T00:00:00`).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
const fy = (ymd) => { const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7)); const s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, "0")}`; };

export default function CostLoansTab() {
  const { can } = usePermissions();
  const canEdit = can("cost.bank", "edit");
  const { data: d, error, reload } = useCostData("/cost/bank/loans");
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null);
  const [showClosed, setShowClosed] = useState(false);

  const head = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 14 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Loans</h1>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4 }}>What is owed on each loan, the next instalment, when it closes and what it costs · instalments found on the uploaded bank statements</div>
      </div>
      <Actions>
        <button type="button" style={BTN} disabled={!d} onClick={() => exportLoans(d)}>Export Excel</button>
        {canEdit && <button type="button" className="btn-primary" style={BTN} disabled={!d} onClick={() => setEdit({})}>Add a loan</button>}
      </Actions>
    </div>
  );
  if (!d) return <>{head}<div style={{ marginTop: 16 }}><Loading error={error} /></div></>;
  const s = d.summary;
  const active = d.loans.filter((l) => l.is_active);
  const closed = d.loans.filter((l) => !l.is_active);
  const shown = showClosed ? d.loans : active;
  const maxOut = Math.max(1, ...active.map((l) => l.outstanding || 0));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {head}
      {s.missing.length > 0 && (
        <Note>No instalment found on the uploaded bank statements for: {s.missing.map((m) => `${m.name} — ${m.months.map(monthName).join(", ")}`).join("; ")}. Upload that month’s statement, or check the EMI line was given this loan (Bank statements → the line → Loan EMI).</Note>
      )}
      {s.closing_12m.length > 0 && <Note tone="good">Closing within a year: {s.closing_12m.map((c) => `${c.name} (${fmtDay(c.closes)})`).join(", ")} — that EMI stops after it.</Note>}

      <div style={GRID(190)}>
        <Tile dark label="Owed on all loans" value={rsL(s.outstanding)} note={`${s.count} running loan${s.count === 1 ? "" : "s"} · average rate ${s.weighted_rate == null ? "—" : `${num(s.weighted_rate, 2)}%`}`} />
        <Tile label="Next month’s instalments" value={rsL(s.monthly)} note="all running loans, at today’s EMI / principal" />
        <Tile label={`Interest this year (FY ${fy(d.today)})`} value={rsL(s.fy_interest)} note={`principal repaid ${rsL(s.fy_principal)} · from ${fmtDay(d.fy_start)}`} />
        <Tile label="Principal due in 12 months" value={rsL(s.next12_principal)} note="what the loans come down by in a year" />
        <Tile label="Interest still to pay" value={rsL(s.interest_ahead)} note="if every loan runs to the end as now" />
      </div>

      {active.length > 0 && (
        <div style={panel("1 1 100%")}>
          <h2 style={H2}>Where the debt is</h2>
          <div style={SUB}>Owed today, largest first</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
            {[...active].sort((a, b) => (b.outstanding || 0) - (a.outstanding || 0)).map((l) => (
              <div key={l.id} style={{ display: "grid", gridTemplateColumns: "minmax(140px, 260px) 1fr auto", gap: 10, alignItems: "center", fontSize: 13 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.name}>{l.name}</span>
                <div style={{ height: 14, background: "var(--concrete)", borderRadius: 7, overflow: "hidden" }}>
                  <div style={{ width: `${((l.outstanding || 0) / maxOut) * 100}%`, height: "100%", background: COLORS[d.loans.indexOf(l) % COLORS.length], borderRadius: 7 }} />
                </div>
                <b style={{ ...NUM, whiteSpace: "nowrap" }}>{rsL(l.outstanding)} <span style={{ ...MUTED, fontWeight: 400 }}>{s.outstanding ? `${num(((l.outstanding || 0) / s.outstanding) * 100)}%` : ""}</span></b>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {shown.map((l) => <LoanCard key={l.id} l={l} color={COLORS[d.loans.indexOf(l) % COLORS.length]} open={open === l.id}
          onToggle={() => setOpen(open === l.id ? null : l.id)} canEdit={canEdit} onEdit={() => setEdit(l)} />)}
        {!d.loans.length && <div className="card" style={{ fontSize: 13 }}>No loans yet. Add each term and vehicle loan once — its EMIs on the bank statements are then split into interest and principal.</div>}
        {closed.length > 0 && <button type="button" onClick={() => setShowClosed(!showClosed)} style={{ alignSelf: "flex-start" }}>{showClosed ? "Hide closed loans" : `Show ${closed.length} closed loan(s)`}</button>}
      </div>

      <div style={{ ...MUTED, lineHeight: 1.6 }}>
        How it works — each loan is set up once with the balance (principal outstanding) on the day before the first bank statement uploaded. EMI loans: each instalment’s interest is the balance × rate × the days since the same date last month ÷ 365, as the lenders charge it; the rest of the EMI reduces the loan. Fixed-principal loans (e.g. KFC): the fixed principal reduces the loan and the rest of what was paid is interest — so any rebate or interest subsidy is already in. Interest typed on an EMI line (from the lender’s statement) is used as it is.
        “The rest of the loan” is worked forward from today’s balance at the rate and EMI entered on the loan — a guide, not the lender’s schedule. For a loan with a rebate or subsidy, enter the rate it really costs (e.g. 6.2%). Interest goes to the P&amp;L’s Finance cost in the month paid; the balance to the Balance Sheet’s Term &amp; vehicle loans.
      </div>

      {edit && <LoanModal d={{ accounts: d.accounts }} loan={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function LoanCard({ l, color, open, onToggle, canEdit, onEdit }) {
  const [all, setAll] = useState(false);
  const fixed = l.method === "fixed";
  const byFy = {};
  for (const p of l.projection) { const k = fy(p.date); byFy[k] = byFy[k] || { interest: 0, principal: 0, n: 0 }; byFy[k].interest += p.interest; byFy[k].principal += p.principal; byFy[k].n++; }
  const Fact = ({ label, value, sub }) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, ...NUM }}>{value}</div>
      {sub && <div style={MUTED}>{sub}</div>}
    </div>
  );
  return (
    <div style={{ ...panel("1 1 100%"), borderLeft: `4px solid ${color}`, opacity: l.is_active ? 1 : 0.7 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ ...H2, fontSize: 16 }}>{l.name}{!l.is_active && <span style={{ ...MUTED, fontWeight: 400 }}> · closed</span>}</h2>
          <div style={SUB}>{[l.lender, l.loan_no && `Loan ${l.loan_no}`, l.asset, fixed ? "fixed principal + interest" : "EMI", l.account && `paid from ${l.account}`].filter(Boolean).join(" · ")}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={onToggle} aria-expanded={open}>{open ? "Hide details" : "Details"}</button>
          {canEdit && <button type="button" onClick={onEdit}>Edit</button>}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14, marginTop: 14 }}>
        <Fact label="Owed today" value={l.outstanding == null ? "—" : `₹${num(l.outstanding)}`} sub={l.loan_amount ? `of ₹${num(l.loan_amount)} borrowed` : `₹${num(l.opening_outstanding)} on ${fmtDay(l.opening_date)}`} />
        <Fact label="Rate" value={`${num(l.rate_pct, 2)}%`} sub={l.effective_rate != null ? `last month it cost ≈ ${num(l.effective_rate, 2)}% (what was paid less the principal)` : l.interest_basis === "month" ? "rate ÷ 12 a month" : "interest by days"} />
        <Fact label={fixed ? "Principal a month" : "EMI"} value={`₹${num(fixed ? l.principal_amt : l.emi)}`} sub={fixed ? "plus that month’s interest" : null} />
        <Fact label="Next instalment" value={l.ahead.next_due ? fmtDay(l.ahead.next_due) : "—"} sub={l.ahead.next_amount ? `≈ ₹${num(l.ahead.next_amount)}` : null} />
        <Fact label="Closes" value={l.ahead.closes ? fmtDay(l.ahead.closes) : l.stalled ? "—" : "—"} sub={l.ahead.instalments ? `${l.ahead.instalments} instalment(s) left${l.end_date ? ` · lender: ${fmtDay(l.end_date)}` : ""}` : l.stalled ? "EMI does not cover the interest — check the EMI" : null} />
        <Fact label="Interest still to pay" value={`₹${num(l.ahead.interest)}`} sub={`this FY so far ₹${num(l.totals.fy_interest)}`} />
      </div>
      {l.repaid_pct != null && (
        <div style={{ marginTop: 12 }}>
          <div style={{ height: 10, background: "var(--concrete)", borderRadius: 5, overflow: "hidden" }}>
            <div style={{ width: `${Math.max(0, Math.min(100, l.repaid_pct))}%`, height: "100%", background: color }} />
          </div>
          <div style={{ ...MUTED, marginTop: 4 }}>{num(l.repaid_pct, 1)}% of the loan repaid</div>
        </div>
      )}
      {l.missing.length > 0 && <div style={{ ...MUTED, color: "var(--amber)", marginTop: 8 }}>No instalment found for {l.missing.map(monthName).join(", ")}.</div>}

      {open && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginTop: 16 }}>
          <div style={{ flex: "1 1 460px", minWidth: 0 }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Instalments found on the bank statements</h3>
            <div style={{ overflowX: "auto" }}>
              <table style={{ minWidth: 520 }}>
                <thead><tr><th>Date</th><th style={R}>Paid ₹</th><th style={R}>Interest ₹</th><th style={R}>Principal ₹</th><th style={R}>Balance after ₹</th></tr></thead>
                <tbody>
                  {l.history.map((h) => (
                    <tr key={h.id} style={{ color: h.before_start ? "var(--slate)" : undefined, background: h.extra ? "#FFF6E0" : undefined }}>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtDay(h.date)}{h.extra ? " †" : ""}</td>
                      <td style={R}>{num(h.paid)}</td>
                      <td style={R}>{h.interest == null ? "—" : num(h.interest)}{h.typed ? " *" : ""}</td>
                      <td style={R}>{h.principal == null ? "—" : num(h.principal)}</td>
                      <td style={R}>{h.balance == null ? "before the start date" : num(h.balance)}</td>
                    </tr>
                  ))}
                  {!l.history.length && <tr><td colSpan={5} style={{ color: "var(--slate)" }}>None yet — upload the bank statements from {fmtDay(l.opening_date)}.</td></tr>}
                </tbody>
                {l.history.length > 0 && <tfoot><tr><td>Total</td><td style={R}>{num(l.totals.paid)}</td><td style={R}>{num(l.totals.interest)}</td><td style={R}>{num(l.totals.principal)}</td><td /></tr></tfoot>}
              </table>
            </div>
            {l.history.some((h) => h.typed) && <div style={MUTED}>* interest typed from the lender’s statement</div>}
            {l.history.some((h) => h.extra) && <div style={{ ...MUTED, color: "var(--amber)" }}>† a second payment in the month after the principal was taken — all of it counted as interest. If it is another loan’s instalment (e.g. the other KFC loan), give it that loan on Bank statements (the line → Change → Loan EMI), or add that loan here so it is found by its amount.</div>}
          </div>
          <div style={{ flex: "1 1 460px", minWidth: 0 }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>The rest of the loan (worked forward)</h3>
            <div style={{ overflowX: "auto" }}>
              <table style={{ minWidth: 420 }}>
                <thead><tr><th>Year (Apr–Mar)</th><th style={R}>Instalments</th><th style={R}>Interest ₹</th><th style={R}>Principal ₹</th></tr></thead>
                <tbody>{Object.entries(byFy).map(([k, v]) => <tr key={k}><td>FY {k}</td><td style={R}>{v.n}</td><td style={R}>{num(v.interest)}</td><td style={R}>{num(v.principal)}</td></tr>)}</tbody>
                <tfoot><tr><td>Total</td><td style={R}>{l.ahead.instalments}</td><td style={R}>{num(l.ahead.interest)}</td><td style={R}>{num(l.ahead.paid - l.ahead.interest)}</td></tr></tfoot>
              </table>
            </div>
            <div style={{ overflowX: "auto", marginTop: 10, maxHeight: all ? "none" : 260, overflowY: all ? "visible" : "auto" }}>
              <table style={{ minWidth: 420 }}>
                <thead><tr><th>Due</th><th style={R}>Pay ₹</th><th style={R}>Interest ₹</th><th style={R}>Principal ₹</th><th style={R}>Balance ₹</th></tr></thead>
                <tbody>{(all ? l.projection : l.projection.slice(0, 12)).map((p) => (
                  <tr key={p.date}><td style={{ whiteSpace: "nowrap" }}>{fmtDay(p.date)}</td><td style={R}>{num(p.pay)}</td><td style={R}>{num(p.interest)}</td><td style={R}>{num(p.principal)}</td><td style={R}>{num(p.balance)}</td></tr>))}</tbody>
              </table>
            </div>
            {l.projection.length > 12 && <button type="button" onClick={() => setAll(!all)} style={{ marginTop: 8 }}>{all ? "Show the next 12 only" : `Show all ${l.projection.length}`}</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function exportLoans(d) {
  const rows = [["Loan", "Lender", "Loan no.", "Vehicle / asset", "Method", "Rate %", "Costing ≈ %", "EMI / principal ₹", "Owed today ₹", "Next due", "Next ₹", "Closes", "Instalments left", "Interest still to pay ₹", `Interest FY from ${d.fy_start} ₹`],
    ...d.loans.map((l) => [l.name, l.lender || "", l.loan_no || "", l.asset || "", l.method === "fixed" ? "Fixed principal + interest" : "EMI", l.rate_pct, l.effective_rate ?? "",
      l.method === "fixed" ? l.principal_amt : l.emi, l.outstanding, l.ahead.next_due || "", l.ahead.next_amount || "", l.ahead.closes || "", l.ahead.instalments, l.ahead.interest, l.totals.fy_interest])];
  const hist = [["Loan", "Date", "Paid ₹", "Interest ₹", "Principal ₹", "Balance after ₹"],
    ...d.loans.flatMap((l) => l.history.map((h) => [l.name, h.date, h.paid, h.interest ?? "", h.principal ?? "", h.balance ?? ""]))];
  const proj = [["Loan", "Due", "Pay ₹", "Interest ₹", "Principal ₹", "Balance ₹"],
    ...d.loans.flatMap((l) => l.projection.map((p) => [l.name, p.date, p.pay, p.interest, p.principal, p.balance]))];
  downloadExcel(`Loans ${d.today}.xlsx`, [{ name: "Loans", rows }, { name: "Instalments paid", rows: hist }, { name: "Worked forward", rows: proj }]);
}
