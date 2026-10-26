// Round 242 — Cost → Partners (owner, 26 Oct 2026): partners' capital
// (brought in and returned) and unsecured loans from partners (14% a year
// from the day borrowed, interest paid, interest still due, TDS). Lines come
// from a bank statement upload — Excel, CSV or PDF, read in the browser by the
// same reader as Bank statements — or are typed one by one. Same permission as
// Bank statements (cost.bank). Arithmetic: backend lib/partners.js.
import { useState } from "react";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { apiRequest } from "../../lib/api.js";
import { istDay } from "../../lib/istDate.js";
import { useCostData, Loading, Actions, BTN, Tile, Note, Modal, downloadExcel, rs, rsL, num, fmtDay, H2, SUB, MUTED, R, NUM, GRID, panel } from "./costUi.jsx";

const KIND_LABEL = {
  capital_in: "Capital brought in", capital_out: "Capital returned",
  loan_in: "Loan borrowed", loan_out: "Principal repaid", interest_paid: "Interest paid", interest_due: "Interest owed at start",
};
const istToday = () => istDay();
const TH = { textAlign: "left", fontSize: 11.5, color: "var(--slate)", fontWeight: 600, padding: "6px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
const TD = { padding: "7px 8px", borderBottom: "1px solid var(--border)", fontSize: 13 };
const TDR = { ...TD, ...R };

export default function CostPartnersTab() {
  const { can } = usePermissions();
  const canEdit = can("cost.bank", "edit");
  const [asOf, setAsOf] = useState(istToday());
  const { data: d, error, reload } = useCostData(`/cost/partners?as_of=${asOf}`);
  const [open, setOpen] = useState(null);
  const [upload, setUpload] = useState(null);   // "capital" | "loan"
  const [entry, setEntry] = useState(null);     // entry object
  const [setup, setSetup] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState("");

  const head = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 14 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Partners</h1>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4 }}>Capital brought in and returned · unsecured loans from partners with interest from the day borrowed, interest paid, TDS and what is still due</div>
      </div>
      <Actions>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600 }}>As on
          <input type="date" value={asOf} max="2099-12-31" onChange={(e) => e.target.value && setAsOf(e.target.value)} style={{ minHeight: 40 }} /></label>
        <button type="button" style={BTN} disabled={!d} onClick={() => exportPartners(d)}>Export Excel</button>
        {canEdit && <button type="button" style={BTN} onClick={() => setSetup(true)}>Partners &amp; rates</button>}
        {canEdit && <button type="button" style={BTN} disabled={!d?.partners.length} onClick={() => setEntry({ kind: "loan_in", txn_date: istToday() })}>Add an entry</button>}
        {canEdit && <button type="button" style={BTN} disabled={!d} onClick={() => setImporting(true)}>Import my Investment &amp; Loan sheet</button>}
        {canEdit && <button type="button" className="btn-primary" style={BTN} disabled={!d?.partners.length} onClick={() => setUpload("capital")}>Upload statement</button>}
      </Actions>
    </div>
  );
  if (!d) return <>{head}<div style={{ marginTop: 16 }}><Loading error={error} /></div></>;
  const t = d.totals, s = d.settings;
  const active = d.partners.filter((p) => p.is_active || p.txn_count);
  const done = (m) => { setMsg(m); reload(); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {head}
      {msg && <Note tone="good">{msg}</Note>}
      {d.sheet_check && <SheetCheck c={d.sheet_check} />}
      {!d.partners.length && <Note>Add the partners first (Partners &amp; rates) — their names, and words their bank lines carry, so the upload can match each line to a partner.</Note>}

      <div style={GRID(200)}>
        <Tile dark label="Partners’ capital" value={rsL(t.capital)} note={`brought in ${rsL(t.capital_in)} · returned ${rsL(t.capital_out)}`} />
        <Tile label="Unsecured loans from partners" value={rsL(t.loans)} note={`borrowed ${rsL(t.borrowed)} · repaid ${rsL(t.repaid)} · ${num(s.loan_rate, 2)}% a year`} />
        <Tile label="Interest due (before TDS)" value={rs(t.interest_due)} note={`TDS ${num(s.tds_rate)}% ${rs(t.tds_on_due)} · net to pay ${rs(t.net_due)}`} />
        <Tile label="Interest till date" value={rs(t.interest_total)} note={`paid ${rs(t.interest_paid_gross)} = ${rs(t.interest_paid_net)} to partners + ${rs(t.tds)} TDS`} />
        <Tile label={`Interest FY ${d.fy}`} value={rs(t.fy_interest)} note={`TDS deducted this year ${rs(t.fy_tds)} · paid ${rs(t.fy_paid_net)}`} />
      </div>

      {active.length > 0 && (
        <section style={panel("1 1 100%")}>
          <h2 style={H2}>Unsecured loans — as on {fmtDay(d.as_of)}</h2>
          <div style={SUB}>Interest {num(s.loan_rate, 2)}% a year, simple, by days from each amount’s interest start date (the day it came in, unless another date is set on the entry) to the as-on date — counted like your sheet (as-on date − start date){s.rates.length ? `, with rate changes from ${s.rates.map((r) => `${fmtDay(r.from_date)} (${num(r.rate, 2)}%)`).join(", ")}` : ""}. Interest paid counts with its TDS (what reached the partner + TDS deducted).</div>
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table style={{ width: "100%", minWidth: 900, borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={TH}>Partner</th><th style={{ ...TH, ...R }}>Borrowed</th><th style={{ ...TH, ...R }}>Repaid</th><th style={{ ...TH, ...R }}>Outstanding</th>
                <th style={{ ...TH, ...R }}>Interest till date</th><th style={{ ...TH, ...R }}>Paid (incl. TDS)</th><th style={{ ...TH, ...R }}>TDS deducted</th>
                <th style={{ ...TH, ...R }}>Interest due</th><th style={{ ...TH, ...R }}>TDS on due</th><th style={{ ...TH, ...R }}>Net to pay</th><th style={TH} />
              </tr></thead>
              <tbody>
                {active.map((p) => (
                  <tr key={p.id}>
                    <td style={TD}><b>{p.name}</b>{p.pan ? <div style={MUTED}>PAN {p.pan}</div> : null}{p.loan.first_date ? <div style={MUTED}>since {fmtDay(p.loan.first_date)}</div> : null}</td>
                    <td style={TDR}>{rs(p.loan.borrowed)}</td><td style={TDR}>{rs(p.loan.repaid)}</td><td style={{ ...TDR, fontWeight: 700 }}>{rs(p.loan.outstanding)}</td>
                    <td style={TDR}>{rs(p.loan.interest_total)}</td><td style={TDR}>{rs(p.loan.interest_paid_gross)}</td><td style={TDR}>{rs(p.loan.tds)}</td>
                    <td style={{ ...TDR, fontWeight: 700, color: p.loan.interest_due < 0 ? "var(--signal-green)" : undefined }}>{rs(p.loan.interest_due)}</td>
                    <td style={TDR}>{rs(p.loan.tds_on_due)}</td><td style={TDR}>{rs(p.loan.net_due)}</td>
                    <td style={TD}><button type="button" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>{open === p.id ? "Hide" : "Details"}</button></td>
                  </tr>
                ))}
                <tr>
                  <td style={{ ...TD, fontWeight: 700 }}>Total</td><td style={TDR}>{rs(t.borrowed)}</td><td style={TDR}>{rs(t.repaid)}</td><td style={{ ...TDR, fontWeight: 700 }}>{rs(t.loans)}</td>
                  <td style={TDR}>{rs(t.interest_total)}</td><td style={TDR}>{rs(t.interest_paid_gross)}</td><td style={TDR}>{rs(t.tds)}</td>
                  <td style={{ ...TDR, fontWeight: 700 }}>{rs(t.interest_due)}</td><td style={TDR}>{rs(t.tds_on_due)}</td><td style={TDR}>{rs(t.net_due)}</td><td style={TD} />
                </tr>
              </tbody>
            </table>
          </div>
          {active.some((p) => p.loan.interest_due < 0) && <div style={{ ...MUTED, marginTop: 6 }}>A negative interest due means more interest has been paid than has accrued so far (paid in advance).</div>}
        </section>
      )}

      {active.length > 0 && (
        <section style={panel("1 1 100%")}>
          <h2 style={H2}>Capital</h2>
          <div style={SUB}>Capital brought in less capital returned. The Balance Sheet’s Capital line takes this figure once any capital is entered here.</div>
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table style={{ width: "100%", minWidth: 560, borderCollapse: "collapse" }}>
              <thead><tr><th style={TH}>Partner</th><th style={{ ...TH, ...R }}>Brought in</th><th style={{ ...TH, ...R }}>Returned</th><th style={{ ...TH, ...R }}>Capital</th><th style={{ ...TH, ...R }}>Share</th><th style={TH} /></tr></thead>
              <tbody>
                {active.map((p) => (
                  <tr key={p.id}>
                    <td style={TD}><b>{p.name}</b></td><td style={TDR}>{rs(p.capital.brought_in)}</td><td style={TDR}>{rs(p.capital.returned)}</td>
                    <td style={{ ...TDR, fontWeight: 700 }}>{rs(p.capital.balance)}</td><td style={TDR}>{t.capital > 0 ? `${num((p.capital.balance / t.capital) * 100, 1)}%` : "—"}</td>
                    <td style={TD}><button type="button" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? "Hide" : "Details"}</button></td>
                  </tr>
                ))}
                <tr><td style={{ ...TD, fontWeight: 700 }}>Total</td><td style={TDR}>{rs(t.capital_in)}</td><td style={TDR}>{rs(t.capital_out)}</td><td style={{ ...TDR, fontWeight: 700 }}>{rs(t.capital)}</td><td style={TD} /><td style={TD} /></tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {open && (() => {
        const p = d.partners.find((x) => x.id === open);
        return p ? <PartnerDetail p={p} canEdit={canEdit} onEdit={(e) => setEntry(e)} onDelete={async (e) => {
          if (!window.confirm(`Remove this entry — ${KIND_LABEL[e.kind]} ${rs(e.amount)} on ${fmtDay(e.date)}?`)) return;
          try { await apiRequest(`/cost/partners/txns/${e.id}`, { method: "DELETE" }); done("Entry removed."); } catch (err) { setMsg(err.message); }
        }} /> : null;
      })()}

      {d.uploads.length > 0 && (
        <section style={panel("1 1 100%")}>
          <h2 style={H2}>Uploads</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
            <thead><tr><th style={TH}>When</th><th style={TH}>For</th><th style={TH}>File</th><th style={{ ...TH, ...R }}>Lines kept</th><th style={TH}>By</th><th style={TH} /></tr></thead>
            <tbody>{d.uploads.map((u) => (
              <tr key={u.id}>
                <td style={TD}>{new Date(u.uploaded_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                <td style={TD}>{u.book === "capital" ? "Capital" : u.book === "sheet" ? "Investment & Loan sheet" : "Unsecured loans"}</td><td style={TD}>{u.file_name || "—"}</td><td style={TDR}>{u.kept}</td><td style={TD}>{u.uploaded_by || "—"}</td>
                <td style={TD}>{canEdit && <button type="button" style={{ padding: "4px 10px", fontSize: 12 }} onClick={async () => {
                  if (!window.confirm(`Take back this upload? Its ${u.kept} line(s) are removed.`)) return;
                  try { const r = await apiRequest(`/cost/partners/uploads/${u.id}`, { method: "DELETE" }); done(`${r.removed} line(s) taken back.`); } catch (err) { setMsg(err.message); }
                }}>Take back</button>}</td>
              </tr>))}
            </tbody>
          </table>
        </section>
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

function PartnerDetail({ p, canEdit, onEdit, onDelete }) {
  const rows = [...p.loan.ledger.map((x) => ({ ...x, book: "loan" })), ...p.capital.ledger.map((x) => ({ ...x, book: "capital" }))]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  return (
    <section style={panel("1 1 100%")}>
      <h2 style={H2}>{p.name} — every entry</h2>
      <div style={SUB}>Loan balance and interest after each entry (interest worked to the day of the entry).</div>
      {p.fy.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ width: "100%", minWidth: 720, borderCollapse: "collapse" }}>
            <thead><tr><th style={TH}>Financial year</th><th style={{ ...TH, ...R }}>Interest</th><th style={{ ...TH, ...R }}>Paid to partner</th><th style={{ ...TH, ...R }}>TDS deducted</th><th style={{ ...TH, ...R }}>Borrowed</th><th style={{ ...TH, ...R }}>Repaid</th><th style={{ ...TH, ...R }}>Capital in</th><th style={{ ...TH, ...R }}>Capital out</th></tr></thead>
            <tbody>{p.fy.map((f) => (
              <tr key={f.fy}><td style={TD}>FY {f.fy}<div style={MUTED}>{fmtDay(f.from)} – {fmtDay(f.to)}</div></td><td style={TDR}>{rs(f.interest)}</td><td style={TDR}>{rs(f.paid_net)}</td><td style={TDR}>{rs(f.tds)}</td><td style={TDR}>{rs(f.borrowed)}</td><td style={TDR}>{rs(f.repaid)}</td><td style={TDR}>{rs(f.capital_in)}</td><td style={TDR}>{rs(f.capital_out)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div style={{ overflowX: "auto", marginTop: 12 }}>
        <table style={{ width: "100%", minWidth: 860, borderCollapse: "collapse" }}>
          <thead><tr><th style={TH}>Date</th><th style={TH}>Entry</th><th style={{ ...TH, ...R }}>Amount</th><th style={{ ...TH, ...R }}>TDS</th><th style={{ ...TH, ...R }}>Loan after</th><th style={{ ...TH, ...R }}>Interest due after</th><th style={{ ...TH, ...R }}>Capital after</th><th style={TH}>Narration / note</th><th style={TH} /></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={`${x.book}-${x.id}`}>
                <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmtDay(x.date)}</td><td style={TD}>{x.kind === "interest_paid" && x.amount < 0 ? "Interest reversed" : KIND_LABEL[x.kind]}{x.interest_from && x.interest_from !== x.date ? <div style={MUTED}>interest from {fmtDay(x.interest_from)}</div> : null}</td>
                <td style={TDR}>{rs(x.amount)}</td><td style={TDR}>{x.tds ? rs(x.tds) : ""}</td>
                <td style={TDR}>{x.book === "loan" ? rs(x.balance) : ""}</td><td style={TDR}>{x.book === "loan" ? rs(x.interest_due) : ""}</td>
                <td style={TDR}>{x.book === "capital" ? rs(x.balance) : ""}</td>
                <td style={{ ...TD, ...MUTED, maxWidth: 280 }}>{[x.narration, x.note].filter(Boolean).join(" · ")}</td>
                <td style={{ ...TD, whiteSpace: "nowrap" }}>{canEdit && <>
                  <button type="button" style={{ padding: "3px 8px", fontSize: 11.5 }} onClick={() => onEdit({ id: x.id, partner_id: p.id, kind: x.kind, txn_date: x.date, amount: x.amount, tds: x.tds || "", note: x.note || "", interest_from: x.interest_from || "" })}>Edit</button>{" "}
                  <button type="button" style={{ padding: "3px 8px", fontSize: 11.5 }} onClick={() => onDelete(x)}>Remove</button></>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9} style={{ ...TD, ...MUTED }}>No entries yet.</td></tr>}
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
              <thead><tr><th style={TH}>Keep</th><th style={TH}>Date</th><th style={TH}>Narration</th><th style={{ ...TH, ...R }}>Amount</th><th style={TH}>Partner</th><th style={TH}>Entry</th><th style={TH}>TDS</th></tr></thead>
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

function EntryModal({ entry, d, onClose, onDone }) {
  const [f, setF] = useState({ partner_id: String(entry.partner_id || d.partners.find((p) => p.is_active)?.id || ""), kind: entry.kind, txn_date: entry.txn_date, amount: entry.amount ?? "", tds: entry.tds ?? "", note: entry.note || "", interest_from: entry.interest_from || "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const body = { ...f, partner_id: Number(f.partner_id) };
      if (entry.id) await apiRequest(`/cost/partners/txns/${entry.id}`, { method: "PUT", body });
      else await apiRequest("/cost/partners/txns", { method: "POST", body });
      onDone(entry.id ? "Entry changed." : "Entry added.");
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }
  const lab = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 };
  return (
    <Modal title={entry.id ? "Change an entry" : "Add an entry"} onClose={onClose} width={560}>
      <form onSubmit={save} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <label style={lab}>Partner<select value={f.partner_id} onChange={set("partner_id")} required>
          {d.partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label style={lab}>Entry<select value={f.kind} onChange={set("kind")}>
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label style={lab}>Date<input type="date" value={f.txn_date} onChange={set("txn_date")} required /></label>
        <label style={lab}>{f.kind === "interest_paid" ? "Paid to the partner (net; − = reversed)" : "Amount"}<input inputMode="decimal" value={f.amount} onChange={set("amount")} required /></label>
        {f.kind === "loan_in" && <label style={lab}>Interest from (blank = the date above)<input type="date" value={f.interest_from} onChange={set("interest_from")} /></label>}
        {f.kind === "interest_paid" && <label style={lab}>TDS deducted<input inputMode="decimal" value={f.tds} onChange={set("tds")} placeholder={f.amount ? String(Math.round(Number(f.amount) * d.settings.tds_rate / (100 - d.settings.tds_rate))) : ""} /></label>}
        <label style={{ ...lab, gridColumn: "1 / -1" }}>Note<input value={f.note} onChange={set("note")} maxLength={200} /></label>
        {f.kind === "interest_due" && <div style={{ ...MUTED, gridColumn: "1 / -1" }}>Interest owed to the partner on that date for the time before the entries here (e.g. from the books at the start). It is added to the interest due.</div>}
        {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, gridColumn: "1 / -1" }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, gridColumn: "1 / -1" }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
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
  const lab = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 };
  return (
    <Modal title="Partners & interest rates" onClose={onClose} width={720}>
      <h3 style={{ ...H2, fontSize: 14 }}>Partners</h3>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
        <thead><tr><th style={TH}>Name</th><th style={TH}>Words on their bank lines</th><th style={TH}>PAN</th><th style={TH} /></tr></thead>
        <tbody>{d.partners.map((x) => (
          <tr key={x.id} style={{ opacity: x.is_active ? 1 : 0.55 }}><td style={TD}>{x.name}</td><td style={{ ...TD, ...MUTED }}>{x.match_words || "—"}</td><td style={TD}>{x.pan || "—"}</td>
            <td style={TD}><button type="button" style={{ padding: "3px 8px", fontSize: 11.5 }} onClick={() => { setEditId(x.id); setP({ name: x.name, match_words: x.match_words || "", pan: x.pan || "", is_active: x.is_active }); }}>Edit</button></td></tr>))}
          {!d.partners.length && <tr><td colSpan={4} style={{ ...TD, ...MUTED }}>None yet.</td></tr>}
        </tbody>
      </table>
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
    ...d.partners.flatMap((p) => [...p.loan.ledger.map((x) => [p.name, x.date, KIND_LABEL[x.kind], x.amount, x.tds, x.balance, x.interest_due, "", x.narration || "", x.note || ""]),
      ...p.capital.ledger.map((x) => [p.name, x.date, KIND_LABEL[x.kind], x.amount, "", "", "", x.balance, x.narration || "", x.note || ""])])];
  downloadExcel(`Partners_${d.as_of}.xlsx`, [{ name: "Loans", rows: loans }, { name: "Capital", rows: capital }, { name: "By year", rows: fy }, { name: "Entries", rows: entries }]);
}

// Round 244 — the latest imported sheet's own totals beside the app's, on the
// sheet's date (its "Today").
function SheetCheck({ c }) {
  const rows = c.rows.filter((x) => x.sheet.loan || x.sheet.capital);
  const diff = (a, b) => Math.abs((a || 0) - (b || 0));
  const worst = Math.max(0, ...rows.flatMap((x) => ["capital", "loan", "interest", "paid", "balance"].map((k) => diff(x.app[k], x.sheet[k]))));
  const ok = worst < 1;
  const cell = (a, b) => (
    <td style={{ ...TDR, color: diff(a, b) >= 1 ? "var(--alert-red)" : undefined }}>{rs(a)}{diff(a, b) >= 1 ? <div style={MUTED}>sheet {rs(b)}</div> : null}</td>
  );
  return (
    <section style={panel("1 1 100%")}>
      <h2 style={H2}>Checked against your sheet {ok ? "— the app agrees" : "— differences"}</h2>
      <div style={SUB}>{c.file_name || "Sheet"} · on the sheet’s date {fmtDay(c.as_on)} · {ok ? `every figure agrees to the rupee (largest difference ₹${num(worst, 2)}, rounding)` : `largest difference ₹${num(worst, 2)} — shown in red with the sheet’s figure`}</div>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ width: "100%", minWidth: 760, borderCollapse: "collapse" }}>
          <thead><tr><th style={TH}>Partner</th><th style={{ ...TH, ...R }}>Capital</th><th style={{ ...TH, ...R }}>Loan</th><th style={{ ...TH, ...R }}>Interest till then</th><th style={{ ...TH, ...R }}>Interest paid (before TDS)</th><th style={{ ...TH, ...R }}>Interest balance</th></tr></thead>
          <tbody>{rows.map((x) => (
            <tr key={x.name}><td style={TD}><b>{x.name}</b></td>{cell(x.app.capital, x.sheet.capital)}{cell(x.app.loan, x.sheet.loan)}{cell(x.app.interest, x.sheet.interest)}{cell(x.app.paid, x.sheet.paid)}{cell(x.app.balance, x.sheet.balance)}</tr>
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
  async function read(f) {
    setErr(""); setR(null); setBusy(true);
    try {
      const XLSX = await import("xlsx");
      const { readPartnerSheet } = await import("../../lib/partnerSheetImport.js");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      setR(readPartnerSheet(XLSX, wb));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setErr("");
    try {
      const x = await apiRequest("/cost/partners/import-sheet", { method: "POST", body: { file_name: file?.name, replace, entries: r.entries, check: r.check } });
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
              <thead><tr><th style={TH}>Partner</th><th style={{ ...TH, ...R }}>Capital in − out</th><th style={{ ...TH, ...R }}>Loans in</th><th style={{ ...TH, ...R }}>Paid back</th><th style={{ ...TH, ...R }}>Interest paid (before TDS)</th><th style={{ ...TH, ...R }}>TDS</th><th style={{ ...TH, ...R }}>Sheet: interest balance</th></tr></thead>
              <tbody>{per.map(({ n, c, k }) => (
                <tr key={n}><td style={TD}><b>{n}</b>{!d.partners.some((p) => p.name.toLowerCase() === n.toLowerCase()) && <span style={MUTED}> · new</span>}</td>
                  <td style={TDR}>{rs(sum(k, "capital_in") - sum(k, "capital_out"))}</td><td style={TDR}>{rs(sum(k, "loan_in"))}</td><td style={TDR}>{rs(sum(k, "loan_out"))}</td>
                  <td style={TDR}>{rs(sum(k, "interest_paid") + sum(k, "interest_paid", "tds"))}</td><td style={TDR}>{rs(sum(k, "interest_paid", "tds"))}</td><td style={TDR}>{rs(c.balance)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 10 }}>
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace the earlier import of this sheet (entries typed in or from bank statements are kept)
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? "Importing…" : `Import ${r.entries.length} entries`}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
