// Round 204 — receipts from bank statements. The Accountant uploads the bank's
// Excel / CSV statement; only credits come in. Each credit is matched to a
// customer where it can be (a payer name learned before, the customer's name
// in the narration, or an amount that equals what is due), and posting it
// makes a receipt that pays the customer's oldest dues first — anything left
// is an advance. Uploading the same statement twice adds nothing twice.
import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { todayStr } from "../../lib/istDate.js";
import { inr2, fmtDate } from "../../lib/quotationTerms.js";
import { TH, TD, NUM, row, money, Banner, Field, Modal, Empty, Table } from "./ui.jsx";

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

// Bank statements write dates every way there is. Indian banks put the day first.
export function parseBankDate(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") {                       // Excel serial day
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : null;
  }
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${pad(m[2])}-${pad(m[1])}`; }
  m = s.match(/^(\d{1,2})[/\-. ]([A-Za-z]{3})[A-Za-z]*[/\-. ,]+(\d{2,4})/);
  if (m && MON[m[2].toLowerCase()]) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${pad(MON[m[2].toLowerCase()])}-${pad(m[1])}`; }
  return null;
}
const num = (v) => {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[,₹\s]/g, "").replace(/(CR|Cr|cr)$/, "");
  return Number(s) || 0;
};

// Finds the header row and the columns we need.
export function readStatement(aoa) {
  const find = (cells, words) => cells.findIndex((c) => words.some((w) => String(c || "").toLowerCase().replace(/\s+/g, " ").includes(w)));
  for (let i = 0; i < Math.min(aoa.length, 40); i++) {
    const cells = aoa[i] || [];
    const date = find(cells, ["txn date", "transaction date", "value date", "date"]);
    const credit = find(cells, ["deposit", "credit", "cr amount", "amount (cr)"]);
    if (date < 0 || credit < 0) continue;
    const narration = find(cells, ["narration", "description", "particulars", "transaction remarks", "remarks", "details"]);
    const reference = find(cells, ["ref", "chq", "cheque", "utr"]);
    const balance = find(cells, ["balance"]);
    const rows = [];
    let skipped = 0;
    for (const r of aoa.slice(i + 1)) {
      const d = parseBankDate(r[date]);
      const amt = num(r[credit]);
      if (!d || !(amt > 0)) { skipped++; continue; }
      rows.push({ date: d, credit: amt, narration: narration >= 0 ? String(r[narration] ?? "").trim() : "", reference: reference >= 0 ? String(r[reference] ?? "").trim() : "", balance: balance >= 0 ? String(r[balance] ?? "") : "" });
    }
    return { rows, skipped };
  }
  return null;
}

// A suggested payer name to remember: the narration without numbers and the
// bank's transfer words.
function aliasFrom(narr) {
  const parts = String(narr || "").toUpperCase().split(/[/|\\-]+/).map((p) => p.replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 4 && !/^(NEFT|RTGS|IMPS|UPI|INF|INFT|MOB|TRANSFER|CLG|BY|TO|CR|DR|FROM|PAYMENT|ICIC|HDFC|SBIN|FDRL|UTIB|KKBK|BARB|CNRB)\b/.test(p));
  return parts[0] || "";
}

