// Round 242 — Cost → Partners (owner, 26 Oct 2026): partners' capital
// (brought in and returned) and unsecured loans from partners (14% a year
// from the day borrowed, interest paid, interest still due, TDS). Same
// permission as Bank statements (cost.bank). Arithmetic: backend lib/partners.js.
// Round 247 (owner, 28 Oct 2026: "i need a better visualization of partners
// page … further entries will be done in app only"): a summary band, one card
// per partner (capital and loan side by side, interest paid against interest
// earned), a table view, a statement with filters, and "Record an entry" for
// capital, loans, interest paid with or without TDS, and TDS on its own. Once
// the imported sheet is confirmed, the comparison, the sheet import and the
// statement upload go away.
import { useEffect, useRef, useState } from "react";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { apiRequest } from "../../lib/api.js";
import { istDay } from "../../lib/istDate.js";
import { useCostData, Loading, Actions, BTN, Note, Modal, downloadExcel, rs, rsL, num, fmtDay, H2, SUB, MUTED, R, NUM, GRID, panel } from "./costUi.jsx";

const KIND_LABEL = {
  capital_in: "Capital brought in", capital_out: "Capital returned",
  loan_in: "Loan received", loan_out: "Loan repaid", interest_paid: "Interest paid", interest_due: "Interest owed at start",
};
// Colours: capital green, loan blue, interest paid teal, interest still due amber.
const COL = { capital: "#1D7A55", loan: "#3E6E9E", paid: "#5FA388", due: "#E0A43A", tds: "#8C7AA9" };
const KIND_COL = { capital_in: COL.capital, capital_out: COL.capital, loan_in: COL.loan, loan_out: COL.loan, interest_paid: COL.paid, interest_due: COL.due };
const istToday = () => istDay();
const TH = { textAlign: "left", fontSize: 11.5, color: "var(--slate)", fontWeight: 600, padding: "6px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
// Round 247 — column headings stay in view while a long table scrolls (owner: "the window headers are not visible").
const THS = { ...TH, position: "sticky", top: 0, zIndex: 1, background: "var(--surface)", boxShadow: "0 1px 0 var(--border)" };
const TD = { padding: "7px 8px", borderBottom: "1px solid var(--border)", fontSize: 13 };
const TDR = { ...TD, ...R };
const CAPS = { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700, color: "var(--slate)" };

function Dot({ c }) { return <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 9, background: c, display: "inline-block", flex: "none" }} />; }
// A bar of parts, each { v, c, label }, scaled to `max`.
function Stack({ parts, max, h = 10 }) {
  const total = parts.reduce((a, p) => a + Math.max(0, p.v), 0);
  const scale = max > 0 ? max : total || 1;
  return (
    <div role="img" aria-label={parts.map((p) => `${p.label} ${rs(p.v)}`).join(", ")}
      style={{ display: "flex", height: h, borderRadius: h, background: "var(--concrete)", overflow: "hidden" }}>
      {parts.map((p, i) => <div key={i} title={`${p.label} ${rs(p.v)}`} style={{ width: `${(Math.max(0, p.v) / scale) * 100}%`, background: p.c }} />)}
    </div>
  );
}
function Fig({ label, value, c, sub, big }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...CAPS, display: "flex", alignItems: "center", gap: 6 }}>{c && <Dot c={c} />}{label}</div>
      <div style={{ fontSize: big ? 20 : 16, fontWeight: 700, marginTop: 3, ...NUM }}>{value}</div>
      {sub && <div style={{ ...MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function CostPartnersTab() {
  const { can } = usePermissions();
  const canEdit = can("cost.bank", "edit");
  const [asOf, setAsOf] = useState(istToday());
  const { data: d, error, reload } = useCostData(`/cost/partners?as_of=${asOf}`);
  const [open, setOpen] = useState(null);
  const [view, setView] = useState("cards");
  const [upload, setUpload] = useState(null);   // "capital" | "loan"
  const [entry, setEntry] = useState(null);     // entry object
  const [setup, setSetup] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState("");
  const detailRef = useRef(null);
  useEffect(() => { if (open && detailRef.current) detailRef.current.scrollIntoView({ behavior: "smooth", block: "start" }); }, [open]);

  const closed = !!d?.settings?.sheet_closed_at;
  const record = (partnerId, kind = "interest_paid") => setEntry({ kind, partner_id: partnerId, txn_date: istToday() });
  const head = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 14 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Partners</h1>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4 }}>Capital and unsecured loans from the partners · interest earned, paid, TDS and what is still due</div>
      </div>
      <Actions>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600 }}>As on
          <input type="date" value={asOf} max="2099-12-31" onChange={(e) => e.target.value && setAsOf(e.target.value)} style={{ minHeight: 40 }} /></label>
        <button type="button" style={BTN} disabled={!d} onClick={() => exportPartners(d)}>Export Excel</button>
        {canEdit && <button type="button" style={BTN} onClick={() => setSetup(true)}>Partners &amp; rates</button>}
        {canEdit && d && !closed && <button type="button" style={BTN} onClick={() => setImporting(true)}>Import my Investment &amp; Loan sheet</button>}
        {canEdit && d && !closed && <button type="button" style={BTN} disabled={!d.partners.length} onClick={() => setUpload("capital")}>Upload statement</button>}
        {canEdit && <button type="button" className="btn-primary" style={BTN} disabled={!d?.partners.length} onClick={() => record(null)}>+ Record an entry</button>}
      </Actions>
    </div>
  );
  if (!d) return <>{head}<div style={{ marginTop: 16 }}><Loading error={error} /></div></>;
  const t = d.totals, s = d.settings;
  const active = d.partners.filter((p) => p.is_active || p.txn_count);
  const done = (m) => { setMsg(m); reload(); };
  const maxFund = Math.max(0, ...active.map((p) => Math.max(0, p.capital.balance) + Math.max(0, p.loan.outstanding)));
  const funds = t.capital + t.loans;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {head}
      {msg && <Note tone="good">{msg}</Note>}
      {d.sheet_check && <SheetCheck c={d.sheet_check} canEdit={canEdit} onConfirm={async () => {
        if (!window.confirm("The app's figures are right?\n\nThe comparison, the sheet import and the statement upload are removed from this page. From now on, record capital, loans, interest paid and TDS here with “+ Record an entry”.")) return;
        try { await apiRequest("/cost/partners/sheet-close", { method: "POST", body: {} }); done("Sheet confirmed. Record new entries with “+ Record an entry”."); } catch (e) { setMsg(e.message); }
      }} />}
      {!d.partners.length && <Note>Add the partners first (Partners &amp; rates).</Note>}

      {/* ---- summary band ---- */}
      <section style={{ ...panel("1 1 100%"), padding: 0, overflow: "hidden", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <div style={{ background: "var(--charcoal)", color: "#fff", padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ ...CAPS, color: "rgba(255,255,255,.8)" }}>Money from the partners · {fmtDay(d.as_of)}</div>
          <div style={{ fontSize: 30, fontWeight: 700, ...NUM }}>{rsL(funds)}</div>
          <Stack h={12} parts={[{ v: t.capital, c: "#6FC29B", label: "Capital" }, { v: t.loans, c: "#8FB3DE", label: "Loans" }]} />
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12.5 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot c="#6FC29B" />Capital <b style={NUM}>{rsL(t.capital)}</b></span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot c="#8FB3DE" />Loans <b style={NUM}>{rsL(t.loans)}</b> at {num(s.loan_rate, 2)}%</span>
          </div>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, borderRight: "1px solid var(--border)" }}>
          <div style={CAPS}>Interest on the loans till date</div>
          <div style={{ fontSize: 24, fontWeight: 700, ...NUM }}>{rs(t.interest_total)}</div>
          <Stack h={12} parts={[{ v: t.interest_paid_net, c: COL.paid, label: "Paid to partners" }, { v: t.tds, c: COL.tds, label: "TDS deducted" }, { v: Math.max(0, t.interest_due), c: COL.due, label: "Still due" }]} />
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Dot c={COL.paid} />Paid {rs(t.interest_paid_net)}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Dot c={COL.tds} />TDS {rs(t.tds)}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Dot c={COL.due} />Due {rs(t.interest_due)}</span>
          </div>
        </div>
        <div style={{ padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignContent: "start" }}>
          <Fig big label="Interest due now" c={COL.due} value={rs(t.interest_due)} sub={`if paid: TDS ${num(s.tds_rate)}% ${rs(t.tds_on_due)} · net ${rs(t.net_due)}`} />
          <Fig big label={`Interest FY ${d.fy}`} value={rs(t.fy_interest)} sub={`paid ${rs(t.fy_paid_net)} · TDS ${rs(t.fy_tds)}`} />
          <Fig label="Borrowed / repaid" value={`${rsL(t.borrowed)} / ${rsL(t.repaid)}`} />
          <Fig label="Capital in / returned" value={`${rsL(t.capital_in)} / ${rsL(t.capital_out)}`} />
        </div>
      </section>

      {/* ---- partners ---- */}
      {active.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div>
              <h2 style={H2}>Each partner</h2>
              <div style={SUB}>Interest {num(s.loan_rate, 2)}% a year, simple, by days from each loan’s interest start date{s.rates.length ? `; rate changes ${s.rates.map((r) => `${fmtDay(r.from_date)} ${num(r.rate, 2)}%`).join(", ")}` : ""}. Interest paid counts with its TDS.</div>
            </div>
            <div role="tablist" aria-label="View" style={{ display: "flex", border: "1px solid var(--border-strong)", borderRadius: 8, overflow: "hidden" }}>
              {[["cards", "Cards"], ["table", "Table"]].map(([k, l]) => (
                <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}
                  style={{ border: 0, borderRadius: 0, padding: "7px 14px", fontSize: 12.5, fontWeight: 600, background: view === k ? "var(--charcoal)" : "var(--surface)", color: view === k ? "#fff" : "var(--charcoal)" }}>{l}</button>
              ))}
            </div>
          </div>
          {view === "cards" ? (
            <div style={GRID(310)}>
              {active.map((p) => <PartnerCard key={p.id} p={p} t={t} maxFund={maxFund} open={open === p.id} canEdit={canEdit}
                onOpen={() => setOpen(open === p.id ? null : p.id)} onRecord={() => record(p.id)} />)}
            </div>
          ) : <PartnersTable active={active} t={t} open={open} setOpen={setOpen} />}
        </section>
      )}

      {open && (() => {
        const p = d.partners.find((x) => x.id === open);
        return p ? <div ref={detailRef} style={{ scrollMarginTop: 12 }}><PartnerDetail p={p} canEdit={canEdit} onClose={() => setOpen(null)} onRecord={() => record(p.id)} onEdit={(e) => setEntry(e)} onDelete={async (e) => {
          if (!window.confirm(`Remove this entry — ${KIND_LABEL[e.kind]} ${rs(e.amount)} on ${fmtDay(e.date)}?`)) return;
          try { await apiRequest(`/cost/partners/txns/${e.id}`, { method: "DELETE" }); done("Entry removed."); } catch (err) { setMsg(err.message); }
        }} /></div> : null;
      })()}

      {d.uploads.length > 0 && (
        <details style={panel("1 1 100%")}>
          <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 14 }}>Earlier uploads ({d.uploads.length})</summary>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: 560, borderCollapse: "collapse", marginTop: 8 }}>
              <thead><tr><th style={TH}>When</th><th style={TH}>For</th><th style={TH}>File</th><th style={{ ...TH, ...R }}>Lines kept</th><th style={TH}>By</th><th style={TH} /></tr></thead>
              <tbody>{d.uploads.map((u) => (
                <tr key={u.id}>
                  <td style={TD}>{new Date(u.uploaded_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                  <td style={TD}>{u.book === "capital" ? "Capital" : u.book === "sheet" ? "Investment & Loan sheet" : "Unsecured loans"}</td><td style={TD}>{u.file_name || "—"}</td><td style={TDR}>{u.kept}</td><td style={TD}>{u.uploaded_by || "—"}</td>
                  <td style={TD}>{canEdit && <button type="button" style={{ padding: "4px 10px", fontSize: 12 }} onClick={async () => {
                    if (!window.confirm(`Take back this upload? Its ${u.kept} line(s) are removed.`)) return;
                    try { const r = await apiRequest(`/cost/partners/uploads/${u.id}`, { method: "DELETE" }); done(`${r.removed} line(s) taken back.`); } catch (err) { setMsg(err.message); }
                  }}>Take back</button>}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <Note tone="good">
        The interest on the partners’ loans goes into the Profit &amp; Loss (Finance cost) month by month as it accrues; the loans and the interest due show on the Balance Sheet.
        On Bank statements, give these partner lines “Capital brought in / taken out” or a loan, not a cost head — a bank line with the head Finance cost and the same date and amount as an interest payment entered here is not counted twice.
      </Note>

      {upload && <UploadModal book={upload} d={d} onClose={() => setUpload(null)} onDone={(m) => { setUpload(null); done(m); }} />}
      {entry && <EntryModal entry={entry} d={d} onClose={() => setEntry(null)} onDone={(m) => { setEntry(null); done(m); }} />}
      {importing && <ImportSheetModal d={d} onClose={() => setImporting(false)} onDone={(m) => { setImporting(false); done(m); }} />}
      {setup && <SetupModal d={d} onClose={() => setSetup(false)} onDone={(m) => { done(m); }} />}
    </div>
  );
}

function PartnerCard({ p, t, maxFund, open, canEdit, onOpen, onRecord }) {
  const l = p.loan, cap = p.capital;
  const share = t.capital > 0 ? (cap.balance / t.capital) * 100 : null;
  return (
    <article style={{ ...panel("1 1 auto"), display: "flex", flexDirection: "column", gap: 12, borderColor: open ? "var(--charcoal)" : undefined }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{p.name}</div>
          <div style={MUTED}>{[p.pan && `PAN ${p.pan}`, l.first_date && `loan since ${fmtDay(l.first_date)}`].filter(Boolean).join(" · ") || " "}</div>
        </div>
        {share != null && <span style={{ fontSize: 11.5, fontWeight: 700, padding: "2px 9px", borderRadius: 20, background: "var(--signal-green-bg)", color: "#1D6A4B", whiteSpace: "nowrap", ...NUM }}>{num(share, 1)}% of capital</span>}
      </header>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Fig label="Capital" c={COL.capital} value={rsL(cap.balance)} sub={cap.returned ? `returned ${rsL(cap.returned)}` : null} />
        <Fig label="Loan" c={COL.loan} value={rsL(l.outstanding)} sub={l.repaid ? `repaid ${rsL(l.repaid)}` : null} />
      </div>
      <Stack parts={[{ v: cap.balance, c: COL.capital, label: "Capital" }, { v: l.outstanding, c: COL.loan, label: "Loan" }]} max={maxFund} />
      <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}><span style={{ color: "var(--slate)" }}>Interest till date</span><b style={NUM}>{rs(l.interest_total)}</b></div>
        <Stack h={8} parts={[{ v: l.interest_paid_net, c: COL.paid, label: "Paid" }, { v: l.tds, c: COL.tds, label: "TDS" }, { v: Math.max(0, l.interest_due), c: COL.due, label: "Due" }]} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, fontSize: 12 }}>
          <div><div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--slate)" }}><Dot c={COL.paid} />Paid</div><b style={NUM}>{rs(l.interest_paid_net)}</b></div>
          <div><div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--slate)" }}><Dot c={COL.tds} />TDS</div><b style={NUM}>{rs(l.tds)}</b></div>
          <div><div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--slate)" }}><Dot c={COL.due} />Due</div><b style={{ ...NUM, color: l.interest_due < 0 ? "var(--signal-green)" : undefined }}>{rs(l.interest_due)}</b></div>
        </div>
      </div>
      <footer style={{ display: "flex", gap: 8, marginTop: "auto" }}>
        <button type="button" style={{ flex: 1, padding: "8px 10px", fontSize: 12.5 }} onClick={onOpen} aria-expanded={open}>{open ? "Hide statement" : "Statement"}</button>
        {canEdit && <button type="button" className="btn-primary" style={{ flex: 1, padding: "8px 10px", fontSize: 12.5 }} onClick={onRecord}>+ Record</button>}
      </footer>
    </article>
  );
}

