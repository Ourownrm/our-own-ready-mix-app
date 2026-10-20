// Round 218 — Balance Sheet as on a month end (or today, for this month).
// App lines come from the ledgers and stock; Entered lines are dated figures
// Accounts keys in, each in force until a later one is entered.
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import {
  useCostData, Loading, MonthSelect, Select, Actions, BTN, Tile, Src, SrcLegend, Note, Modal, downloadExcel,
  lakh, rsL, rs, num, H2, SUB, MUTED, R, NUM, ROW, GRID, panel, fmtDay, C,
} from "./costUi.jsx";

const AGE_COLOURS = { d0_7: C.left, d8_14: C.soft, d15_30: C.warn, d30p: C.bad };

export default function CostBSTab({ month, setMonth }) {
  const { can } = usePermissions();
  const [compare, setCompare] = useState("fy_start");
  const [entering, setEntering] = useState(false);
  const { data: d, error, reload } = useCostData(`/cost/balance-sheet?month=${month}&compare=${compare}`);
  const mayEnter = can("cost.entries", "edit");
  const head = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 14 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Balance Sheet{d ? ` — as on ${fmtDay(d.as_on)}` : ""}</h1>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4 }}>₹ lakh{d ? ` · compared with ${fmtDay(d.cmp_as_on)}` : ""}</div>
      </div>
      <Actions>
        <MonthSelect value={month} onChange={setMonth} label="As on the end of" />
        <Select label="Compare with" value={compare} onChange={setCompare} options={[
          { value: "fy_start", label: "31 March (start of the year)" }, { value: "prev", label: "Previous month end" }]} />
        {mayEnter && <button type="button" style={BTN} onClick={() => setEntering(true)}>Enter balances</button>}
        <button type="button" style={BTN} disabled={!d} onClick={() => exportBS(d)}>Export Excel</button>
        <button type="button" className="btn-primary" style={BTN} onClick={() => window.print()}>Print / PDF</button>
      </Actions>
    </div>
  );
  const modal = entering && <BalancesModal defaultDay={d?.as_on} onClose={() => setEntering(false)} onSaved={() => { setEntering(false); reload(); }} />;
  if (!d || d.month !== month) return <>{head}<div style={{ marginTop: 16 }}><Loading error={error} /></div>{modal}</>;

  const k = d.kpis;
  const sides = [["Liabilities & owners’ funds", d.liabilities], ["Assets", d.assets]];
  const totalAges = d.receivables.ages.reduce((t, a) => t + a.amount, 0);
  const wc = d.working_capital;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {head}
      <div style={GRID(190)}>
        <Tile dark label="Net worth" value={rsL(k.net_worth)} note={`${k.net_worth_change >= 0 ? "+" : "−"}₹${lakh(Math.abs(k.net_worth_change))} L since ${fmtDay(d.cmp_as_on)}`} />
        <Tile label="Loans" value={rsL(k.loans)} note={k.debt_to_worth == null ? "—" : `debt ÷ net worth ${num(k.debt_to_worth, 2)}`} />
        <Tile label="Cash & bank" value={rsL(k.cash)} note={`${fmtDay(d.cmp_as_on)}: ${rsL(k.cash_then)}`} />
        <Tile label="Customers owe" value={rsL(k.receivables)} note={`${rsL(k.over30)} over 30 days`} />
        <Tile label="We owe (trade)" value={rsL(k.trade_payables)} note="suppliers, transporters, workshops, contractors, others" />
        <Tile label="Current ratio" value={k.current_ratio == null ? "—" : num(k.current_ratio, 2)} note="current assets ÷ current liabilities" />
      </div>

      <div style={ROW}>
        {sides.map(([title, s]) => (
          <div key={title} style={panel("1 1 560px")}>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
              <h2 style={H2}>{title}</h2>{title === "Assets" && <SrcLegend />}
            </div>
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table style={{ minWidth: 500 }}>
                <thead><tr><th>Particulars</th><th style={R}>{fmtDay(d.as_on)}</th><th style={R}>{fmtDay(d.cmp_as_on)}</th><th style={R}>Change</th><th>Source</th></tr></thead>
                <tbody>
                  {s.rows.map((r, i) => r.kind === "head" ? (
                    <tr key={i}><td colSpan={5} style={{ paddingTop: 14, fontSize: 11.5, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4, borderBottom: "1px solid var(--border-strong)" }}>{r.label}</td></tr>
                  ) : (
                    <tr key={i} style={r.gap ? { background: "var(--alert-red-bg)" } : undefined}>
                      <td style={{ paddingLeft: 18, whiteSpace: "normal", color: r.gap ? "var(--alert-red)" : undefined, fontWeight: r.gap ? 700 : 400 }}>
                        {r.label}{r.missing && <span style={{ color: "var(--amber)", fontWeight: 600 }}> · not entered</span>}
                        {r.hint && <div style={{ ...MUTED, fontSize: 11, fontWeight: 400 }}>{r.hint}</div>}</td>
                      <td style={R}>{lakh(r.now)}</td>
                      <td style={{ ...R, color: "#4A525C" }}>{lakh(r.then)}</td>
                      <td style={{ ...R, color: "#4A525C" }}>{Math.abs(r.change) < 1 ? "—" : `${r.change > 0 ? "+" : "−"}${lakh(Math.abs(r.change))}`}</td>
                      <td><Src src={r.src} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr style={{ background: "#F7F5F0" }}><td style={{ fontWeight: 700 }}>Total</td><td style={{ ...R, fontWeight: 700 }}>{lakh(s.now)}</td>
                  <td style={{ ...R, fontWeight: 700 }}>{lakh(s.then)}</td><td style={{ ...R, fontWeight: 700 }}>{`${s.now - s.then >= 0 ? "+" : "−"}${lakh(Math.abs(s.now - s.then))}`}</td><td /></tr></tfoot>
              </table>
            </div>
          </div>
        ))}
      </div>

      {d.balanced ? (
        <Note tone="good"><b>Balanced:</b> assets ₹{lakh(d.assets.now)} L = liabilities &amp; owners’ funds ₹{lakh(d.liabilities.now)} L. If they ever differ, the gap is shown as its own red line, “Not yet reconciled”, never hidden in cash.</Note>
      ) : (
        <Note tone="bad"><b>Not yet reconciled: ₹{lakh(Math.abs(d.difference))} L.</b> The sides differ by this much. Usually an Entered figure is missing or out of date
          {d.missing.length ? ` (not entered: ${d.missing.join(", ")})` : ""}, or the opening figures were entered on a different date from the app’s records. It is shown as its own line, never hidden in cash.</Note>
      )}
      {d.notes.map((n, i) => <Note key={i}>{n}</Note>)}

      <div style={ROW}>
        <div style={panel("1 1 380px")}>
          <h2 style={H2}>Customers owe us — by age</h2>
          <div style={SUB}>{rsL(k.receivables)} · invoices and opening balances less receipts · age from the delivery date</div>
          <div role="img" aria-label={`Receivables by age, lakh: ${d.receivables.ages.map((a) => `${a.label} ${lakh(a.amount)}`).join(", ")}`}
            style={{ display: "flex", height: 26, borderRadius: 6, overflow: "hidden", gap: 2, marginTop: 14, background: "var(--concrete)" }}>
            {d.receivables.ages.map((a) => (totalAges > 0 && a.amount > 0 ? <div key={a.key} style={{ width: `${(a.amount / totalAges) * 100}%`, background: AGE_COLOURS[a.key] }} /> : null))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginTop: 12, fontSize: 12.5 }}>
            {d.receivables.ages.map((a) => (
              <div key={a.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: AGE_COLOURS[a.key], display: "inline-block" }} />
                {a.label} <b style={{ ...NUM, color: a.key === "d30p" ? "var(--alert-red)" : undefined }}>{lakh(a.amount)}</b></div>
            ))}
          </div>
          <div style={{ ...MUTED, fontSize: 12, marginTop: 10 }}>Over 30 days: {num(d.receivables.over30_customers)} customer(s).
            {d.receivables.advance > 0 && ` Customer advances ${rsL(d.receivables.advance)} sit on the other side.`}</div>
        </div>

        <div style={panel("1 1 380px")}>
          <h2 style={H2}>We owe — from the ledgers</h2>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 10, fontSize: 13 }}>
            {d.payables.map((p) => (
              <div key={p.label} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                <span>{p.label} <span style={{ ...MUTED }}>· {p.src}</span></span><b style={NUM}>{lakh(p.amount)}</b></div>
            ))}
          </div>
          {d.supplier_overdue > 0 && <div style={{ ...MUTED, fontSize: 12, marginTop: 8 }}>Overdue to raw-material suppliers: <b style={{ color: "var(--alert-red)" }}>{rsL(d.supplier_overdue)}</b> · oldest {num(d.supplier_oldest_late)} days late</div>}
          <div style={{ ...MUTED, fontSize: 12, marginTop: 6 }}>TDS deducted on contractor bills is in GST/TDS payable.</div>
        </div>

        <div style={panel("1 1 380px")}>
          <h2 style={H2}>Working capital cycle</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 12 }}>
            {[["Customers pay in", wc.receivable_days], ["Material in stock", wc.stock_days], ["We pay suppliers in", wc.payable_days]].map(([l, v]) => (
              <div key={l} style={{ background: "#F7F5F0", borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 11, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.3 }}>{l}</div>
                <div style={{ fontSize: 20, fontWeight: 700, ...NUM }}>{v == null ? "—" : `${num(v)} days`}</div></div>
            ))}
          </div>
          {wc.cycle != null && (
            <div style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.5 }}>
              Cash is tied up for <b>{num(wc.cycle)} days</b> ({num(wc.receivable_days)} + {num(wc.stock_days)} − {num(wc.payable_days)}).
              Every day customers pay sooner frees about <b>{rsL(wc.per_day_sales)}</b>.
            </div>
          )}
          <div style={{ ...MUTED, marginTop: 8 }}>On this month’s sales (incl. GST), raw-material consumption and purchases.</div>
        </div>
      </div>

      <div style={{ ...MUTED, lineHeight: 1.6 }}>
        App lines come straight from the modules: raw material at book stock × weighted average rate; diesel at the tank’s book stock; the Maintenance store, lubricants, and tyres &amp; batteries in store;
        customers and their advances from invoices, opening balances and receipts; suppliers and transporters from their ledgers; workshops and certificate fees from Maintenance → Payments;
        labour contractors from approved bills less payments; salaries and advances from HR; prepaid road tax and insurance from each certificate’s unused days; this year’s profit and tax from the Profit &amp; Loss.
        Entered lines — fixed assets, loans, capital, bank, GST and tax — are set once and updated at month ends by Accounts; each figure stays in force until a later one is entered.
        Retained profit = the figure entered on {d.retained.opening_as_on ? fmtDay(d.retained.opening_as_on) : "—"} ({rsL(d.retained.opening)}) + profit since ({rsL(d.retained.pat)}).
      </div>
      {modal}
    </div>
  );
}