export default function BankReceipts({ params, go }) {
  const { can } = usePermissions();
  const canCreate = can("accounts.bank-receipts", "create");
  const view = params.get("view") || "open";
  const [manual, setManual] = useState(false);
  const [importing, setImporting] = useState(false);
  const [tick, setTick] = useState(0);
  const [msg, setMsg] = useState("");
  const V = [["open", "To post"], ["posted", "Posted"], ["ignored", "Ignored"], ["receipts", "All receipts"], ["aliases", "Payer names"]];
  return (
    <>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {V.map(([k, l]) => <button key={k} type="button" className={`btn-tab ${view === k ? "active" : ""}`} onClick={() => go("receipts", { view: k })}>{l}</button>)}
        {canCreate && <>
          <button type="button" style={{ marginLeft: "auto" }} onClick={() => setManual(true)}>Record a receipt</button>
          <button type="button" className="btn-primary" onClick={() => setImporting(true)}>Upload bank statement</button>
        </>}
      </div>
      <Banner kind="ok">{msg}</Banner>
      {view === "receipts" ? <ReceiptList key={tick} canCancel={can("accounts.receipt-cancel", "edit")} />
        : view === "aliases" ? <Aliases canEdit={canCreate} />
        : <Lines key={`${view}-${tick}`} status={view} canPost={canCreate} />}
      {manual && <ReceiptModal onClose={() => setManual(false)} onDone={(r) => { setManual(false); setMsg(`Receipt saved${r.applied.length ? ` — set against ${r.applied.map((a) => a.label).join(", ")}` : ""}${r.advance ? `; ₹${inr2(r.advance)} kept as advance` : ""}.`); setTick((t) => t + 1); }} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={(r) => { setImporting(false); setMsg(`${r.added} credit(s) added${r.duplicates ? `, ${r.duplicates} already imported earlier` : ""}${r.skipped ? `, ${r.skipped} line(s) not credits` : ""}.`); go("receipts", { view: "open" }); setTick((t) => t + 1); }} />}
    </>
  );
}