function PartnersTable({ active, t, open, setOpen }) {
  const th = (l, right) => <th style={{ ...THS, ...(right ? R : null) }}>{l}</th>;
  return (
    <div style={{ ...panel("1 1 100%"), padding: 0, overflow: "auto", maxHeight: "72vh" }}>
      <table style={{ width: "100%", minWidth: 1080, borderCollapse: "separate", borderSpacing: 0 }}>
        <thead><tr>{th("Partner")}{th("Capital", 1)}{th("Loan outstanding", 1)}{th("Interest till date", 1)}{th("Paid to partner", 1)}{th("TDS deducted", 1)}{th("Interest due", 1)}{th("TDS on due", 1)}{th("Net to pay", 1)}<th style={THS} /></tr></thead>
        <tbody>
          {active.map((p) => (
            <tr key={p.id}>
              <td style={TD}><b>{p.name}</b>{p.pan ? <div style={MUTED}>PAN {p.pan}</div> : null}</td>
              <td style={TDR}>{rs(p.capital.balance)}</td><td style={{ ...TDR, fontWeight: 700 }}>{rs(p.loan.outstanding)}</td>
              <td style={TDR}>{rs(p.loan.interest_total)}</td><td style={TDR}>{rs(p.loan.interest_paid_net)}</td><td style={TDR}>{rs(p.loan.tds)}</td>
              <td style={{ ...TDR, fontWeight: 700, color: p.loan.interest_due < 0 ? "var(--signal-green)" : undefined }}>{rs(p.loan.interest_due)}</td>
              <td style={TDR}>{rs(p.loan.tds_on_due)}</td><td style={TDR}>{rs(p.loan.net_due)}</td>
              <td style={TD}><button type="button" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>{open === p.id ? "Hide" : "Statement"}</button></td>
            </tr>
          ))}
          <tr style={{ background: "var(--concrete)" }}>
            <td style={{ ...TD, fontWeight: 700 }}>Total</td><td style={{ ...TDR, fontWeight: 700 }}>{rs(t.capital)}</td><td style={{ ...TDR, fontWeight: 700 }}>{rs(t.loans)}</td>
            <td style={TDR}>{rs(t.interest_total)}</td><td style={TDR}>{rs(t.interest_paid_net)}</td><td style={TDR}>{rs(t.tds)}</td>
            <td style={{ ...TDR, fontWeight: 700 }}>{rs(t.interest_due)}</td><td style={TDR}>{rs(t.tds_on_due)}</td><td style={TDR}>{rs(t.net_due)}</td><td style={TD} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const FILTERS = [["all", "All"], ["capital", "Capital"], ["loan", "Loan"], ["interest", "Interest & TDS"]];
function PartnerDetail({ p, canEdit, onClose, onRecord, onEdit, onDelete }) {
  const [f, setF] = useState("all");
  const all = [...p.loan.ledger.map((x) => ({ ...x, book: "loan" })), ...p.capital.ledger.map((x) => ({ ...x, book: "capital" }))]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const rows = all.filter((x) => f === "all" || (f === "capital" ? x.book === "capital" : f === "loan" ? ["loan_in", "loan_out"].includes(x.kind) : ["interest_paid", "interest_due"].includes(x.kind)));
  const label = (x) => (x.kind === "interest_paid" ? (x.amount < 0 ? "Interest reversed" : x.amount === 0 && x.tds ? "TDS deducted" : "Interest paid") : KIND_LABEL[x.kind]);
  return (
    <section style={panel("1 1 100%")}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div>
          <h2 style={H2}>{p.name} — statement</h2>
          <div style={SUB}>Loan balance and interest due after each entry (interest worked to the day of the entry).</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {canEdit && <button type="button" className="btn-primary" style={{ padding: "7px 12px", fontSize: 12.5 }} onClick={onRecord}>+ Record for {p.name.split(" ")[0]}</button>}
          <button type="button" style={{ padding: "7px 12px", fontSize: 12.5 }} onClick={onClose}>Close</button>
        </div>
      </div>
      {p.fy.length > 0 && (
        <div style={{ ...GRID(260), marginTop: 12 }}>
          {p.fy.map((y) => (
            <div key={y.fy} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><b>FY {y.fy}</b><span style={MUTED}>{fmtDay(y.from)} – {fmtDay(y.to)}</span></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 8 }}>
                <Fig label="Interest" value={rs(y.interest)} /><Fig label="Paid" c={COL.paid} value={rs(y.paid_net)} /><Fig label="TDS" c={COL.tds} value={rs(y.tds)} />
              </div>
              {(y.borrowed || y.repaid || y.capital_in || y.capital_out) ? <div style={{ ...MUTED, marginTop: 6 }}>{[y.borrowed && `borrowed ${rs(y.borrowed)}`, y.repaid && `repaid ${rs(y.repaid)}`, y.capital_in && `capital in ${rs(y.capital_in)}`, y.capital_out && `capital returned ${rs(y.capital_out)}`].filter(Boolean).join(" · ")}</div> : null}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 14, flexWrap: "wrap" }}>
        {FILTERS.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={f === k} onClick={() => setF(k)}
            style={{ padding: "5px 12px", fontSize: 12, borderRadius: 20, fontWeight: 600, background: f === k ? "var(--charcoal)" : "var(--surface)", color: f === k ? "#fff" : "var(--charcoal)" }}>{l}</button>
        ))}
        <span style={{ ...MUTED, alignSelf: "center", marginLeft: 6 }}>{rows.length} entr{rows.length === 1 ? "y" : "ies"}</span>
      </div>
      <div style={{ overflow: "auto", maxHeight: "72vh", marginTop: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
        <table style={{ width: "100%", minWidth: 900, borderCollapse: "separate", borderSpacing: 0 }}>
          <thead><tr><th style={THS}>Date</th><th style={THS}>Entry</th><th style={{ ...THS, ...R }}>Amount</th><th style={{ ...THS, ...R }}>TDS</th><th style={{ ...THS, ...R }}>Loan after</th><th style={{ ...THS, ...R }}>Interest due after</th><th style={{ ...THS, ...R }}>Capital after</th><th style={THS}>Narration / note</th><th style={THS} /></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={`${x.book}-${x.id}`}>
                <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmtDay(x.date)}</td>
                <td style={TD}><span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}><Dot c={KIND_COL[x.kind]} />{label(x)}</span>{x.interest_from && x.interest_from !== x.date ? <div style={MUTED}>interest from {fmtDay(x.interest_from)}</div> : null}</td>
                <td style={TDR}>{x.amount === 0 && x.tds ? "—" : rs(x.amount)}</td><td style={TDR}>{x.tds ? rs(x.tds) : ""}</td>
                <td style={TDR}>{x.book === "loan" ? rs(x.balance) : ""}</td><td style={TDR}>{x.book === "loan" ? rs(x.interest_due) : ""}</td>
                <td style={TDR}>{x.book === "capital" ? rs(x.balance) : ""}</td>
                <td style={{ ...TD, ...MUTED, maxWidth: 280 }}>{[x.narration, x.note].filter(Boolean).join(" · ")}</td>
                <td style={{ ...TD, whiteSpace: "nowrap" }}>{canEdit && <>
                  <button type="button" style={{ padding: "3px 8px", fontSize: 11.5 }} onClick={() => onEdit({ id: x.id, partner_id: p.id, kind: x.kind, txn_date: x.date, amount: x.amount, tds: x.tds || "", note: x.note || "", interest_from: x.interest_from || "" })}>Edit</button>{" "}
                  <button type="button" style={{ padding: "3px 8px", fontSize: 11.5 }} onClick={() => onDelete(x)}>Remove</button></>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9} style={{ ...TD, ...MUTED }}>No entries{f === "all" ? " yet" : " of this kind"}.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- upload ---
function guessPartner(partners, narration) {
  const n = String(narration || "").toUpperCase();
  let best = null, score = 0;
  for (const p of partners) {
    if (!p.is_active) continue;
    const words = [...String(p.match_words || "").split(/[,;]/), ...String(p.name).split(/\s+/)]
      .map((w) => w.trim().toUpperCase()).filter((w) => w.length >= 4);
    const hit = words.filter((w) => n.includes(w)).reduce((a, w) => a + w.length, 0);
    if (hit > score) { score = hit; best = p.id; }
  }
  return best;
}

function UploadModal({ book: book0, d, onClose, onDone }) {
  const [book, setBook] = useState(book0);
  const [file, setFile] = useState(null);
  const [pw, setPw] = useState("");
  const [needPw, setNeedPw] = useState(false);
  const [lines, setLines] = useState(null);
  const [raw, setRaw] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const tdsRate = d.settings.tds_rate;
  const grossTds = (net) => Math.round((Number(net) * tdsRate) / (100 - tdsRate) * 100) / 100;

  function shape(rows, b) {
    return rows.map((r, i) => {
      const partner_id = guessPartner(d.partners, r.narration);
      const isCredit = r.credit > 0;
      const amount = isCredit ? r.credit : r.debit;
      const kind = b === "capital" ? (isCredit ? "capital_in" : "capital_out")
        : isCredit ? "loan_in" : /\bINT|INTEREST/i.test(r.narration || "") ? "interest_paid" : "loan_out";
      return { key: i, date: r.date, narration: r.narration, credit: isCredit, amount, kind, partner_id: partner_id ? String(partner_id) : "",
        tds: kind === "interest_paid" ? String(grossTds(amount)) : "", keep: !!partner_id };
    });
  }
  async function read(f = file, password = pw) {
    if (!f) return;
    setErr(""); setLines(null); setBusy(true);
    try {
      const { readFile, PdfPasswordError } = await import("../../lib/bankStatementParse.js");
      try {
        const r = await readFile(f, password);
        setRaw(r.rows); setLines(shape(r.rows, book)); setNeedPw(false);
      } catch (e) {
        if (e instanceof PdfPasswordError) { setNeedPw(true); setErr(e.wrong ? "That password did not open the PDF." : "This PDF is locked — type its password."); }
        else setErr(e.message);
      }
    } catch (e) { setErr(`The statement reader could not load (${e.message}).`); } finally { setBusy(false); }
  }
  const set = (k, patch) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const kept = (lines || []).filter((l) => l.keep && l.partner_id);
  async function save() {
    setBusy(true); setErr("");
    try {
      const r = await apiRequest("/cost/partners/upload", { method: "POST", body: { book, file_name: file?.name, lines: kept.map((l) => ({
        partner_id: Number(l.partner_id), kind: l.kind, txn_date: l.date, amount: l.amount, tds: l.kind === "interest_paid" ? Number(l.tds || 0) : 0, narration: l.narration })) } });
      onDone(`${r.added} line(s) saved${r.duplicates ? `, ${r.duplicates} already there — skipped` : ""}.`);
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  const kinds = book === "capital" ? ["capital_in", "capital_out"] : ["loan_in", "loan_out", "interest_paid"];
  return (
    <Modal title="Upload a bank statement — partners" onClose={onClose} width={1000}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 }}>The statement is for
          <select value={book} onChange={(e) => { setBook(e.target.value); if (raw) setLines(shape(raw, e.target.value)); }}>
            <option value="capital">Capital — brought in / returned</option>
            <option value="loan">Unsecured loans — borrowed / repaid / interest paid</option>
          </select></label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 }}>Excel / CSV (or PDF) with only these lines
          <input type="file" accept=".xls,.xlsx,.csv,.pdf" onChange={(e) => { const f = e.target.files?.[0]; setFile(f || null); setPw(""); setNeedPw(false); if (f) read(f, ""); }} /></label>
      </div>
      <div style={{ ...MUTED, marginTop: 8 }}>The file needs a Date column and Withdrawal / Deposit (or Debit / Credit) columns, like a bank statement. Each line is matched to a partner by the words on the partner; lines without a partner are left out.</div>
      {needPw && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 10 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 }}>PDF password<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          <button type="button" onClick={() => read()} disabled={!pw}>Open</button>
        </div>
      )}
      {busy && !lines && <div style={{ ...MUTED, marginTop: 10 }}>Reading…</div>}
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 10 }}>{err}</div>}
      {lines && (
        <>
          <div style={{ fontSize: 13, margin: "12px 0 6px", ...NUM }}><b>{lines.length} line(s) read</b> · {kept.length} to save
            {book === "loan" && <span style={MUTED}> · interest paid: the amount is what reached the partner; TDS filled at {num(tdsRate)}% of the interest (change it if different)</span>}</div>
          <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
            <table style={{ width: "100%", minWidth: 860, borderCollapse: "collapse" }}>
              <thead><tr><th style={THS}>Keep</th><th style={THS}>Date</th><th style={THS}>Narration</th><th style={{ ...THS, ...R }}>Amount</th><th style={THS}>Partner</th><th style={THS}>Entry</th><th style={THS}>TDS</th></tr></thead>
              <tbody>{lines.map((l) => (
                <tr key={l.key} style={{ opacity: l.keep ? 1 : 0.55 }}>
                  <td style={TD}><input type="checkbox" checked={l.keep} onChange={(e) => set(l.key, { keep: e.target.checked })} aria-label="Keep this line" /></td>
                  <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmtDay(l.date)}</td>
                  <td style={{ ...TD, fontSize: 12, maxWidth: 280 }}>{l.narration}</td>
                  <td style={{ ...TDR, color: l.credit ? "var(--signal-green)" : undefined }}>{l.credit ? "+" : "−"}{rs(l.amount)}</td>
                  <td style={TD}><select value={l.partner_id} onChange={(e) => set(l.key, { partner_id: e.target.value, keep: !!e.target.value })}>
                    <option value="">— none —</option>{d.partners.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
                  <td style={TD}><select value={l.kind} onChange={(e) => set(l.key, { kind: e.target.value, tds: e.target.value === "interest_paid" ? String(grossTds(l.amount)) : "" })}>
                    {kinds.filter((k) => (l.credit ? ["capital_in", "loan_in"] : ["capital_out", "loan_out", "interest_paid"]).includes(k)).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></td>
                  <td style={TD}>{l.kind === "interest_paid" ? <input inputMode="decimal" value={l.tds} onChange={(e) => set(l.key, { tds: e.target.value })} style={{ width: 100 }} aria-label="TDS deducted" /> : ""}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" disabled={busy || !kept.length} onClick={save}>{busy ? "Saving…" : `Save ${kept.length} line(s)`}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// Round 247 — "Record an entry": what happened, in the owner's words. Interest
// paid is typed as the interest (before TDS) and the TDS deducted — no TDS
// unless typed; the partner got the difference. "TDS deducted" on its own is
// TDS on interest with nothing paid out that day.
const TYPES = [
  ["capital_in", "Capital brought in", COL.capital], ["capital_out", "Capital returned", COL.capital],
  ["loan_in", "Loan received", COL.loan], ["loan_out", "Loan repaid", COL.loan],
  ["interest_paid", "Interest paid", COL.paid], ["tds_only", "TDS deducted", COL.tds],
  ["interest_due", "Interest owed at start", COL.due],
];
function EntryModal({ entry, d, onClose, onDone }) {
  const tdsOnly = entry.kind === "interest_paid" && entry.id && Number(entry.amount) === 0 && Number(entry.tds) > 0;
  const gross0 = entry.kind === "interest_paid" && entry.id ? Math.round((Number(entry.amount) + Number(entry.tds || 0)) * 100) / 100 : "";
  const [f, setF] = useState({
    partner_id: String(entry.partner_id || d.partners.find((p) => p.is_active)?.id || ""),
    type: tdsOnly ? "tds_only" : entry.kind, txn_date: entry.txn_date,
    amount: entry.kind === "interest_paid" ? (tdsOnly ? "" : String(gross0)) : String(entry.amount ?? ""),
    tds: entry.kind === "interest_paid" && Number(entry.tds) ? String(entry.tds) : "",
    note: entry.note || "", interest_from: entry.interest_from || "",
  });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const n = (v) => Number(String(v || "").replace(/[,₹\s]/g, "")) || 0;
  const rate = d.settings.tds_rate;
  const net = Math.round((n(f.amount) - n(f.tds)) * 100) / 100;
  const p = d.partners.find((x) => String(x.id) === f.partner_id);
  async function save(e) {
    e.preventDefault(); setErr("");
    let body = { partner_id: Number(f.partner_id), txn_date: f.txn_date, note: f.note };
    if (f.type === "interest_paid") {
      if (n(f.tds) < 0) return setErr("TDS can't be negative.");
      if (n(f.amount) > 0 && n(f.tds) > n(f.amount)) return setErr("TDS is more than the interest.");
      body = { ...body, kind: "interest_paid", amount: net, tds: n(f.tds) };
    } else if (f.type === "tds_only") {
      if (!(n(f.tds) > 0)) return setErr("Type the TDS deducted.");
      body = { ...body, kind: "interest_paid", amount: 0, tds: n(f.tds) };
    } else body = { ...body, kind: f.type, amount: n(f.amount), interest_from: f.type === "loan_in" ? f.interest_from : "" };
    setBusy(true);
    try {
      if (entry.id) await apiRequest(`/cost/partners/txns/${entry.id}`, { method: "PUT", body });
      else await apiRequest("/cost/partners/txns", { method: "POST", body });
      const what = f.type === "tds_only" ? "TDS deducted" : KIND_LABEL[f.type];
      onDone(`${entry.id ? "Changed" : "Recorded"}: ${what} — ${p?.name || ""}, ${fmtDay(f.txn_date)}.`);
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }
  const lab = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 };
  const chip = (on, c) => ({ display: "flex", alignItems: "center", gap: 7, padding: "9px 10px", fontSize: 12.5, fontWeight: 600, borderRadius: 8, textAlign: "left",
    border: `1.5px solid ${on ? c : "var(--border-strong)"}`, background: on ? "var(--concrete)" : "var(--surface)", color: "var(--charcoal)" });
  return (
    <Modal title={entry.id ? "Change an entry" : "Record an entry"} onClose={onClose} width={620}>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <label style={lab}>Partner<select value={f.partner_id} onChange={set("partner_id")} required>
            {d.partners.filter((x) => x.is_active || String(x.id) === f.partner_id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <label style={lab}>Date<input type="date" value={f.txn_date} onChange={set("txn_date")} required /></label>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ ...lab, marginBottom: 6 }}>What happened</legend>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8 }}>
            {TYPES.map(([k, l, c]) => (
              <button key={k} type="button" aria-pressed={f.type === k} style={chip(f.type === k, c)} onClick={() => setF({ ...f, type: k })}><Dot c={c} />{l}</button>
            ))}
          </div>
        </fieldset>

        {f.type === "interest_paid" ? (
          <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, alignItems: "end" }}>
            <label style={lab}>Interest (before TDS)<input inputMode="decimal" value={f.amount} onChange={set("amount")} required autoFocus /></label>
            <label style={lab}>TDS deducted
              <input inputMode="decimal" value={f.tds} onChange={set("tds")} placeholder="0 — no TDS" /></label>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setF({ ...f, tds: "" })}>No TDS</button>
              <button type="button" style={{ padding: "6px 10px", fontSize: 12 }} disabled={!n(f.amount)} onClick={() => setF({ ...f, tds: String(Math.round(n(f.amount) * rate) / 100) })}>TDS {num(rate)}%</button>
            </div>
            <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "space-between", fontSize: 13.5, borderTop: "1px solid var(--border-strong)", paddingTop: 8 }}>
              <span>Paid to {p?.name || "the partner"}</span><b style={NUM}>{rs(net)}</b>
            </div>
            <div style={{ ...MUTED, gridColumn: "1 / -1" }}>Interest settled = paid + TDS. A negative interest reverses interest paid too early.{p ? ` Interest due for ${p.name} now: ${rs(p.loan.interest_due)}.` : ""}</div>
          </div>
        ) : f.type === "tds_only" ? (
          <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
            <label style={lab}>TDS deducted<input inputMode="decimal" value={f.tds} onChange={set("tds")} required autoFocus /></label>
            <div style={MUTED}>TDS on the partner’s interest with nothing paid out that day — it counts as interest settled. If TDS was cut from a payment, use “Interest paid” instead.</div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <label style={lab}>Amount<input inputMode="decimal" value={f.amount} onChange={set("amount")} required autoFocus /></label>
            {f.type === "loan_in" && <label style={lab}>Interest from (blank = the date above)<input type="date" value={f.interest_from} onChange={set("interest_from")} /></label>}
            {f.type === "interest_due" && <div style={{ ...MUTED, gridColumn: "1 / -1" }}>Interest owed to the partner on that date for the time before the entries here. It is added to the interest due.</div>}
          </div>
        )}
        <label style={lab}>Note<input value={f.note} onChange={set("note")} maxLength={200} placeholder="e.g. bank ref, cheque no." /></label>
        {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving…" : entry.id ? "Save" : "Record"}</button>
        </div>
      </form>
    </Modal>
  );
}