function monthEnd(ymd) {
  const [y, m] = ymd.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ymd.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

function BalancesModal({ defaultDay, onClose, onSaved }) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const [day, setDay] = useState(defaultDay && defaultDay <= today ? defaultDay : today);
  const [data, setData] = useState(null);
  const [vals, setVals] = useState({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    setData(null); setErr("");
    apiRequest(`/cost/balances?as_on=${day}`).then((d) => {
      setData(d);
      setVals(Object.fromEntries(d.lines.map((l) => [l.key, l.value != null ? String(l.value) : ""])));
    }).catch((e) => setErr(e.message));
  }, [day]);
  async function save() {
    setBusy(true); setErr("");
    try {
      const values = {};
      for (const l of data.lines) {
        const v = (vals[l.key] || "").trim();
        if (v === "" && l.value == null) continue;
        values[l.key] = v === "" ? null : Number(v.replace(/,/g, ""));
      }
      await apiRequest("/cost/balances", { method: "PUT", body: { as_on: day, values, note } });
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Balance Sheet figures" onClose={onClose} width={760}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4 }}>As on
          <input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)}
            style={{ padding: "8px 10px", fontSize: 13, border: "1px solid var(--border-strong)", borderRadius: 7, minHeight: 40 }} /></label>
        <button type="button" style={{ padding: "8px 11px", fontSize: 12.5 }} onClick={() => setDay(monthEnd(day))}>Month end</button>
        <div style={{ ...MUTED, flex: 1, minWidth: 220 }}>In rupees. Enter only what changed — a figure stays in force until a later date has its own. Retained profit is entered once, at the date the app takes over (e.g. 31 March); profit after it comes from the P&amp;L.</div>
      </div>
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{err}</div>}
      {!data ? <div style={MUTED}>Loading…</div> : (
        <>
          {data.lines.map((l) => (
            <div key={l.key} style={{ display: "grid", gridTemplateColumns: "minmax(170px, 1.3fr) minmax(130px, 1fr) minmax(130px, 1fr)", gap: 10, alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
              <label htmlFor={`cb-${l.key}`} style={{ fontSize: 13 }}><b style={{ fontWeight: 600 }}>{l.label}</b>
                <span style={{ ...MUTED, fontSize: 11 }}> · {l.side === "liab" ? "liability" : "asset"}</span>{l.hint && <div style={{ ...MUTED, fontSize: 11 }}>{l.hint}</div>}</label>
              <input id={`cb-${l.key}`} inputMode="decimal" value={vals[l.key] ?? ""} placeholder={l.in_force ? "unchanged" : "not entered"}
                onChange={(e) => setVals({ ...vals, [l.key]: e.target.value })}
                style={{ padding: "8px 10px", fontSize: 13, border: "1px solid var(--border-strong)", borderRadius: 7, minHeight: 40, textAlign: "right", ...NUM }} />
              <div style={{ ...MUTED, fontSize: 11.5 }}>{l.in_force ? `In force: ${rs(l.in_force.amount)} from ${fmtDay(l.in_force.as_on)}` : "Nothing entered yet"}</div>
            </div>
          ))}
          <label style={{ display: "block", marginTop: 12, fontSize: 12.5 }}>Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. from Tally trial balance"
              style={{ display: "block", width: "100%", marginTop: 4, padding: "8px 10px", fontSize: 13, border: "1px solid var(--border-strong)", borderRadius: 7, minHeight: 40 }} />
          </label>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
          </div>
          {data.log.length > 0 && (
            <details style={{ marginTop: 14 }}>
              <summary style={{ fontSize: 12.5, cursor: "pointer" }}>Recent changes ({data.log.length})</summary>
              <ul style={{ fontSize: 12, paddingLeft: 18, margin: "6px 0 0" }}>
                {data.log.map((g, i) => (
                  <li key={i}>{fmtDay(String(g.period))} · {g.label}: {g.old_amount == null ? "—" : rs(g.old_amount)} → {g.new_amount == null ? "cleared" : rs(g.new_amount)} · {g.by_name || "—"}{g.note ? ` · ${g.note}` : ""}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Modal>
  );
}

function exportBS(d) {
  const L = (v) => (v == null ? "" : Math.round(v) / 100000);
  const rows = [[`Balance Sheet — as on ${d.as_on}`], [`₹ lakh · compared with ${d.cmp_as_on}`], []];
  for (const [title, s] of [["LIABILITIES & OWNERS’ FUNDS", d.liabilities], ["ASSETS", d.assets]]) {
    rows.push([title], ["Particulars", d.as_on, d.cmp_as_on, "Change", "Source"]);
    for (const r of s.rows) rows.push(r.kind === "head" ? [r.label] : [r.label, L(r.now), L(r.then), L(r.change), r.src === "app" ? "App" : r.src === "entered" ? "Entered" : "Check"]);
    rows.push(["Total", L(s.now), L(s.then), L(s.now - s.then)], []);
  }
  rows.push(["Receivables by age"], ...d.receivables.ages.map((a) => [a.label, L(a.amount)]));
  downloadExcel(`Balance Sheet ${d.as_on}.xlsx`, [{ name: "Balance Sheet", rows }]);
}