function ImportModal({ onClose, onDone }) {
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState("");
  const [parsed, setParsed] = useState(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiRequest("/quotations/meta").then((m) => {
      const a = (m.bank_accounts || []).filter((x) => x.number).map((x) => `${x.bank || x.label} · ${String(x.number).slice(-4)}`);
      setAccounts(a); if (a[0]) setAccount(a[0]);
    }).catch(() => {});
  }, []);
  async function pick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(""); setParsed(null); setFileName(file.name);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
      let got = null;
      for (const name of wb.SheetNames) {
        got = readStatement(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" }));
        if (got) break;
      }
      if (!got) setError("Could not find the Date and Credit / Deposit columns in this file. Download the statement from the bank as Excel or CSV.");
      else if (!got.rows.length) setError("No credits found in this statement.");
      else setParsed(got);
    } catch (err) { setError(`Could not read the file: ${err.message}`); }
  }
  async function upload() {
    setBusy(true); setError("");
    try { onDone(await apiRequest("/accounts/bank/import", { method: "POST", body: { bank_account: account, file_name: fileName, rows: parsed.rows } })); }
    catch (e) { setError(e.message); setBusy(false); }
  }
  const total = (parsed?.rows || []).reduce((t, r) => t + r.credit, 0);
  return (
    <Modal title="Upload bank statement" onClose={onClose} width={640}>
      <Banner>{error}</Banner>
      <Field label="Bank account">
        {accounts.length ? (
          <select value={account} onChange={(e) => setAccount(e.target.value)}>{accounts.map((a) => <option key={a}>{a}</option>)}</select>
        ) : <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="e.g. ICICI · 3275" />}
      </Field>
      <Field label="Statement file (Excel or CSV, as downloaded from the bank)"><input type="file" accept=".xls,.xlsx,.csv" onChange={pick} /></Field>
      {parsed && (
        <>
          <div style={{ fontSize: 13, marginBottom: 6 }}><b>{parsed.rows.length}</b> credits · {money(total, 2)} · {fmtDate(parsed.rows.map((r) => r.date).sort()[0])} to {fmtDate(parsed.rows.map((r) => r.date).sort().slice(-1)[0])}</div>
          <div style={{ maxHeight: 220, overflowY: "auto", fontSize: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
            {parsed.rows.slice(0, 50).map((r, i) => <div key={i} style={{ padding: "3px 8px", borderTop: i ? "1px solid var(--border)" : 0 }}>{fmtDate(r.date)} · <b>₹{inr2(r.credit)}</b> · {r.narration}</div>)}
            {parsed.rows.length > 50 && <div style={{ padding: "3px 8px", color: "var(--slate)" }}>… and {parsed.rows.length - 50} more</div>}
          </div>
        </>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!parsed || !account || busy} onClick={upload}>{busy ? "Uploading…" : "Add these credits"}</button>
      </div>
    </Modal>
  );
}

function Lines({ status, canPost }) {
  const [d, setD] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [choice, setChoice] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);
  const [tick, setTick] = useState(0);
  const [onlyMatched, setOnlyMatched] = useState(false);
  useEffect(() => { apiRequest("/master/customers").then(setCustomers).catch(() => {}); }, []);
  useEffect(() => { apiRequest(`/accounts/bank/lines?status=${status}`).then(setD).catch((e) => setError(e.message)); }, [status, tick]);
  const lines = useMemo(() => (d?.lines || []).filter((l) => !onlyMatched || l.suggested_customer_id), [d, onlyMatched]);
  const pick = (l) => choice[l.id] || { customer_id: l.suggested_customer_id ? String(l.suggested_customer_id) : "", alias: l.match_level === "sure" ? "" : aliasFrom(l.narration), learn: l.match_level !== "sure" };

  async function post(l) {
    const c = pick(l);
    if (!c.customer_id) { setError("Choose the customer first."); return; }
    setBusy(l.id); setError("");
    try {
      await apiRequest(`/accounts/bank/lines/${l.id}/post`, { method: "POST", body: { customer_id: Number(c.customer_id), learn_alias: c.learn ? c.alias : "" } });
      setTick((t) => t + 1);
    } catch (e) { setError(e.message); }
    setBusy(null);
  }
  async function ignore(l) {
    const reason = window.prompt("Why is this not a customer payment? (e.g. interest, own transfer, refund)");
    if (!reason) return;
    setBusy(l.id);
    try { await apiRequest(`/accounts/bank/lines/${l.id}/ignore`, { method: "POST", body: { reason } }); setTick((t) => t + 1); }
    catch (e) { setError(e.message); }
    setBusy(null);
  }
  async function reopen(l) {
    try { await apiRequest(`/accounts/bank/lines/${l.id}/reopen`, { method: "POST" }); setTick((t) => t + 1); } catch (e) { setError(e.message); }
  }
  async function rematch() {
    try { await apiRequest("/accounts/bank/rematch", { method: "POST" }); setTick((t) => t + 1); } catch (e) { setError(e.message); }
  }

  if (!d) return <><Banner>{error}</Banner><Empty>Loading…</Empty></>;
  const sum = lines.reduce((t, l) => t + Number(l.amount), 0);
  return (
    <>
      <Banner>{error}</Banner>
      {status === "open" && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, fontSize: 12.5, flexWrap: "wrap" }}>
          <span>{lines.length} credit(s) · {money(sum, 2)}</span>
          <label style={{ display: "flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={onlyMatched} onChange={(e) => setOnlyMatched(e.target.checked)} style={{ width: "auto" }} /> Only matched</label>
          {canPost && <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={rematch}>Match again</button>}
          {d.imports[0] && <span style={{ marginLeft: "auto", color: "var(--slate)" }}>Last upload: {d.imports[0].bank_account} · {fmtDate(d.imports[0].period_from)}–{fmtDate(d.imports[0].period_to)} by {d.imports[0].imported_by_name}</span>}
        </div>
      )}
      {!lines.length ? <Empty>{status === "open" ? "Nothing to post. Upload a bank statement to bring in new credits." : "None."}</Empty> : (
        <Table minWidth={980} head={<>
          <th style={TH}>Date</th><th style={TH}>Narration</th><th style={{ ...TH, textAlign: "right" }}>Amount</th>
          <th style={TH}>{status === "open" ? "Customer" : status === "posted" ? "Posted to" : "Reason"}</th>{status === "open" && <th style={TH}>Remember payer as</th>}<th style={TH} />
        </>}>
          {lines.map((l) => {
            const c = pick(l);
            const set = (k, v) => setChoice({ ...choice, [l.id]: { ...c, [k]: v } });
            return (
              <tr key={l.id} style={row}>
                <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmtDate(l.txn_date)}<div style={{ fontSize: 11, color: "var(--slate)" }}>{l.bank_account}</div></td>
                <td style={{ ...TD, fontSize: 12, maxWidth: 320, wordBreak: "break-word" }}>{l.narration}{l.reference && <div style={{ color: "var(--slate)" }}>Ref {l.reference}</div>}</td>
                <td style={{ ...NUM, fontWeight: 700 }}>{inr2(l.amount)}</td>
                {status === "open" ? (
                  <td style={TD}>
                    <select value={c.customer_id} onChange={(e) => set("customer_id", e.target.value)} disabled={!canPost} style={{ maxWidth: 220 }}>
                      <option value="">Choose…</option>
                      {customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                    {l.match_level && l.match_level !== "none" && String(c.customer_id) === String(l.suggested_customer_id) && (
                      <div style={{ fontSize: 11, color: l.match_level === "sure" ? "var(--signal-green)" : "var(--amber)" }}>{l.match_level === "sure" ? "✓ " : "? "}{l.match_reason}</div>
                    )}
                  </td>
                ) : (
                  <td style={{ ...TD, fontSize: 12.5 }}>{status === "posted" ? l.posted_customer_name : l.ignored_reason}<div style={{ fontSize: 11, color: "var(--slate)" }}>{l.settled_by_name}</div></td>
                )}
                {status === "open" && (
                  <td style={TD}>
                    <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                      <input type="checkbox" checked={c.learn} onChange={(e) => set("learn", e.target.checked)} style={{ width: "auto" }} disabled={!canPost} />
                      <input value={c.alias} onChange={(e) => set("alias", e.target.value.toUpperCase())} disabled={!c.learn || !canPost} style={{ width: 150, fontSize: 12 }} />
                    </label>
                  </td>
                )}
                <td style={{ ...TD, whiteSpace: "nowrap" }}>
                  {status === "open" && canPost && <>
                    <button type="button" className="btn-primary" style={{ fontSize: 12, padding: "5px 10px", marginRight: 4 }} disabled={busy === l.id} onClick={() => post(l)}>Post</button>
                    <button type="button" style={{ fontSize: 12, padding: "5px 10px" }} disabled={busy === l.id} onClick={() => ignore(l)}>Not a customer</button>
                  </>}
                  {status === "ignored" && canPost && <button type="button" style={{ fontSize: 12, padding: "5px 10px" }} onClick={() => reopen(l)}>Reopen</button>}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}

function ReceiptList({ canCancel }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => { apiRequest("/accounts/receipts").then(setRows).catch((e) => setError(e.message)); }, [tick]);
  async function cancel(r) {
    const reason = window.prompt(`Cancel receipt #${r.id} (₹${inr2(r.amount)} from ${r.customer_name})? Its allocations are removed and a bank line goes back to "To post". Reason:`);
    if (!reason) return;
    try { await apiRequest(`/accounts/receipts/${r.id}/cancel`, { method: "POST", body: { reason } }); setTick((t) => t + 1); }
    catch (e) { setError(e.message); }
  }
  return (
    <>
      <Banner>{error}</Banner>
      {!rows ? <Empty>Loading…</Empty> : !rows.length ? <Empty>No receipts yet.</Empty> : (
        <Table minWidth={860} head={<>
          <th style={TH}>#</th><th style={TH}>Date</th><th style={TH}>Customer</th><th style={TH}>Mode · ref</th>
          <th style={{ ...TH, textAlign: "right" }}>Amount</th><th style={{ ...TH, textAlign: "right" }}>Set against dues</th><th style={TH}>By</th><th style={TH} />
        </>}>
          {rows.map((r) => (
            <tr key={r.id} style={{ ...row, opacity: r.cancelled_at ? 0.5 : 1 }}>
              <td style={TD}>{r.id}</td>
              <td style={TD}>{fmtDate(r.receipt_date)}</td>
              <td style={TD}>{r.customer_name}</td>
              <td style={{ ...TD, fontSize: 12 }}>{r.mode.replace("_", " ")}{r.reference_number ? ` · ${r.reference_number}` : ""}{r.bank_account ? <div style={{ color: "var(--slate)" }}>{r.bank_account}</div> : null}</td>
              <td style={{ ...NUM, fontWeight: 700 }}>{inr2(r.amount)}</td>
              <td style={NUM}>{inr2(r.allocated)}{Number(r.amount) - Number(r.allocated) > 0.5 && !r.cancelled_at && <div style={{ fontSize: 11, color: "var(--info)" }}>advance {inr2(r.amount - r.allocated)}</div>}</td>
              <td style={{ ...TD, fontSize: 12 }}>{r.entered_by_name}</td>
              <td style={TD}>{r.cancelled_at ? <span style={{ fontSize: 12 }}>Cancelled — {r.cancel_reason}</span> : canCancel && <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => cancel(r)}>Cancel</button>}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

function Aliases({ canEdit }) {
  const [rows, setRows] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { apiRequest("/accounts/aliases").then(setRows).catch(() => setRows([])); }, [tick]);
  return !rows ? <Empty>Loading…</Empty> : !rows.length ? <Empty>No payer names learned yet — they are remembered as you post bank credits.</Empty> : (
    <Table minWidth={500} head={<><th style={TH}>Customer</th><th style={TH}>Bank shows</th><th style={TH} /></>}>
      {rows.map((a) => (
        <tr key={a.id} style={row}>
          <td style={TD}>{a.customer_name}</td><td style={{ ...TD, fontFamily: "monospace" }}>{a.alias}</td>
          <td style={TD}>{canEdit && <button type="button" style={{ fontSize: 12, padding: "3px 8px" }} onClick={async () => { await apiRequest(`/accounts/aliases/${a.id}`, { method: "DELETE" }); setTick((t) => t + 1); }}>Forget</button>}</td>
        </tr>
      ))}
    </Table>
  );
}

export function ReceiptModal({ customerId, onClose, onDone }) {
  const [customers, setCustomers] = useState([]);
  const [f, setF] = useState({ customer_id: customerId || "", receipt_date: todayStr(), amount: "", mode: "bank_transfer", reference_number: "", remarks: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!customerId) apiRequest("/master/customers").then(setCustomers).catch(() => {}); }, [customerId]);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try { onDone(await apiRequest("/accounts/receipts", { method: "POST", body: { ...f, customer_id: Number(f.customer_id), amount: Number(f.amount) } })); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title="Record a receipt" onClose={onClose} width={480}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        {!customerId && (
          <Field label="Customer">
            <select required value={f.customer_id} onChange={(e) => setF({ ...f, customer_id: e.target.value })}>
              <option value="">Choose…</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Date received"><input type="date" required value={f.receipt_date} max={todayStr()} onChange={(e) => setF({ ...f, receipt_date: e.target.value })} /></Field>
          <Field label="Amount ₹"><input type="number" min="1" step="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Mode">
            <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
              <option value="bank_transfer">Bank transfer</option><option value="upi">UPI</option><option value="cheque">Cheque</option><option value="cash">Cash</option>
            </select>
          </Field>
          <Field label="Reference / cheque no."><input value={f.reference_number} onChange={(e) => setF({ ...f, reference_number: e.target.value })} /></Field>
        </div>
        <Field label="Remarks"><input value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field>
        <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>Paid against the oldest dues first; anything over is kept as an advance.</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save receipt"}</button>
        </div>
      </form>
    </Modal>
  );
}
