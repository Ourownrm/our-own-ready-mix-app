// Round 223 — Cost → Bank statements (owner, 21 Oct 2026; mock-up "Bank
// statements — Monthly"). Upload each account's statement (PDF e-statement,
// or Excel / CSV), give every line a treatment: a cost head (ADDED to that
// cost in the P&L — e.g. a repair paid outside a job card adds to the
// maintenance cost), left out because the app already has that exact payment,
// own transfer, loan EMI (split into interest and principal), tax, asset …
// Rules: lib/bankBook.js.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import {
  useCostData, Loading, MonthSelect, Actions, BTN, Tile, Note, downloadExcel, Modal,
  rsL, rs, num, fmtDay, H2, SUB, MUTED, R, NUM, GRID, ROW, panel,
} from "./costUi.jsx";

const T = {
  todo: { label: "To categorise", bg: "#FFF1D6", fg: "#5C3D00" },
  check: { label: "Check", bg: "#FFF1D6", fg: "#5C3D00" },
  cost: { label: "Cost", bg: "var(--signal-green-bg)", fg: "#155C40" },
  omit: { label: "Left out", bg: "#ECEAE4", fg: "#3F4750" },
  own: { label: "Own transfer", bg: "#ECEAE4", fg: "#3F4750" },
  loan: { label: "Loan EMI", bg: "#E2EAF6", fg: "#1F4A82" },
  tax: { label: "Tax", bg: "#ECEAE4", fg: "#3F4750" },
  asset: { label: "Fixed asset", bg: "#EDE6F4", fg: "#55357A" },
  capital: { label: "Capital", bg: "#EDE6F4", fg: "#55357A" },
  personal: { label: "Personal", bg: "#ECEAE4", fg: "#3F4750" },
  // Round 235
  pay: { label: "To a ledger", bg: "#E2EAF6", fg: "#1F4A82" },
  cert: { label: "Vehicle certificate", bg: "#FCE9DC", fg: "#8A3E0B" },
};
const PAY_KINDS = [
  ["supplier", "Supplier payment", "Supplier ledger"], ["transporter", "Transporter payment", "Transporter ledger"],
  ["contractor", "Contractor / pump gang", "Contractor ledger (HR)"], ["maintenance", "Maintenance bill (repair, spares, PO)", "Maintenance → Payments"],
];
const LEAVE = [
  ["omit", "Already in the app"], ["own", "Own transfer (between our accounts)"], ["tax", "Tax — GST / TDS / income tax"],
  ["personal", "Owner’s / personal"], ["capital", "Capital brought in / taken out"],
];
const KIND = { current: "Current account", savings: "Savings account", cc: "Cash credit", od: "Overdraft" };
const FILTERS = [
  ["all", "All", () => true], ["open", "To categorise", (l) => l.treatment === "todo" || l.treatment === "check"],
  ["cost", "Costs", (l) => l.treatment === "cost"], ["loan", "Loan EMIs", (l) => l.treatment === "loan"],
  ["posted", "To ledgers", (l) => l.treatment === "pay" || l.treatment === "cert"],
  ["omit", "Left out", (l) => l.treatment === "omit"], ["own", "Own transfers", (l) => l.treatment === "own"],
  ["other", "Tax, assets, other", (l) => ["tax", "asset", "capital", "personal"].includes(l.treatment)],
];
const SKIP = /^(NEFT|RTGS|IMPS|UPI|MMT|INF|INFT|NFT|TRF|TRANSFER|CLG|CHQ|CHEQUE|BY|TO|CR|DR|FROM|PAYMENT|ACH|POS|ECS|NACH|INB|BIL|ONL|NA|NIL|OKAXIS|OKICICI|OKSBI|OKHDFCBANK|YBL|IBL)$/;
// A word to remember for "always": the name part of the narration.
function keywordFrom(narr) {
  const parts = String(narr || "").toUpperCase().split(/[/|\\\-:]+/).map((p) => p.replace(/\s+/g, " ").trim());
  for (const p of parts) {
    if (!p || /\d{4,}/.test(p) || SKIP.test(p)) continue;
    if (/OUR OWN/.test(p)) continue;
    if (p.replace(/[^A-Z]/g, "").length < 4) continue;
    return p.replace(/[^A-Z0-9 &.]/g, "").trim().slice(0, 60);
  }
  return "";
}