function SetupModal({ d, onClose, onDone }) {
  const [rate, setRate] = useState(String(d.settings.loan_rate));
  const [tds, setTds] = useState(String(d.settings.tds_rate));
  const [rates, setRates] = useState(d.settings.rates.map((r) => ({ from_date: r.from_date, rate: String(r.rate) })));
  const [p, setP] = useState({ name: "", match_words: "", pan: "" });
  const [editId, setEditId] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function saveSettings() {
    setBusy(true); setErr("");
    try { await apiRequest("/cost/partners/settings", { method: "PUT", body: { loan_rate: Number(rate), tds_rate: Number(tds), rates: rates.filter((r) => r.from_date && r.rate !== "").map((r) => ({ from_date: r.from_date, rate: Number(r.rate) })) } }); onDone("Rates saved."); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function savePartner(e) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      if (editId) await apiRequest(`/cost/partners/partners/${editId}`, { method: "PUT", body: p });
      else await apiRequest("/cost/partners/partners", { method: "POST", body: p });
      setP({ name: "", match_words: "", pan: "" }); setEditId(null); onDone(editId ? "Partner changed." : "Partner added.");
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  }
  // Round 245 — merge two spellings of one partner; remove empty partners.
  async function mergeInto(from, into) {
    if (!into || !window.confirm(`Merge "${from.name}" into "${into.name}"?\n\nAll ${from.txn_count || 0} entr${from.txn_count === 1 ? "y" : "ies"} of "${from.name}" move to "${into.name}", and "${from.name}" is removed.`)) return;
    setBusy(true); setErr("");
    try { const x = await apiRequest(`/cost/partners/partners/${from.id}/merge`, { method: "POST", body: { into: into.id } }); onDone(`"${x.removed}" merged into "${x.kept}" — ${x.moved} entr${x.moved === 1 ? "y" : "ies"} moved.`); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function removePartner(x) {
    if (!window.confirm(`Remove "${x.name}"? It has no entries.`)) return;
    setBusy(true); setErr("");
    try { await apiRequest(`/cost/partners/partners/${x.id}`, { method: "DELETE" }); onDone(`"${x.name}" removed.`); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function removeEmpty() {
    const list = d.partners.filter((x) => !x.txn_count);
    if (!window.confirm(`Remove these partners — they have no entries?\n\n${list.map((x) => x.name).join("\n")}`)) return;
    setBusy(true); setErr("");
    try { const x = await apiRequest("/cost/partners/partners/remove-empty", { method: "POST" }); onDone(`${x.removed} partner(s) with no entries removed.`); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const lab = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 };
  return (
    <Modal title="Partners & interest rates" onClose={onClose} width={860}>
      <h3 style={{ ...H2, fontSize: 14 }}>Partners</h3>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
        <thead><tr><th style={TH}>Name</th><th style={TH}>Words on their bank lines</th><th style={TH}>PAN</th><th style={{ ...TH, ...R }}>Entries</th><th style={TH} /></tr></thead>
        <tbody>{d.partners.map((x) => (
          <tr key={x.id} style={{ opacity: x.is_active ? 1 : 0.55 }}><td style={TD}>{x.name}</td><td style={{ ...TD, ...MUTED }}>{x.match_words || "—"}</td><td style={TD}>{x.pan || "—"}</td>
            <td style={TDR}>{x.txn_count || <span style={MUTED}>none</span>}</td>
            <td style={{ ...TD, whiteSpace: "nowrap" }}>
              <button type="button" style={{ padding: "3px 8px", fontSize: 11.5 }} onClick={() => { setEditId(x.id); setP({ name: x.name, match_words: x.match_words || "", pan: x.pan || "", is_active: x.is_active }); }}>Edit</button>{" "}
              {d.partners.length > 1 && (
                <select value="" aria-label={`Merge ${x.name} into`} style={{ fontSize: 11.5, maxWidth: 150 }} onChange={(e) => e.target.value && mergeInto(x, d.partners.find((y) => y.id === Number(e.target.value)))}>
                  <option value="">Merge into…</option>
                  {d.partners.filter((y) => y.id !== x.id).map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
                </select>
              )}{" "}
              {!x.txn_count && <button type="button" style={{ padding: "3px 8px", fontSize: 11.5 }} disabled={busy} onClick={() => removePartner(x)}>Remove</button>}
            </td></tr>))}
          {!d.partners.length && <tr><td colSpan={5} style={{ ...TD, ...MUTED }}>None yet.</td></tr>}
        </tbody>
      </table>
      <div style={{ ...MUTED, marginTop: 6 }}>
        Same partner twice (two spellings)? <b>Merge into…</b> moves every entry onto the partner you keep and removes the other.
        {d.partners.some((x) => !x.txn_count) && <> <button type="button" style={{ padding: "3px 8px", fontSize: 11.5, marginLeft: 6 }} disabled={busy} onClick={removeEmpty}>Remove the {d.partners.filter((x) => !x.txn_count).length} partner(s) with no entries</button></>}
      </div>
      <form onSubmit={savePartner} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginTop: 10, alignItems: "end" }}>
        <label style={lab}>{editId ? "Change name" : "New partner"}<input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} required maxLength={120} /></label>
        <label style={lab}>Words on bank lines<input value={p.match_words} onChange={(e) => setP({ ...p, match_words: e.target.value })} placeholder="e.g. PRAMOD, P K NAIR" maxLength={300} /></label>
        <label style={lab}>PAN (for TDS)<input value={p.pan} onChange={(e) => setP({ ...p, pan: e.target.value })} maxLength={10} /></label>
        {editId && <label style={{ display: "flex", gap: 6, fontSize: 12.5, alignItems: "center" }}><input type="checkbox" checked={p.is_active !== false} onChange={(e) => setP({ ...p, is_active: e.target.checked })} /> Active</label>}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" className="btn-primary" disabled={busy}>{editId ? "Save" : "Add"}</button>
          {editId && <button type="button" onClick={() => { setEditId(null); setP({ name: "", match_words: "", pan: "" }); }}>Cancel</button>}
        </div>
      </form>

      <h3 style={{ ...H2, fontSize: 14, marginTop: 18 }}>Interest on the partners’ loans</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginTop: 6 }}>
        <label style={lab}>Interest, % a year<input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></label>
        <label style={lab}>TDS on the interest, %<input inputMode="decimal" value={tds} onChange={(e) => setTds(e.target.value)} /></label>
      </div>
      <div style={{ ...MUTED, marginTop: 6 }}>Rate changes (optional) — the new rate applies from that date to every partner’s loan.</div>
      {rates.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
          <input type="date" value={r.from_date} onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, from_date: e.target.value } : x)))} aria-label="Rate from" />
          <input inputMode="decimal" value={r.rate} onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} style={{ width: 90 }} aria-label="Rate %" /> %
          <button type="button" onClick={() => setRates(rates.filter((_, j) => j !== i))} aria-label="Remove rate change">✕</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button type="button" onClick={() => setRates([...rates, { from_date: "", rate: "" }])}>+ Rate change</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={saveSettings}>Save rates</button>
      </div>
      {d.settings.sheet_closed_at && (
        <div style={{ ...MUTED, marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          Investment &amp; Loan sheet confirmed {new Date(d.settings.sheet_closed_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}{d.settings.sheet_closed_by ? ` by ${d.settings.sheet_closed_by}` : ""} — entries are recorded in the app.{" "}
          <button type="button" style={{ padding: "3px 8px", fontSize: 11.5 }} disabled={busy} onClick={async () => {
            if (!window.confirm("Bring back the sheet import and the statement upload?")) return;
            setBusy(true); setErr("");
            try { await apiRequest("/cost/partners/sheet-close", { method: "POST", body: { open: true } }); onDone("Sheet import and statement upload are back."); }
            catch (e) { setErr(e.message); } finally { setBusy(false); }
          }}>Open the sheet import again</button>
        </div>
      )}
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 10 }}>{err}</div>}
    </Modal>
  );
}