export default function CostBankTab({ month, setMonth }) {
  const { can } = usePermissions();
  const canEdit = can("cost.bank", "edit");
  const { data: d, error, reload } = useCostData(`/cost/bank?month=${month}`);
  const [filter, setFilter] = useState("all");
  const [acc, setAcc] = useState("");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(100);
  const [modal, setModal] = useState(null);   // upload | accounts | loan:{} | rules
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const lines = useMemo(() => {
    if (!d) return [];
    const f = FILTERS.find((x) => x[0] === filter)[2];
    const qq = q.trim().toUpperCase();
    return d.lines.filter((l) => f(l) && (!acc || String(l.account_id) === acc) && (!qq || `${l.narration} ${l.reference || ""} ${l.debit || l.credit}`.toUpperCase().includes(qq)));
  }, [d, filter, acc, q]);

  async function resort() {
    setBusy(true); setErr(""); setMsg("");
    try { const r = await apiRequest("/cost/bank/resort", { method: "POST" }); setMsg(`Sorted ${num(r.sorted)} line(s) again against what the app has now. Lines you set by hand were not touched.`); reload(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const head = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 14 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Bank statements — {d && d.month === month ? d.label : "Monthly"}</h1>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4 }}>Every account’s statement in one list · each line added to a cost head, posted to a party’s ledger, or left out because the app already has it</div>
      </div>
      <Actions>
        <MonthSelect value={month} onChange={setMonth} />
        {canEdit && <button type="button" style={BTN} disabled={busy} onClick={resort}>Sort again</button>}
        <button type="button" style={BTN} disabled={!d} onClick={() => exportLines(d)}>Export Excel</button>
        {canEdit && <button type="button" className="btn-primary" style={BTN} onClick={() => setModal("upload")}>Upload statement</button>}
      </Actions>
    </div>
  );
  if (!d || d.month !== month) return <>{head}<div style={{ marginTop: 16 }}><Loading error={error} /></div></>;
  const s = d.summary;
  const open = (s.by.todo?.n || 0) + (s.by.check?.n || 0);
  const openAmt = (s.by.todo?.dr || 0) + (s.by.todo?.cr || 0) + (s.by.check?.dr || 0) + (s.by.check?.cr || 0);
  const behind = d.accounts.filter((a) => a.is_active && (!a.covered_to || a.covered_to < d.day_end));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {head}
      {msg && <Note tone="good">{msg}</Note>}
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
      {behind.length > 0 && (
        <Note>Statements not uploaded to {fmtDay(d.day_end)} yet: {behind.map((a) => `${a.name} (${a.covered_to ? `up to ${fmtDay(a.covered_to)}` : "none yet"})`).join("; ")}. Costs paid from those days are not in the P&amp;L until they are.</Note>
      )}

      <div style={GRID(250)}>
        {d.accounts.filter((a) => a.is_active).map((a) => {
          const ok = a.covered_to && a.covered_to >= d.day_end;
          return (
            <div key={a.id} style={{ ...panel("1 1 250px"), padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <b style={{ fontSize: 14 }}>{a.name}</b>
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 20, whiteSpace: "nowrap", height: "fit-content",
                  background: ok ? "var(--signal-green-bg)" : "#FFF1D6", color: ok ? "#155C40" : "#5C3D00" }}>{ok ? "Up to date" : a.covered_to ? `to ${fmtDay(a.covered_to)}` : "No statement"}</span>
              </div>
              <div style={MUTED}>{KIND[a.kind]}{a.label ? ` · ${a.label}` : ""}</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, ...NUM }}>{a.closing == null ? "—" : `${a.closing < 0 ? "−" : ""}₹${num(Math.abs(a.closing), 2)}`}</div>
              <div style={MUTED}>balance on {fmtDay(d.day_end)} · {num(a.lines_month)} line(s) this month</div>
            </div>
          );
        })}
        {canEdit && (
          <button type="button" onClick={() => setModal("accounts")} style={{ ...panel("1 1 250px"), border: "1.5px dashed var(--border-strong)", boxShadow: "none", color: "var(--slate)", fontSize: 13, minHeight: 100 }}>
            Bank accounts — add or change
          </button>
        )}
      </div>

      <div style={GRID(190)}>
        <Tile label="Statement lines" value={num(s.lines)} note={`${rsL(s.debits)} out · ${rsL(s.credits)} in`} />
        <Tile label="Left out — in the app" value={rsL((s.by.omit?.dr || 0) + (s.by.omit?.cr || 0))} note={`${num(s.by.omit?.n || 0)} lines matched to the app’s records`} />
        <Tile label="Own transfers" value={rsL((s.by.own?.dr || 0))} note={`${num(s.by.own?.n || 0)} lines between our accounts`} />
        <Tile label="Posted to ledgers" value={rsL((s.by.pay?.dr || 0) + (s.by.cert?.dr || 0))} note={`${num((s.by.pay?.n || 0) + (s.by.cert?.n || 0))} payments to suppliers, transporters, contractors, bills, certificates`} />
        <Tile label="Loan EMIs" value={rsL(s.by.loan?.dr || 0)} note={`interest ${rsL(s.loan_interest)} · principal ${rsL(s.loan_principal)}`} />
        <Tile dark label="To the P&L" value={rsL(s.to_pl)} note={`${s.heads.filter((h) => h.amount && h.key !== "other_income").length} cost heads${s.other_income ? ` · other income ${rsL(s.other_income)}` : ""}`} />
        <Tile label="To categorise" value={num(open)} note={open ? `${rsL(openAmt)} not in any head yet` : "all lines sorted"} />
      </div>

      <div style={{ ...ROW, alignItems: "flex-start" }}>
        <div style={panel("3 1 720px")}>
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
            <h2 style={H2}>Statement lines</h2>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {FILTERS.map(([k, label, f]) => {
                const n = d.lines.filter(f).length;
                const on = filter === k;
                return (
                  <button key={k} type="button" onClick={() => { setFilter(k); setShown(100); }} aria-pressed={on}
                    style={{ padding: "6px 12px", minHeight: 34, fontSize: 12.5, borderRadius: 999, border: `1px solid ${on ? "var(--charcoal)" : k === "open" && n ? "#D9A93A" : "var(--border-strong)"}`,
                      background: on ? "var(--charcoal)" : k === "open" && n ? "#FFF1D6" : "var(--surface)", color: on ? "#fff" : "var(--charcoal)" }}>
                    {label} {n}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, ...MUTED, fontWeight: 600 }}>Account
              <select value={acc} onChange={(e) => setAcc(e.target.value)} style={{ minHeight: 38 }}>
                <option value="">All accounts</option>
                {d.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, ...MUTED, fontWeight: 600, flex: "1 1 220px" }}>Search
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="narration, cheque no., amount" style={{ minHeight: 38 }} />
            </label>
          </div>
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table style={{ minWidth: 960 }}>
              <thead><tr><th>Date</th><th>Account</th><th>Narration</th><th style={R}>Debit ₹</th><th style={R}>Credit ₹</th><th style={{ minWidth: 290 }}>Treatment</th></tr></thead>
              <tbody>
                {lines.slice(0, shown).map((l) => (
                  <tr key={l.id} style={{ background: l.treatment === "todo" || l.treatment === "check" ? "#FFFBF0" : undefined, verticalAlign: "top" }}>
                    <td style={{ whiteSpace: "nowrap", ...NUM }}>{fmtDay(l.txn_date)}</td>
                    <td style={{ fontSize: 12, color: "#4A525C", whiteSpace: "nowrap" }}>{l.account}</td>
                    <td style={{ whiteSpace: "normal", fontSize: 12.5, minWidth: 240, maxWidth: 340, overflowWrap: "anywhere" }}>{l.narration}{l.reference ? <div style={MUTED}>Ref {l.reference}</div> : null}</td>
                    <td style={R}>{l.debit ? num(l.debit, 2) : ""}</td>
                    <td style={{ ...R, color: "var(--signal-green)" }}>{l.credit ? num(l.credit, 2) : ""}</td>
                    <td style={{ whiteSpace: "normal", minWidth: 280, maxWidth: 340 }}><Treat l={l} d={d} canEdit={canEdit} onDone={(m) => { setMsg(m || ""); reload(); }} /></td>
                  </tr>
                ))}
                {lines.length === 0 && (
                  <tr><td colSpan={6} style={{ color: "var(--slate)", whiteSpace: "normal" }}>
                    {d.lines.length ? "No lines here." : (() => {
                      // Round 228 — say where the uploaded lines are, with a way there.
                      const months = [...new Set(d.uploads.flatMap((u) => [u.period_from, u.period_to]).filter(Boolean).map((x) => x.slice(0, 7)))].filter((m) => m !== d.month).sort().reverse().slice(0, 6);
                      return (
                        <>No statement lines dated in {d.label}.{months.length ? <> Uploaded statements have lines in:{" "}
                          {months.map((m) => <button key={m} type="button" onClick={() => setMonth(m)} style={{ fontSize: 12, padding: "3px 10px", minHeight: 30, marginRight: 6 }}>
                            {new Date(`${m}-15T00:00:00`).toLocaleDateString("en-IN", { month: "short", year: "numeric" })}</button>)}</> : " Upload a statement."}</>
                      );
                    })()}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {lines.length > shown && <button type="button" style={{ marginTop: 10 }} onClick={() => setShown((x) => x + 200)}>Show more ({num(lines.length - shown)} left)</button>}
          <div style={{ ...MUTED, marginTop: 8 }}>Every treatment can be changed. A line left out is kept — it is only not counted again.</div>
        </div>

        <div style={{ flex: "1 1 340px", minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={panel("0 0 auto")}>
            <h2 style={H2}>What goes to the Profit &amp; Loss</h2>
            <div style={SUB}>{d.label} · added to what the app already records for each head · without GST{s.gst_input ? ` (input GST ${rsL(s.gst_input)} taken out)` : ""}</div>
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>P&amp;L line</th><th style={R}>₹ L</th><th style={R}>Lines</th></tr></thead>
              <tbody>
                {s.heads.filter((h) => h.amount || h.n).map((h) => (
                  <tr key={h.key}><td style={{ whiteSpace: "normal" }}>{h.label}{h.loan ? <div style={MUTED}>incl. EMI interest {rsL(h.loan)}</div> : null}</td>
                    <td style={{ ...R, fontWeight: 600 }}>{(h.amount / 100000).toFixed(2)}</td><td style={{ ...R, color: "#4A525C" }}>{h.n}</td></tr>
                ))}
                {!s.heads.some((h) => h.amount || h.n) && <tr><td colSpan={3} style={{ color: "var(--slate)" }}>Nothing yet.</td></tr>}
              </tbody>
              <tfoot><tr><td>Costs from the bank</td><td style={R}>{(s.to_pl / 100000).toFixed(2)}</td><td /></tr></tfoot>
            </table>
            <div style={{ ...MUTED, marginTop: 8 }}>Repairs here are added to the job-card cost, fuel to the Fuel module’s, and so on. Power, rent, admin, selling and finance cost no longer need typing in — if they are typed in too, the P&amp;L warns that both are counted.</div>
          </div>
          <div style={panel("0 0 auto")}>
            <h2 style={H2}>Posted to ledgers</h2>
            <div style={SUB}>Payments given a party here go into that party’s ledger (not a cost — the material, freight, labour or repair cost comes from its own record). Road tax and insurance renew the certificate; the P&amp;L spreads the fee over the period it covers.</div>
            <div style={{ display: "flex", flexDirection: "column", marginTop: 8, fontSize: 13 }}>
              {(s.posted || []).map((o) => (
                <div key={o.kind} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ minWidth: 0 }}>{o.where}<span style={{ display: "block", ...MUTED }}>{o.n} line(s)</span></span>
                  <b style={{ whiteSpace: "nowrap", ...NUM }}>{rsL(o.amount)}</b>
                </div>
              ))}
              {!(s.posted || []).length && <div style={{ color: "var(--slate)" }}>Nothing posted this month.</div>}
            </div>
            <ManualSwitch d={d} reload={reload} />
          </div>
          <div style={panel("0 0 auto")}>
            <h2 style={H2}>Left out — already in the app</h2>
            <div style={SUB}>Only when the same payment is in the app’s records (amount, and the date within 3 days). Never because of the kind of payment.</div>
            <div style={{ display: "flex", flexDirection: "column", marginTop: 8, fontSize: 13 }}>
              {s.omitted.map((o) => (
                <div key={o.label} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ minWidth: 0 }}>{o.label}<span style={{ display: "block", ...MUTED }}>{o.where} · {o.n} line(s)</span></span>
                  <b style={{ whiteSpace: "nowrap", ...NUM }}>{rsL(o.amount)}</b>
                </div>
              ))}
              {!s.omitted.length && <div style={{ color: "var(--slate)" }}>Nothing left out this month.</div>}
            </div>
          </div>
        </div>
      </div>

      <Loans d={d} canEdit={canEdit} onEdit={(l) => setModal({ loan: l })} />
      <Rules d={d} canEdit={canEdit} reload={reload} onAdd={() => setModal("rule")} />
      <Uploads d={d} canEdit={canEdit} reload={reload} setMsg={setMsg} />

      <div style={{ ...MUTED, lineHeight: 1.6 }}>
        How it works — each line is first checked against the app’s own records (customer receipts, supplier and transporter payments, payroll, contractor and maintenance payments, fuel and store purchases): the same amount within 3 days is left out so nothing is counted twice; 4–15 days apart it is marked Check for you to decide.
        Transfers between our own accounts are found by account number. A loan EMI is split: interest = balance outstanding × rate ÷ 12 goes to Finance cost, the rest reduces the loan on the Balance Sheet. Rules (ticked “always”) sort the rest; anything left waits under To categorise.
        A line given a cost head is added to that head of the P&amp;L and the Cost dashboard for the month of its date.
      </div>

      {modal === "upload" && <UploadModal d={d} onClose={() => setModal(null)} onDone={(m, to) => {
        // Round 227 — open the month the statement ends in (the page was on
        // another month, so a fresh upload looked like "no lines").
        setModal(null); setFilter("all"); setAcc(""); setQ("");
        const ym = to ? to.slice(0, 7) : month;
        const now = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
        const target = ym > now ? now : ym;
        setMsg(target !== month ? `${m} Showing ${new Date(`${target}-15T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" })} — the month the statement ends in.` : m);
        if (target !== month) setMonth(target); else reload();
      }} />}
      {modal === "accounts" && <AccountsModal d={d} onClose={() => { setModal(null); reload(); }} />}
      {modal === "rule" && <RuleModal d={d} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal?.loan && <LoanModal d={d} loan={modal.loan} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
    </div>
  );
}

// ------------------------------------------------- one line's treatment ---
function headLabel(d, key) { return d.heads_meta.find((h) => h.key === key)?.label || key; }
function Badge({ t }) {
  const x = T[t] || T.todo;
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: x.bg, color: x.fg, whiteSpace: "nowrap" }}>{x.label}</span>;
}
function Treat({ l, d, canEdit, onDone }) {
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function setOmit() {
    setBusy(true); setErr("");
    try { await apiRequest(`/cost/bank/lines/${l.id}`, { method: "PUT", body: { treatment: "omit" } }); onDone(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  async function reset() {
    if (l.post_kind && !window.confirm(`This takes the payment back out of the ${l.post_kind === "certificate" ? "compliance register" : "ledger"}. Go ahead?`)) return;
    setBusy(true); setErr("");
    try { await apiRequest(`/cost/bank/lines/${l.id}/reset`, { method: "POST" }); onDone(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  if (canEdit && (edit || l.treatment === "todo")) return <Editor l={l} d={d} onCancel={l.treatment === "todo" ? null : () => setEdit(false)} onDone={onDone} />;
  const what = l.treatment === "cost" ? headLabel(d, l.head)
    : l.treatment === "loan" ? (l.loan_name || "Loan")
      : l.treatment === "omit" ? "Already in the app"
        : l.treatment === "pay" || l.treatment === "cert" ? (l.party_label || "") : "";
  return (
    <div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Badge t={l.treatment} /> {what && <b style={{ fontSize: 12.5 }}>{what}</b>}
      </div>
      {l.treatment === "loan" && l.interest != null && <div style={{ ...MUTED, ...NUM }}>interest {rs(l.interest)}{l.interest_fixed ? " (from the bank)" : ""} · principal {rs(l.principal)}</div>}
      {l.treatment === "cost" && l.head !== "other_income" && l.debit > 0 && (
        <div style={{ ...MUTED, ...NUM }}>
          {l.gst > 0 ? <>cost {rs(l.net)} + GST {rs(l.gst)} ({Number(l.gst_pct)}%)</> : Number(l.gst_pct) > 0 && l.gst_claim === false ? <>GST {Number(l.gst_pct)}% — no input credit, all cost</> : <>no GST</>}
        </div>
      )}
      {l.why && <div style={MUTED}>{l.why}</div>}
      {l.manual && <div style={MUTED}>set by {l.set_by_name || "hand"}{l.note ? ` — ${l.note}` : ""}</div>}
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 12 }}>{err}</div>}
      {canEdit && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
          {l.treatment === "check" && <button type="button" disabled={busy} onClick={setOmit} style={{ fontSize: 12, padding: "4px 10px", minHeight: 32 }}>Yes, already in the app</button>}
          <button type="button" disabled={busy} onClick={() => setEdit(true)} style={{ fontSize: 12, padding: "4px 10px", minHeight: 32 }}>{l.treatment === "check" ? "No — add to a cost" : "Change"}</button>
          {l.manual && <button type="button" disabled={busy} onClick={reset} style={{ fontSize: 12, padding: "4px 10px", minHeight: 32 }}>Let the app sort it</button>}
        </div>
      )}
    </div>
  );
}

// Round 232 — the GST inside a payment: only the amount without it goes to
// the cost head (the P&L leaves GST out everywhere).
const headGstOf = (d, head) => d.heads_meta.find((h) => h.key === head)?.gst ?? 0;
function GstPicker({ d, head, amount, pct, setPct, claim, setClaim }) {
  const rates = d.gst_rates || [0, 5, 12, 18, 28];
  const p = pct === "" || pct == null ? headGstOf(d, head) : Number(pct);
  const net = claim && p > 0 && amount ? Math.round((amount * 100 / (100 + p)) * 100) / 100 : amount;
  return (
    <div style={{ ...MUTED, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      GST in this payment
      <select aria-label="GST included" value={String(p)} onChange={(e) => setPct(e.target.value)} style={{ fontSize: 12, minHeight: 30 }}>
        {rates.map((r) => <option key={r} value={r}>{r === 0 ? "None (0%)" : `${r}%`}{r === headGstOf(d, head) ? " · usual" : ""}</option>)}
      </select>
      {p > 0 && (
        <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={!claim} onChange={(e) => setClaim(!e.target.checked)} /> no input credit (supplier not registered)
        </label>
      )}
      {amount ? <span>→ cost {rs(net)}{amount - net > 0.004 ? ` + GST ${rs(Math.round((amount - net) * 100) / 100)}` : ""}</span> : null}
    </div>
  );
}

function Editor({ l, d, onCancel, onDone }) {
  const init = l.treatment === "cost" ? `cost:${l.head}` : l.treatment === "loan" && l.loan_id ? `loan:${l.loan_id}`
    : l.treatment === "pay" && l.post_kind ? `pay:${l.post_kind}` : ["todo", "check"].includes(l.treatment) ? "" : l.treatment;
  const [v, setV] = useState(init);
  const [always, setAlways] = useState(false);
  const [kw, setKw] = useState(() => keywordFrom(l.narration));
  const [interest, setInterest] = useState(l.interest_fixed ? String(l.interest) : "");
  const [gstPct, setGstPct] = useState(l.treatment === "cost" && l.gst_pct != null ? String(Number(l.gst_pct)) : "");
  const [gstClaim, setGstClaim] = useState(l.gst_claim !== false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [post, setPost] = useState({});      // Round 235 — party / bills / certificate
  const credit = l.credit > 0;
  const loans = d.loans.filter((x) => x.is_active || String(x.id) === String(l.loan_id));
  async function save() {
    if (!v) { setErr("Choose what this line is."); return; }
    setBusy(true); setErr("");
    const [t, x] = v.split(":");
    if (t === "pay" || t === "cert") {
      const miss = t === "cert" ? (!post.asset_id ? "Choose the vehicle." : !post.cert_type ? "Choose the certificate." : !post.valid_to ? "Enter the valid-to date." : "")
        : x === "maintenance" ? (!post.bill_id ? "Choose the bill this pays." : "") : !post.party_id ? "Choose who was paid." : "";
      if (miss) { setErr(miss); setBusy(false); return; }
      try {
        await apiRequest(`/cost/bank/lines/${l.id}`, { method: "PUT", body: { treatment: t, party_kind: t === "pay" ? x : undefined, ...post } });
        onDone(t === "cert" ? "Saved — the certificate is renewed in the compliance register." : "Saved — the payment is in the party’s ledger.");
      } catch (e) { setErr(e.message); setBusy(false); }
      return;
    }
    const body = { treatment: t, head: t === "cost" ? x : undefined, loan_id: t === "loan" ? Number(x) : undefined,
      interest: t === "loan" && interest !== "" ? Number(interest) : undefined, always: always && !["omit"].includes(t), keyword: kw,
      gst_pct: t === "cost" && !credit ? Number(gstPct === "" ? headGstOf(d, x) : gstPct) : undefined, gst_claim: t === "cost" && !credit ? gstClaim : undefined };
    try {
      const r = await apiRequest(`/cost/bank/lines/${l.id}`, { method: "PUT", body });
      onDone(r.applied ? `Saved. The rule “${kw}” also sorted ${r.applied} other line(s).` : "");
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {l.treatment === "check" && l.why && <div style={MUTED}>{l.why}</div>}
      <select aria-label="What this line is" value={v} onChange={(e) => { setV(e.target.value); setGstPct(""); setPost({}); setErr(""); }}
        style={{ fontSize: 12.5, minHeight: 34, border: `1px solid ${v ? "var(--border-strong)" : "#D9A93A"}`, background: v ? "var(--surface)" : "#FFF8E6" }}>
        <option value="">Choose…</option>
        <optgroup label={credit ? "Income / reduces a cost" : "Add to a cost"}>
          {d.heads_meta.filter((h) => credit || !h.income).map((h) => <option key={h.key} value={`cost:${h.key}`}>{h.label}</option>)}
        </optgroup>
        {!credit && (
          <optgroup label="Paid to a party → its ledger">
            {PAY_KINDS.map(([k, label]) => <option key={k} value={`pay:${k}`}>{label}</option>)}
            <option value="cert">Vehicle certificate — road tax, insurance, permit …</option>
          </optgroup>
        )}
        <optgroup label="Leave out">{LEAVE.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</optgroup>
        <optgroup label="Balance Sheet">
          {!credit && <option value="asset">Fixed asset bought</option>}
          {loans.map((x) => <option key={x.id} value={`loan:${x.id}`}>Loan — {x.name}</option>)}
        </optgroup>
      </select>
      {v.startsWith("cost:") && !credit && v !== "cost:other_income" && (
        <GstPicker d={d} head={v.slice(5)} amount={l.debit} pct={gstPct} setPct={setGstPct} claim={gstClaim} setClaim={setGstClaim} />
      )}
      {v.startsWith("pay:") && <PayFields key={v} l={l} kind={v.slice(4)} post={post} setPost={setPost} />}
      {v === "cert" && <CertFields l={l} post={post} setPost={setPost} />}
      {v.startsWith("loan:") && !credit && (
        <label style={{ ...MUTED, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>Interest in this EMI (only if the bank told you)
          <input type="number" min="0" step="0.01" value={interest} onChange={(e) => setInterest(e.target.value)} placeholder="worked out" style={{ width: 120, minHeight: 32 }} />
        </label>
      )}
      {v && v !== "omit" && !v.startsWith("pay:") && v !== "cert" && (
        <label style={{ ...MUTED, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} /> always for narrations with
          <input value={kw} onChange={(e) => setKw(e.target.value.toUpperCase())} aria-label="Word to look for" style={{ width: 170, minHeight: 30, fontSize: 12 }} />
        </label>
      )}
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 12 }}>{err}</div>}
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" className="btn-primary" disabled={busy || !v} onClick={save} style={{ fontSize: 12, padding: "4px 12px", minHeight: 32 }}>{busy ? "Saving…" : "Save"}</button>
        {onCancel && <button type="button" onClick={onCancel} style={{ fontSize: 12, padding: "4px 10px", minHeight: 32 }}>Cancel</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------- Round 235: to a ledger ---
let partiesCache = null;
function useParties() {
  const [p, setP] = useState(partiesCache);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (partiesCache) return;
    apiRequest("/cost/bank/parties").then((x) => { partiesCache = x; setP(x); setTimeout(() => { partiesCache = null; }, 60000); }).catch((e) => setErr(e.message));
  }, []);
  return { p, err };
}
const squash = (x) => String(x || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const WEAK = new Set(["THE", "AND", "LTD", "LIMITED", "PVT", "PRIVATE", "CO", "COMPANY", "INDIA", "SERVICES", "SERVICE", "ENTERPRISES", "TRADERS", "AGENCIES", "SUPPLIERS", "SUPPLY", "TRANSPORT", "TRANSPORTS", "BROTHERS", "INDUSTRIES", "M/S", "MS", "&"]);
// The party whose name is in the narration (all its main words, or the first one if it is long).
function guessParty(narr, list) {
  const n = ` ${String(narr || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ")} `;
  let best = null;
  for (const x of list || []) {
    const words = String(x.name || "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !WEAK.has(w));
    if (!words.length) continue;
    const hits = words.filter((w) => n.includes(` ${w} `)).length;
    const score = hits === words.length ? 2 + words.length : words[0].length >= 5 && n.includes(` ${words[0]} `) ? 1 : 0;
    if (score && (!best || score > best.score)) best = { id: x.id, score };
  }
  return best ? String(best.id) : "";
}
const FIELD = { display: "flex", flexDirection: "column", gap: 3, fontSize: 12, fontWeight: 600, color: "#4A525C" };
function PayFields({ l, kind, post, setPost }) {
  const { p, err } = useParties();
  const [bills, setBills] = useState(null);
  const list = p ? { supplier: p.suppliers, transporter: p.transporters, contractor: p.contractors }[kind] : null;
  // First open: the party named in the narration (or the one already posted).
  useEffect(() => {
    if (!p || kind === "maintenance") return;
    setPost((x) => {
      if (x.party_id) return x;
      const id = l.post_kind === kind && l.party_label ? String((list || []).find((y) => l.party_label.startsWith(y.name))?.id || "") : "";
      return { ...x, party_id: id || guessParty(l.narration, list) };
    });
  }, [p, kind]);   // eslint-disable-line react-hooks/exhaustive-deps
  const pid = post.party_id;
  useEffect(() => {
    setBills(null);
    if (!pid || !["supplier", "contractor"].includes(kind)) return;
    apiRequest(`/cost/bank/party-bills?kind=${kind}&id=${pid}&line=${l.id}`).then(setBills).catch(() => setBills([]));
  }, [pid, kind, l.id]);
  if (err) return <div role="alert" style={{ color: "var(--alert-red)", fontSize: 12 }}>{err}</div>;
  if (!p) return <div style={MUTED}>Loading…</div>;
  if (kind === "maintenance") {
    const open = p.mnt_bills;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={FIELD}>The bill this pays
          <select value={post.bill_id || ""} onChange={(e) => setPost({ ...post, bill_id: e.target.value })} style={{ fontSize: 12.5, minHeight: 34 }}>
            <option value="">Choose…</option>
            {open.map((b) => <option key={b.id} value={b.id}>{b.payee || "Bill"}{b.bill_no ? ` · ${b.bill_no}` : ""}{b.against ? ` · ${b.against}` : ""} — balance {rs(b.balance)}</option>)}
          </select>
        </label>
        {!open.length && <div style={MUTED}>No maintenance bill is waiting for payment. A repair paid without a bill can go to the Repairs cost head instead.</div>}
        <TdsField post={post} setPost={setPost} />
        <div style={MUTED}>→ Maintenance → Payments, against that bill. The repair cost is already in the job card / PO.</div>
      </div>
    );
  }
  const word = { supplier: "supplier", transporter: "transporter", contractor: "contractor / gang" }[kind];
  const amount = l.debit;
  const picked = new Map((post.allocations || []).map((a) => [`${a.kind}:${a.id}`, a.amount]));
  function tick(b, on) {
    const others = (post.allocations || []).filter((a) => `${a.kind}:${a.id}` !== `${b.kind}:${b.id}`);
    if (kind === "contractor") { setPost({ ...post, bill_id: on ? b.id : null, allocations: undefined }); return; }
    const used = others.reduce((t, a) => t + Number(a.amount), 0);
    const left = Math.max(0, Math.round((amount + Number(post.tds || 0) - used) * 100) / 100);
    setPost({ ...post, allocations: on ? [...others, { kind: b.kind, id: b.id, amount: Math.min(b.outstanding, left) }] : others });
  }
  const allocated = (post.allocations || []).reduce((t, a) => t + Number(a.amount), 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={FIELD}>Paid to ({word})
        <select value={pid || ""} onChange={(e) => setPost({ ...post, party_id: e.target.value, allocations: undefined, bill_id: undefined })}
          style={{ fontSize: 12.5, minHeight: 34, background: pid ? "var(--surface)" : "#FFF8E6" }}>
          <option value="">Choose…</option>
          {(list || []).map((x) => <option key={x.id} value={x.id}>{x.name}{x.is_active === false ? " (inactive)" : ""}</option>)}
        </select>
      </label>
      {pid && guessParty(l.narration, list) === String(pid) && <div style={MUTED}>found from the narration</div>}
      {bills && bills.length > 0 && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "6px 8px", maxHeight: 180, overflowY: "auto" }}>
          <div style={{ ...MUTED, marginBottom: 4 }}>{kind === "contractor" ? "Against the bill (optional — else on account):" : "Against these bills (optional — else it settles the oldest):"}</div>
          {bills.map((b) => {
            const on = kind === "contractor" ? String(post.bill_id || "") === String(b.id) : picked.has(`${b.kind}:${b.id}`);
            return (
              <label key={`${b.kind}:${b.id}`} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, padding: "2px 0" }}>
                <input type="checkbox" checked={on} onChange={(e) => tick(b, e.target.checked)} />
                <span style={{ flex: 1 }}>{b.no} · {fmtDay(b.date)}</span>
                <span style={NUM}>{rs(b.outstanding)}{on && kind !== "contractor" ? ` → ${rs(picked.get(`${b.kind}:${b.id}`))}` : ""}</span>
              </label>
            );
          })}
          {kind !== "contractor" && allocated > 0 && <div style={{ ...MUTED, marginTop: 4 }}>{rs(allocated)} against bills · {rs(Math.max(0, amount + Number(post.tds || 0) - allocated))} on account</div>}
        </div>
      )}
      {bills && bills.length === 0 && pid && kind !== "transporter" && <div style={MUTED}>No open bills — it goes in as an on-account payment.</div>}
      {kind !== "contractor" && <TdsField post={post} setPost={setPost} />}
      <div style={MUTED}>→ {PAY_KINDS.find((k) => k[0] === kind)[2]}: payment of {rs(amount)} on {fmtDay(l.txn_date)}, source this bank line. Not a cost — the cost comes from the bills.</div>
    </div>
  );
}
function TdsField({ post, setPost }) {
  return (
    <label style={{ ...MUTED, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>TDS deducted (if any)
      <input type="number" min="0" step="0.01" value={post.tds ?? ""} onChange={(e) => setPost({ ...post, tds: e.target.value })} placeholder="0" style={{ width: 110, minHeight: 30 }} />
    </label>
  );
}
const CERT_WORDS = [[/INSURANCE|ASSURANCE|POLICY|GIC\b|ICICI LOMBARD|BAJAJ ALLIANZ|TATA AIG|HDFC ERGO/, "insurance"], [/ROAD TAX|MVD|VAHAN|PARIVAHAN|RTO|TAX/, "road_tax"],
  [/PERMIT/, "permit"], [/FITNESS/, "fitness_certificate"], [/PUC|POLLUTION/, "puc"]];
const addDaysStr = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };   // ist-ok: a calendar date shifted in UTC, no clock time
const addMonthsStr = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return addDaysStr(d.toISOString().slice(0, 10), -1); };   // ist-ok: a calendar date shifted in UTC, no clock time
function CertFields({ l, post, setPost }) {
  const { p, err } = useParties();
  const set = (k, val) => setPost((x) => {
    const n = { ...x, [k]: val };
    if ((k === "asset_id" || k === "cert_type") && n.asset_id && n.cert_type && p) {
      const cur = p.current_certs.find((c) => String(c.asset_id) === String(n.asset_id) && c.cert_type === n.cert_type);
      const from = cur && cur.valid_to >= addDaysStr(l.txn_date, -60) ? addDaysStr(cur.valid_to, 1) : l.txn_date;
      n.valid_from = from;
      n.valid_to = addMonthsStr(from, n.cert_type === "road_tax" ? 3 : 12);
    }
    return n;
  });
  useEffect(() => {
    if (!p || post.asset_id || post.cert_type) return;
    const narr = squash(l.narration);
    const a = p.assets.find((x) => x.reg_no && narr.includes(squash(x.reg_no))) || p.assets.find((x) => squash(x.name).length >= 4 && narr.includes(squash(x.name)));
    const t = CERT_WORDS.find(([re]) => re.test(String(l.narration || "").toUpperCase()))?.[1] || "";
    if (a) set("asset_id", String(a.id));
    if (t) set("cert_type", t);
  }, [p]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div role="alert" style={{ color: "var(--alert-red)", fontSize: 12 }}>{err}</div>;
  if (!p) return <div style={MUTED}>Loading…</div>;
  const cur = p.current_certs.find((c) => String(c.asset_id) === String(post.asset_id) && c.cert_type === post.cert_type);
  const days = post.valid_from && post.valid_to ? Math.round((Date.parse(post.valid_to) - Date.parse(post.valid_from)) / 86400000) + 1 : 0;
  const months = days ? Math.max(1, Math.round(days / 30.4)) : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label style={{ ...FIELD, flex: "1 1 150px" }}>Vehicle / machine
          <select value={post.asset_id || ""} onChange={(e) => set("asset_id", e.target.value)} style={{ fontSize: 12.5, minHeight: 34 }}>
            <option value="">Choose…</option>
            {p.assets.map((a) => <option key={a.id} value={a.id}>{a.name}{a.reg_no ? ` · ${a.reg_no}` : ""}</option>)}
          </select>
        </label>
        <label style={{ ...FIELD, flex: "1 1 130px" }}>Certificate
          <select value={post.cert_type || ""} onChange={(e) => set("cert_type", e.target.value)} style={{ fontSize: 12.5, minHeight: 34 }}>
            <option value="">Choose…</option>
            {p.cert_types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label style={FIELD}>Valid from<input type="date" value={post.valid_from || ""} onChange={(e) => set("valid_from", e.target.value)} style={{ minHeight: 32 }} /></label>
        <label style={FIELD}>Valid to<input type="date" value={post.valid_to || ""} onChange={(e) => set("valid_to", e.target.value)} style={{ minHeight: 32 }} /></label>
        <label style={{ ...FIELD, flex: "1 1 120px" }}>Policy / receipt no.<input value={post.number || ""} onChange={(e) => set("number", e.target.value)} style={{ minHeight: 32 }} /></label>
      </div>
      {cur && <div style={MUTED}>On file: valid to {fmtDay(cur.valid_to)}.{post.valid_to && post.valid_to <= cur.valid_to ? " This one ends earlier — it is kept as history, the current one stays." : ""}</div>}
      {days > 0 && <div style={MUTED}>→ Compliance register renewed · fee {rs(l.debit)} paid {fmtDay(l.txn_date)} · P&amp;L about {rs(Math.round(l.debit / months))} a month for {months} month(s) (vehicle taxes &amp; insurance), the unused part on the Balance Sheet as prepaid.</div>}
    </div>
  );
}
function ManualSwitch({ d, reload }) {
  const [busy, setBusy] = useState(false);
  const on = !!d.ledger?.manual_payments;
  async function flip() {
    setBusy(true);
    try { await apiRequest("/cost/bank/ledger-settings", { method: "PUT", body: { manual_payments: !on } }); reload(); } finally { setBusy(false); }
  }
  return (
    <div style={{ ...MUTED, marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ flex: "1 1 200px" }}>“Record payment” in the ledgers: <b>{on ? "allowed (by hand too)" : "off — bank statement and C Ledger only"}</b></span>
      {d.ledger?.can_change && <button type="button" disabled={busy} onClick={flip} style={{ fontSize: 12, padding: "4px 10px", minHeight: 30 }}>{on ? "Switch off" : "Allow by hand"}</button>}
    </div>
  );
}

// --------------------------------------------------------------- loans ---
function Loans({ d, canEdit, onEdit }) {
  const list = d.loans;
  const tot = (k) => list.reduce((t, l) => t + (l.month?.[k] || 0), 0);
  return (
    <div style={panel("1 1 100%")}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <h2 style={H2}>Loans — EMI split into interest and principal</h2>
        {canEdit && <button type="button" onClick={() => onEdit({})}>Add a loan</button>}
      </div>
      <div style={SUB}>Set each loan up once. Every EMI: interest = balance outstanding × rate ÷ 12 → Finance cost; principal = EMI − interest → the loan comes down. The Balance Sheet’s “Term &amp; vehicle loans” is then worked out from here.</div>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ minWidth: 980 }}>
          <thead><tr><th>Loan</th><th>EMI found by</th><th style={R}>Rate</th><th style={R}>EMI ₹</th><th style={R}>Interest ₹ (month)</th><th style={R}>Principal ₹ (month)</th><th style={R}>Outstanding ₹ on {fmtDay(d.day_end)}</th><th style={R}>EMIs left</th>{canEdit && <th />}</tr></thead>
          <tbody>
            {list.map((l) => (
              <tr key={l.id} style={{ opacity: l.is_active ? 1 : 0.6 }}>
                <td style={{ whiteSpace: "normal", fontWeight: 600 }}>{l.name}<div style={{ ...MUTED, fontWeight: 400 }}>{[l.lender, `${num(l.opening_outstanding)} on ${fmtDay(l.opening_date)}`, l.is_active ? null : "closed"].filter(Boolean).join(" · ")}</div></td>
                <td style={{ fontSize: 12, whiteSpace: "normal" }}>{l.match_text ? `“${l.match_text}”` : "—"}{l.account ? <div style={MUTED}>{l.account}</div> : null}</td>
                <td style={R}>{num(l.rate_pct, 2)}%</td>
                <td style={R}>{l.emi ? num(l.emi) : "—"}</td>
                <td style={{ ...R, color: "var(--alert-red)", fontWeight: 600 }}>{l.month ? num(l.month.interest) : "—"}</td>
                <td style={R}>{l.month ? num(l.month.principal) : "—"}</td>
                <td style={{ ...R, fontWeight: 700 }}>{l.outstanding == null ? "—" : num(l.outstanding)}</td>
                <td style={R}>{l.emis_left ?? "—"}</td>
                {canEdit && <td><button type="button" onClick={() => onEdit(l)} style={{ fontSize: 12, padding: "4px 10px", minHeight: 32 }}>Edit</button></td>}
              </tr>
            ))}
            {!list.length && <tr><td colSpan={9} style={{ color: "var(--slate)" }}>No loans set up. Add each term and vehicle loan once — then their EMIs on the statements are split automatically.</td></tr>}
          </tbody>
          {list.length > 0 && <tfoot><tr><td colSpan={4}>This month</td><td style={R}>{num(tot("interest"))}</td><td style={R}>{num(tot("principal"))}</td><td style={R}>{num(list.reduce((t, l) => t + (l.outstanding || 0), 0))}</td><td />{canEdit && <td />}</tr></tfoot>}
        </table>
      </div>
      <div style={{ ...MUTED, marginTop: 8 }}>When the bank changes the rate, edit the loan; when it sends the interest certificate, type the interest on that EMI line — the later EMIs are worked out again from it. Cash-credit interest is a normal line: give it the head Finance cost (or tick “always”).</div>
    </div>
  );
}

function LoanModal({ d, loan, onClose, onDone }) {
  const [f, setF] = useState({ name: loan.name || "", lender: loan.lender || "", kind: loan.kind || "term", account_id: loan.account_id || "",
    match_text: loan.match_text || "", rate_pct: loan.rate_pct ?? "", emi: loan.emi ?? "", opening_outstanding: loan.opening_outstanding ?? "",
    opening_date: loan.opening_date || "", is_active: loan.is_active !== false, notes: loan.notes || "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  async function save() {
    setBusy(true); setErr("");
    try { await apiRequest(loan.id ? `/cost/bank/loans/${loan.id}` : "/cost/bank/loans", { method: loan.id ? "PUT" : "POST", body: f }); onDone(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  const F = ({ label, children }) => <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 }}>{label}{children}</label>;
  return (
    <Modal title={loan.id ? `Loan — ${loan.name}` : "Add a loan"} onClose={onClose} width={620}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {F({ label: "Name", children: <input value={f.name} onChange={set("name")} placeholder="Term loan — plant machinery" /> })}
        {F({ label: "Bank / lender", children: <input value={f.lender} onChange={set("lender")} placeholder="HDFC Bank" /> })}
        {F({ label: "Kind", children: <select value={f.kind} onChange={set("kind")}><option value="term">Term loan</option><option value="vehicle">Vehicle loan</option><option value="other">Other</option></select> })}
        {F({ label: "EMI paid from", children: <select value={f.account_id} onChange={set("account_id")}><option value="">—</option>{d.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select> })}
        {F({ label: "Text in the EMI narration", children: <input value={f.match_text} onChange={(e) => setF({ ...f, match_text: e.target.value.toUpperCase() })} placeholder="e.g. TL 84519023 (the loan account no.)" /> })}
        {F({ label: "Interest rate, % a year", children: <input type="number" step="0.01" value={f.rate_pct} onChange={set("rate_pct")} placeholder="9.25" /> })}
        {F({ label: "EMI ₹", children: <input type="number" step="0.01" value={f.emi} onChange={set("emi")} /> })}
        {F({ label: "Balance outstanding ₹", children: <input type="number" step="0.01" value={f.opening_outstanding} onChange={set("opening_outstanding")} /> })}
        {F({ label: "…on this date", children: <input type="date" value={f.opening_date} onChange={set("opening_date")} /> })}
      </div>
      <div style={{ ...MUTED, marginTop: 8 }}>Take the balance from the loan statement, on a date before the first EMI you will upload. EMIs after that date are split from it.</div>
      <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 10, fontSize: 13 }}><input type="checkbox" checked={f.is_active} onChange={set("is_active")} /> Running (untick when closed)</label>
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 8 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save loan"}</button>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------- rules ---
function treatLabel(d, r) {
  if (r.treatment === "cost") return `Cost · ${headLabel(d, r.head)}${r.gst_pct != null && Number(r.gst_pct) > 0 ? ` · GST ${Number(r.gst_pct)}%${r.gst_claim === false ? ", no credit" : ""}` : ""}`;
  if (r.treatment === "loan") return `Loan EMI · ${r.loan_name || ""}`;
  return T[r.treatment]?.label || r.treatment;
}
function Rules({ d, canEdit, reload, onAdd }) {
  const [err, setErr] = useState("");
  async function del(r) {
    setErr("");
    try { await apiRequest(`/cost/bank/rules/${r.id}`, { method: "DELETE" }); reload(); } catch (e) { setErr(e.message); }
  }
  return (
    <div style={panel("1 1 100%")}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <h2 style={H2}>Rules</h2>
        {canEdit && <button type="button" onClick={onAdd}>Add a rule</button>}
      </div>
      <div style={SUB}>A word in the narration → what the line is. Made when you tick “always”. Checking against the app’s records always comes first.</div>
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ minWidth: 620 }}>
          <thead><tr><th>Narration has</th><th>On</th><th>Treat as</th><th style={R}>Used</th>{canEdit && <th />}</tr></thead>
          <tbody>
            {d.rules.map((r) => (
              <tr key={r.id}>
                <td style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5 }}>{r.keyword}</td>
                <td>{r.side === "any" ? "Debit or credit" : r.side === "debit" ? "Debit" : "Credit"}</td>
                <td style={{ whiteSpace: "normal" }}>{treatLabel(d, r)}</td>
                <td style={R}>{r.used}</td>
                {canEdit && <td><button type="button" onClick={() => del(r)} style={{ fontSize: 12, padding: "4px 10px", minHeight: 32 }}>Remove</button></td>}
              </tr>
            ))}
            {!d.rules.length && <tr><td colSpan={5} style={{ color: "var(--slate)" }}>No rules yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function RuleModal({ d, onClose, onDone }) {
  const [kw, setKw] = useState("");
  const [side, setSide] = useState("debit");
  const [v, setV] = useState("");
  const [gstPct, setGstPct] = useState("");
  const [gstClaim, setGstClaim] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const costHead = v.startsWith("cost:") && v !== "cost:other_income" && side !== "credit" ? v.slice(5) : null;
  async function save() {
    setBusy(true); setErr("");
    const [t, x] = v.split(":");
    try { await apiRequest("/cost/bank/rules", { method: "POST", body: { keyword: kw, side, treatment: t, head: t === "cost" ? x : undefined, loan_id: t === "loan" ? Number(x) : undefined,
      gst_pct: costHead ? Number(gstPct === "" ? headGstOf(d, costHead) : gstPct) : undefined, gst_claim: costHead ? gstClaim : undefined } }); onDone(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="Add a rule" onClose={onClose} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 }}>Word in the narration<input value={kw} onChange={(e) => setKw(e.target.value.toUpperCase())} placeholder="e.g. ELECTRICITY BOARD" /></label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 }}>On
          <select value={side} onChange={(e) => setSide(e.target.value)}><option value="debit">Debits (money out)</option><option value="credit">Credits (money in)</option><option value="any">Either</option></select></label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 }}>Treat as
          <select value={v} onChange={(e) => { setV(e.target.value); setGstPct(""); }}>
            <option value="">Choose…</option>
            <optgroup label="Cost / income head">{d.heads_meta.map((h) => <option key={h.key} value={`cost:${h.key}`}>{h.label}</option>)}</optgroup>
            <optgroup label="Leave out">{LEAVE.filter(([k]) => k !== "omit").map(([k, label]) => <option key={k} value={k}>{label}</option>)}</optgroup>
            <optgroup label="Balance Sheet"><option value="asset">Fixed asset bought</option>{d.loans.map((x) => <option key={x.id} value={`loan:${x.id}`}>Loan — {x.name}</option>)}</optgroup>
          </select></label>
        {costHead && <GstPicker d={d} head={costHead} amount={0} pct={gstPct} setPct={setGstPct} claim={gstClaim} setClaim={setGstClaim} />}
        <div style={MUTED}>“Already in the app” can’t be a rule — a line is left out only when its payment is found in the app’s records.</div>
        {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" disabled={busy || !kw || !v} onClick={save}>Save rule</button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------- uploads ---
function Uploads({ d, canEdit, reload, setMsg }) {
  const [err, setErr] = useState("");
  async function del(u) {
    if (!window.confirm(`Take back ${u.file_name || "this upload"} (${u.lines_added} lines)? Its lines and their treatments are removed.`)) return;
    setErr("");
    try { const r = await apiRequest(`/cost/bank/uploads/${u.id}`, { method: "DELETE" }); setMsg(`${r.removed} line(s) removed.`); reload(); } catch (e) { setErr(e.message); }
  }
  if (!d.uploads.length) return null;
  return (
    <div style={panel("1 1 100%")}>
      <h2 style={H2}>Uploads</h2>
      <div style={SUB}>The latest 20. A statement uploaded twice adds only the lines not already in.</div>
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ minWidth: 760 }}>
          <thead><tr><th>Uploaded</th><th>Account</th><th>File</th><th>Period</th><th style={R}>Lines added</th><th style={R}>Already in</th>{canEdit && <th />}</tr></thead>
          <tbody>
            {d.uploads.map((u) => (
              <tr key={u.id}>
                <td style={{ whiteSpace: "nowrap" }}>{new Date(u.uploaded_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}<div style={MUTED}>{u.by_name}</div></td>
                <td>{u.account}</td>
                <td style={{ whiteSpace: "normal", wordBreak: "break-all", fontSize: 12 }}>{u.file_name || "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>{fmtDay(u.period_from)} – {fmtDay(u.period_to)}</td>
                <td style={R}>{u.lines_added}</td><td style={R}>{u.lines_duplicate}</td>
                {canEdit && <td><button type="button" onClick={() => del(u)} style={{ fontSize: 12, padding: "4px 10px", minHeight: 32 }}>Take back</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UploadModal({ d, onClose, onDone }) {
  const active = d.accounts.filter((a) => a.is_active);
  const [account, setAccount] = useState(active[0] ? String(active[0].id) : "");
  const [file, setFile] = useState(null);
  const [pw, setPw] = useState("");
  const [needPw, setNeedPw] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [found, setFound] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [anyway, setAnyway] = useState(false);

  async function read(f = file, password = pw) {
    if (!f) return;
    setErr(""); setParsed(null); setBusy(true); setAnyway(false);
    let mod;
    try { mod = await import("../../lib/bankStatementParse.js"); }
    catch (e) { setErr(`The statement reader could not load (${e.message}). Reload the page and try again.`); setBusy(false); return; }
    try {
      const { readFile, PdfPasswordError } = mod;
      try {
        const r = await readFile(f, password);
        setParsed(r); setNeedPw(false);
        // Which account: a number printed on the statement.
        // The first number printed (the statement's own "Account No") wins over
        // numbers in narrations (transfers to our other accounts).
        let hit = null;
        for (const n of r.account_numbers) {
          hit = d.accounts.find((a) => n === a.number || (/[X*x]/.test(n) && n.replace(/\D/g, "").length >= 4 && a.number.endsWith(n.replace(/\D/g, "").slice(-4))));
          if (hit) break;
        }
        if (hit) { setAccount(String(hit.id)); setFound(`Account found on the statement: ${hit.name}`); } else setFound("");
      } catch (e) {
        if (e instanceof PdfPasswordError) { setNeedPw(true); setErr(e.wrong ? "That password did not open the PDF." : "This PDF is locked — type its password (banks often use the customer ID or a date of birth)."); }
        else setErr(`${e.message}${/\.pdf$/i.test(f.name) ? " — if this keeps happening, download the statement as Excel instead, or send the PDF to have the reader checked." : ""}`);
      }
    } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setErr("");
    try {
      const r = await apiRequest("/cost/bank/upload", { method: "POST", body: {
        account_id: Number(account), file_name: file?.name, rows: parsed.rows, period_from: parsed.from, period_to: parsed.to, opening: parsed.opening, closing: parsed.printed_closing ?? parsed.closing } });
      const c = r.counts || {};
      const parts = [["omit", "left out (in the app)"], ["own", "own transfers"], ["loan", "loan EMIs"], ["cost", "costs by rule"], ["tax", "tax"], ["check", "to check"], ["todo", "to categorise"]]
        .filter(([k]) => c[k]).map(([k, l]) => `${c[k]} ${l}`);
      onDone(`${r.added} line(s) added${r.duplicates ? `, ${r.duplicates} already uploaded before — skipped` : ""}${r.added ? `. ${parts.join(" · ")}.` : " — every line of this statement was already uploaded."}`, r.to);
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  const p = parsed;
  const blocked = p && p.agrees === false && !anyway;
  return (
    <Modal title="Upload a bank statement" onClose={onClose} width={860}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 }}>Statement — PDF from net banking, or Excel / CSV
          <input type="file" accept=".pdf,.xls,.xlsx,.csv,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; setFile(f || null); setPw(""); setNeedPw(false); if (f) read(f, ""); }} /></label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 }}>Account
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">Choose…</option>
            {active.map((a) => <option key={a.id} value={a.id}>{a.name} · {KIND[a.kind]}</option>)}
          </select></label>
      </div>
      {needPw && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 }}>PDF password
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") read(); }} autoComplete="off" /></label>
          <button type="button" disabled={busy || !pw} onClick={() => read()}>Open</button>
        </div>
      )}
      {busy && !p && <div style={{ ...MUTED, marginTop: 10 }}>Reading the statement…</div>}
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 10 }}>{err}</div>}
      {found && <div style={{ fontSize: 12.5, color: "#155C40", marginTop: 10 }}>{found}</div>}
      {!d.accounts.length && <Note>Add the bank account first (Bank accounts — add or change).</Note>}
      {p && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ background: p.agrees === false ? "var(--alert-red-bg)" : "var(--signal-green-bg)", borderRadius: 8, padding: "10px 12px", fontSize: 13, ...NUM }}>
            <b>{p.rows.length} line(s) read · {fmtDay(p.from)} – {fmtDay(p.to)}</b><br />
            {p.opening != null ? <>opening ₹{num(p.opening, 2)} + credits ₹{num(p.credits, 2)} − debits ₹{num(p.debits, 2)} = ₹{num(p.closing, 2)}</> : <>credits ₹{num(p.credits, 2)} · debits ₹{num(p.debits, 2)}</>}
            {p.agrees === true && <> — matches the closing balance on the statement ✓</>}
            {p.agrees === false && <> — the statement’s last balance is ₹{num(p.printed_closing, 2)}: some lines were not read correctly{p.breaks.length ? ` (see the ${p.breaks.length} marked line(s))` : ""}.</>}
            {p.agrees == null && <> — the statement has no balance column, so the total could not be checked.</>}
          </div>
          <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
            <table style={{ minWidth: 700 }}>
              <thead><tr><th>Date</th><th>Narration</th><th style={R}>Debit</th><th style={R}>Credit</th><th style={R}>Balance</th></tr></thead>
              <tbody>
                {p.rows.map((r, i) => (
                  <tr key={i} style={{ background: p.breaks.includes(i) ? "var(--alert-red-bg)" : undefined }}>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDay(r.date)}</td>
                    <td style={{ whiteSpace: "normal", fontSize: 12 }}>{r.narration}{r.reference ? ` · ${r.reference}` : ""}</td>
                    <td style={R}>{r.debit ? num(r.debit, 2) : ""}</td><td style={R}>{r.credit ? num(r.credit, 2) : ""}</td>
                    <td style={R}>{r.balance == null ? "" : num(r.balance, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {p.agrees === false && (
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} />
              I’ve checked the marked lines against the statement — save anyway</label>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !p || !account || blocked} onClick={save}>{busy && p ? "Saving…" : "Save and sort"}</button>
      </div>
    </Modal>
  );
}

function AccountsModal({ d, onClose }) {
  const [list, setList] = useState(d.accounts.map((a) => ({ ...a })));
  const [add, setAdd] = useState({ bank: "", label: "", number: "", kind: "current" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function saveOne(a) {
    setBusy(true); setErr("");
    try { await apiRequest(`/cost/bank/accounts/${a.id}`, { method: "PUT", body: a }); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function addOne() {
    setBusy(true); setErr("");
    try { const r = await apiRequest("/cost/bank/accounts", { method: "POST", body: add }); setList([...list, { ...add, id: r.id, is_active: true }]); setAdd({ bank: "", label: "", number: "", kind: "current" }); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const upd = (i, k, v) => setList(list.map((a, j) => (j === i ? { ...a, [k]: v } : a)));
  return (
    <Modal title="Bank accounts" onClose={onClose} width={860}>
      <div style={{ ...MUTED, marginBottom: 8 }}>Every account whose statements you upload — current accounts, cash credit / overdraft. The account number is how the page recognises a statement, and how transfers between our accounts are found.</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ minWidth: 760 }}>
          <thead><tr><th>Bank</th><th>Label</th><th>Account number</th><th>Kind</th><th>In use</th><th /></tr></thead>
          <tbody>
            {list.map((a, i) => (
              <tr key={a.id}>
                <td><input value={a.bank} onChange={(e) => upd(i, "bank", e.target.value)} style={{ width: 170 }} /></td>
                <td><input value={a.label || ""} onChange={(e) => upd(i, "label", e.target.value)} style={{ width: 130 }} /></td>
                <td><input value={a.number} onChange={(e) => upd(i, "number", e.target.value)} style={{ width: 160 }} inputMode="numeric" /></td>
                <td><select value={a.kind} onChange={(e) => upd(i, "kind", e.target.value)}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                <td><input type="checkbox" checked={a.is_active} onChange={(e) => upd(i, "is_active", e.target.checked)} aria-label="In use" /></td>
                <td><button type="button" disabled={busy} onClick={() => saveOne(a)} style={{ fontSize: 12, padding: "4px 10px", minHeight: 32 }}>Save</button></td>
              </tr>
            ))}
            <tr>
              <td><input value={add.bank} onChange={(e) => setAdd({ ...add, bank: e.target.value })} placeholder="State Bank of India" style={{ width: 170 }} /></td>
              <td><input value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} placeholder="CC" style={{ width: 130 }} /></td>
              <td><input value={add.number} onChange={(e) => setAdd({ ...add, number: e.target.value })} placeholder="full number" style={{ width: 160 }} inputMode="numeric" /></td>
              <td><select value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
              <td />
              <td><button type="button" className="btn-primary" disabled={busy || !add.bank || !add.number} onClick={addOne} style={{ fontSize: 12, padding: "4px 10px", minHeight: 32 }}>Add</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 8 }}>{err}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}><button type="button" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

function exportLines(d) {
  const head = (k) => d.heads_meta.find((h) => h.key === k)?.label || "";
  const rows = [["Date", "Account", "Narration", "Reference", "Debit", "Credit", "Balance", "Treatment", "Head / loan / party", "Interest", "Principal", "Why", "Set by"],
    ...d.lines.map((l) => [l.txn_date, l.account, l.narration, l.reference || "", l.debit || "", l.credit || "", l.balance ?? "", T[l.treatment]?.label || l.treatment,
      l.treatment === "cost" ? head(l.head) : l.party_label || l.loan_name || "", l.interest ?? "", l.principal ?? "", l.why || "", l.manual ? l.set_by_name || "hand" : "app"])];
  const heads = [["P&L line", "₹", "Lines"], ...d.summary.heads.filter((h) => h.amount || h.n).map((h) => [h.label, h.amount, h.n])];
  downloadExcel(`Bank statements ${d.month}.xlsx`, [{ name: "Lines", rows }, { name: "To the P&L", rows: heads }]);
}