function exportPartners(d) {
  const t = d.totals;
  const loans = [["Partner", "PAN", "Borrowed", "Repaid", "Outstanding", "Interest till date", "Interest paid (incl. TDS)", "Paid to partner", "TDS deducted", "Interest due", "TDS on due", "Net to pay"],
    ...d.partners.map((p) => [p.name, p.pan || "", p.loan.borrowed, p.loan.repaid, p.loan.outstanding, p.loan.interest_total, p.loan.interest_paid_gross, p.loan.interest_paid_net, p.loan.tds, p.loan.interest_due, p.loan.tds_on_due, p.loan.net_due]),
    ["Total", "", t.borrowed, t.repaid, t.loans, t.interest_total, t.interest_paid_gross, t.interest_paid_net, t.tds, t.interest_due, t.tds_on_due, t.net_due]];
  const capital = [["Partner", "Brought in", "Returned", "Capital"], ...d.partners.map((p) => [p.name, p.capital.brought_in, p.capital.returned, p.capital.balance]), ["Total", t.capital_in, t.capital_out, t.capital]];
  const fy = [["Partner", "Financial year", "Interest", "Paid to partner", "TDS deducted", "Borrowed", "Repaid", "Capital in", "Capital out"],
    ...d.partners.flatMap((p) => p.fy.map((f) => [p.name, f.fy, f.interest, f.paid_net, f.tds, f.borrowed, f.repaid, f.capital_in, f.capital_out]))];
  const entries = [["Partner", "Date", "Entry", "Amount", "TDS", "Loan after", "Interest due after", "Capital after", "Narration", "Note"],
    ...d.partners.flatMap((p) => [...p.loan.ledger.map((x) => [p.name, x.date, (x.kind === "interest_paid" && x.amount === 0 && x.tds ? "TDS deducted" : KIND_LABEL[x.kind]), x.amount, x.tds, x.balance, x.interest_due, "", x.narration || "", x.note || ""]),
      ...p.capital.ledger.map((x) => [p.name, x.date, KIND_LABEL[x.kind], x.amount, "", "", "", x.balance, x.narration || "", x.note || ""])])];
  downloadExcel(`Partners_${d.as_of}.xlsx`, [{ name: "Loans", rows: loans }, { name: "Capital", rows: capital }, { name: "By year", rows: fy }, { name: "Entries", rows: entries }]);
}

// Round 244 — the latest imported sheet's own totals beside the app's, on the
// sheet's date (its "Today").
function SheetCheck({ c, canEdit, onConfirm }) {
  const rows = c.rows.filter((x) => x.sheet.loan || x.sheet.capital);
  // Round 247 — a sheet with no investment rows says nothing about capital: no capital column then.
  const hasCap = rows.some((x) => x.sheet.capital);
  const keys = hasCap ? ["capital", "loan", "interest", "paid", "balance"] : ["loan", "interest", "paid", "balance"];
  const diff = (a, b) => Math.abs((a || 0) - (b || 0));
  const worst = Math.max(0, ...rows.flatMap((x) => keys.map((k) => diff(x.app[k], x.sheet[k]))));
  const ok = worst < 1;
  const cell = (a, b) => (
    <td style={{ ...TDR, color: diff(a, b) >= 1 ? "var(--alert-red)" : undefined }}>{rs(a)}{diff(a, b) >= 1 ? <div style={MUTED}>sheet {rs(b)}</div> : null}</td>
  );
  return (
    <section style={{ ...panel("1 1 100%"), borderColor: ok ? "#BFDCCB" : "#E8C4BF" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <h2 style={H2}>Checked against your sheet {ok ? "— the app agrees" : "— differences"}</h2>
          <div style={SUB}>{c.file_name || "Sheet"} · on the sheet’s date {fmtDay(c.as_on)} · {ok ? `every figure agrees to the rupee (largest difference ₹${num(worst, 2)}, rounding)` : `largest difference ₹${num(worst, 2)} — shown in red with the sheet’s figure`}{hasCap ? "" : " · the sheet has no capital rows, so capital is not compared"}</div>
        </div>
        {canEdit && <button type="button" className="btn-primary" style={BTN} onClick={onConfirm}>Figures are right — close the sheet import</button>}
      </div>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ width: "100%", minWidth: 680, borderCollapse: "collapse" }}>
          <thead><tr><th style={TH}>Partner</th>{hasCap && <th style={{ ...TH, ...R }}>Capital</th>}<th style={{ ...TH, ...R }}>Loan</th><th style={{ ...TH, ...R }}>Interest till then</th><th style={{ ...TH, ...R }}>Interest paid (before TDS)</th><th style={{ ...TH, ...R }}>Interest balance</th></tr></thead>
          <tbody>{rows.map((x) => (
            <tr key={x.name}><td style={TD}><b>{x.partner || x.name}</b>{x.partner && x.partner.toLowerCase() !== x.name.toLowerCase() ? <div style={MUTED}>“{x.name}” on the sheet</div> : null}</td>{hasCap && cell(x.app.capital, x.sheet.capital)}{cell(x.app.loan, x.sheet.loan)}{cell(x.app.interest, x.sheet.interest)}{cell(x.app.paid, x.sheet.paid)}{cell(x.app.balance, x.sheet.balance)}</tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

function ImportSheetModal({ d, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [r, setR] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState(true);
  // Round 245 — which existing partner each sheet name is, and what to take.
  const [map, setMap] = useState({});
  const [parts, setParts] = useState({ capital: !d.partners.some((p) => p.capital.brought_in > 0), loans: true });
  async function read(f) {
    setErr(""); setR(null); setBusy(true);
    try {
      const XLSX = await import("xlsx");
      const { readPartnerSheet } = await import("../../lib/partnerSheetImport.js");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const res = readPartnerSheet(XLSX, wb);
      setR(res);
      setMap(Object.fromEntries(Object.keys(res.check.partners).map((n) => [n, String(sheetPartnerFor(n, d.partners) ?? "new")])));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setErr("");
    try {
      const x = await apiRequest("/cost/partners/import-sheet", { method: "POST", body: { file_name: file?.name, replace, entries: r.entries, check: r.check, map, parts } });
      onDone(`${x.added} entr${x.added === 1 ? "y" : "ies"} imported${x.partners_made ? `, ${x.partners_made} partner(s) added` : ""}${x.removed ? `, ${x.removed} from the earlier sheet import replaced` : ""}${x.duplicates ? `, ${x.duplicates} already there` : ""}.`);
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  const per = r ? Object.entries(r.check.partners).map(([n, c]) => ({ n, c, k: r.entries.filter((e) => e.partner === n) })) : [];
  const sum = (list, kind, f = "amount") => list.filter((e) => e.kind === kind).reduce((a, e) => a + (Number(e[f]) || 0), 0);
  return (
    <Modal title="Import your Investment & Loan sheet" onClose={onClose} width={980}>
      <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
        The Excel with the <b>Investment &amp; Loan</b> table (Date, Narration, Amount, Type of Fund, Investor Name, Interest %, Interest Start Date, Loan Pay Back Date, Interest Amount, the interest-paid columns, Balance). Hidden sheets are left out.
        Investments → capital; Partner’s Loan → loans with their interest start date; negative rows → paid back; each interest-paid column → interest paid on that date; TDS from the summary table’s “TDS Deducted” column.
      </div>
      <input type="file" accept=".xlsx,.xls" style={{ marginTop: 10 }} onChange={(e) => { const f = e.target.files?.[0]; setFile(f || null); if (f) read(f); }} />
      {busy && !r && <div style={{ ...MUTED, marginTop: 8 }}>Reading…</div>}
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 10 }}>{err}</div>}
      {r && (
        <>
          <div style={{ fontSize: 13, margin: "12px 0 6px", ...NUM }}>
            <b>{r.entries.length} entries</b> from “{r.sheet}” · sheet date {fmtDay(r.as_on)} · {r.pay_columns.length} interest-paid columns ({r.pay_columns.map((p) => fmtDay(p.date)).join(", ")})
            {r.rates.some((x) => x !== d.settings.loan_rate) && <div style={{ color: "var(--alert-red)" }}>The sheet uses {r.rates.join(", ")}% — the app’s rate is {num(d.settings.loan_rate, 2)}% (Partners &amp; rates).</div>}
            {r.tds_missed.length > 0 && <div style={{ color: "var(--amber)" }}>TDS not matched to an interest payment: {r.tds_missed.join(", ")}</div>}
          </div>
          <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
            <table style={{ width: "100%", minWidth: 820, borderCollapse: "collapse" }}>
              <thead><tr><th style={THS}>Name on the sheet</th><th style={THS}>Goes to partner</th><th style={{ ...THS, ...R }}>Capital in − out</th><th style={{ ...THS, ...R }}>Loans in</th><th style={{ ...THS, ...R }}>Paid back</th><th style={{ ...THS, ...R }}>Interest paid (before TDS)</th><th style={{ ...THS, ...R }}>TDS</th><th style={{ ...THS, ...R }}>Sheet: interest balance</th></tr></thead>
              <tbody>{per.map(({ n, c, k }) => (
                <tr key={n}><td style={TD}><b>{n}</b></td>
                  <td style={TD}>
                    <select value={map[n] || "new"} onChange={(e) => setMap({ ...map, [n]: e.target.value })} aria-label={`Partner for ${n}`} style={{ fontSize: 12.5, maxWidth: 220, borderColor: map[n] === "new" ? "var(--amber)" : undefined }}>
                      <option value="new">+ new partner “{n}”</option>
                      {d.partners.map((p) => <option key={p.id} value={p.id}>{p.name}{p.capital.balance ? ` · capital ${rs(p.capital.balance)}` : ""}</option>)}
                    </select>
                  </td>
                  <td style={{ ...TDR, opacity: parts.capital ? 1 : 0.4 }}>{rs(sum(k, "capital_in") - sum(k, "capital_out"))}</td><td style={TDR}>{rs(sum(k, "loan_in"))}</td><td style={TDR}>{rs(sum(k, "loan_out"))}</td>
                  <td style={TDR}>{rs(sum(k, "interest_paid") + sum(k, "interest_paid", "tds"))}</td><td style={TDR}>{rs(sum(k, "interest_paid", "tds"))}</td><td style={TDR}>{rs(c.balance)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 13, marginTop: 10 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={parts.capital} onChange={(e) => setParts({ ...parts, capital: e.target.checked })} /> Import investments (capital)
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={parts.loans} onChange={(e) => setParts({ ...parts, loans: e.target.checked })} /> Import partner’s loans and interest paid
            </label>
          </div>
          {parts.capital && d.partners.some((p) => p.capital.brought_in > 0) && (
            <Note>Capital is already entered for {d.partners.filter((p) => p.capital.brought_in > 0).map((p) => p.name).join(", ")}. Importing investments too counts that capital twice — untick “Import investments” unless those entries are removed first.</Note>
          )}
          {Object.values(map).some((v) => v === "new") && d.partners.length > 0 && (
            <div style={{ ...MUTED, marginTop: 6, color: "var(--amber)" }}>Names marked “+ new partner” are added as new partners — pick the existing partner if it is the same person spelt differently.</div>
          )}
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 10 }}>
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace the earlier import of this sheet (entries typed in or from bank statements are kept)
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" disabled={busy || (!parts.capital && !parts.loans)} onClick={save}>{busy ? "Importing…" : `Import ${r.entries.filter((e) => (["capital_in", "capital_out"].includes(e.kind) ? parts.capital : parts.loans)).length} entries`}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// Round 245 — the existing partner a sheet name most likely is: same first
// name, then the rest of the name or initials ("Santosh KS" = "SANTOSH K.S",
// "Ajith Kumar" = "AJITH KUMAR P. V", "Sajeev K" = "SAJEEV KARAYIL").
function nameTokens(s) {
  const raw = String(s || "").toUpperCase().replace(/[^A-Z ]+/g, " ").split(/\s+/).filter(Boolean);
  const out = [];
  let run = "";
  for (const t of raw) {
    if (t.length === 1) { run += t; continue; }
    if (run) { out.push(run); run = ""; }
    out.push(t);
  }
  if (run) out.push(run);
  return out;
}
export function sheetPartnerFor(sheetName, partners) {
  const a = nameTokens(sheetName);
  if (!a.length) return null;
  let best = null, bestScore = 0, tie = false;
  for (const p of partners) {
    const b = nameTokens(p.name);
    const words = nameTokens(String(p.match_words || "").replace(/[,;]/g, " "));
    if (!b.length) continue;
    let score = 0;
    if (a.join(" ") === b.join(" ")) score += 100;
    if (a[0] === b[0]) score += 20;
    else if (words.includes(a[0])) score += 12;
    else continue;
    for (const t of a.slice(1)) {
      if (b.includes(t) || words.includes(t)) score += 6;
      else if (b.slice(1).some((u) => u.startsWith(t) || t.startsWith(u) || u[0] === t[0])) score += 3;
    }
    if (score > bestScore) { best = p.id; bestScore = score; tie = false; } else if (score === bestScore) tie = true;
  }
  return best && !tie ? best : null;
}
