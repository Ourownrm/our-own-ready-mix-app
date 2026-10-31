// Round 255 — Accounts → Send to CA (owner, 31 Oct 2026; mock-up "CA Tax
// Desk Mockup", agreed in its third version). The CA keeps the books and
// files the returns; the app hands over the month's transactions with their
// heads — in Excel, by the 5th for the month before. Every invoice and every
// C Ledger entry is in it.
import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { fmtDate } from "../../lib/quotationTerms.js";
import { TH, TD, NUM, row, Banner, Empty, Table, Modal, Field } from "./ui.jsx";

const sub = { fontSize: 12, color: "var(--slate)" };
const pad = (n) => String(n).padStart(2, "0");
function lastMonths(n) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const out = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  }
  return out;
}
const monthName = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
const STATUS = {
  not_sent: ["Not sent yet", "badge-warning"], overdue: ["Overdue", "badge-danger"], sent: ["Sent", "badge-success"], changed: ["Changed after sending", "badge-danger"],
};

function workbook(pack, { changesOnly = false } = {}) {
  const wb = XLSX.utils.book_new();
  const about = [
    [`Our Own Ready Mix — data for the CA — ${pack.label}`],
    [changesOnly ? `Only what changed after it was sent on ${new Date(pack.sent.at).toLocaleDateString("en-IN")}` : `Prepared ${new Date().toLocaleDateString("en-IN")} · due ${fmtDate(pack.due_on)}`],
    [],
    ["Sheet", "What is in it", "Rows"],
  ];
  for (const s of pack.sheets) {
    const rows = changesOnly ? s.rows.filter((r) => r.change) : s.rows;
    about.push([s.name, s.note, rows.length]);
  }
  about.push([], ["Before sending"], ...pack.checklist.map((c) => [c.ok ? "OK" : "To look at", c.label]));
  const aw = XLSX.utils.aoa_to_sheet(about);
  aw["!cols"] = [{ wch: 26 }, { wch: 110 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, aw, "About");
  for (const s of pack.sheets) {
    const rows = changesOnly ? s.rows.filter((r) => r.change) : s.rows;
    if (changesOnly && !rows.length) continue;
    const head = changesOnly ? ["Change", ...s.columns] : s.columns;
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows.map((r) => (changesOnly ? [r.change === "new" ? "New" : "Changed", ...r.c] : r.c))]);
    ws["!cols"] = head.map((h) => ({ wch: Math.min(48, Math.max(10, String(h).length + 2)) }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  if (changesOnly && pack.diff?.removed?.length) {
    const names = Object.fromEntries(pack.sheets.map((s) => [s.key, s.name]));
    const ws = XLSX.utils.aoa_to_sheet([["Sheet", "Row no longer there (taken out or cancelled since)"], ...pack.diff.removed.map((r) => [names[r.sheet] || r.sheet, r.key])]);
    XLSX.utils.book_append_sheet(wb, ws, "Removed since sent");
  }
  return wb;
}

export default function SendToCa() {
  const { can } = usePermissions();
  const canEdit = can("accounts.send-to-ca", "edit");
  const months = useMemo(() => lastMonths(12), []);
  const [month, setMonth] = useState(months[1] || months[0]);
  const [pack, setPack] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  const [history, setHistory] = useState([]);
  const [heads, setHeads] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPack(null); setError("");
    apiRequest(`/accounts/ca/pack?month=${month}`).then(setPack).catch((e) => setError(e.message));
    apiRequest("/accounts/ca/history").then(setHistory).catch(() => {});
  }, [month, tick]);

  function download(one = null, changesOnly = false) {
    const p = one ? { ...pack, sheets: pack.sheets.filter((s) => s.key === one) } : pack;
    XLSX.writeFile(workbook(p, { changesOnly }), `OORM ${pack.label} — ${one ? pack.sheets.find((s) => s.key === one).name : changesOnly ? "changes for the CA" : "data for the CA"}.xlsx`);
  }
  async function markSent() {
    const note = window.prompt(`Mark ${pack.label} as sent to the CA? (a note, optional)`, "");
    if (note === null) return;
    setBusy(true); setError("");
    try { await apiRequest("/accounts/ca/sent", { method: "POST", body: { month, note } }); setMsg(`${pack.label} marked as sent.`); setTick((t) => t + 1); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const st = pack ? STATUS[pack.status] : null;
  return (
    <>
      <Banner>{error}</Banner><Banner kind="ok">{msg}</Banner>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>Data for the CA</h2>
          <select aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ padding: "8px 10px", border: "1px solid var(--border-strong)", borderRadius: 7, fontSize: 14 }}>
            {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
          </select>
          {st && <span className={`badge ${st[1]}`}>{st[0]}{pack.status === "not_sent" || pack.status === "overdue" ? ` · due by ${fmtDate(pack.due_on)}` : ""}</span>}
        </div>
        {pack && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {canEdit && <button type="button" onClick={() => setHeads(true)}>Head names for the CA</button>}
            {pack.status === "changed" && <button type="button" onClick={() => download(null, true)}>Download changes only</button>}
            {canEdit && <button type="button" disabled={busy} onClick={markSent}>{pack.sent ? "Mark as sent again" : "Mark as sent"}</button>}
            <button type="button" className="btn-primary" onClick={() => download()}>Download all (one Excel file)</button>
          </div>
        )}
      </div>
      {!pack ? (!error && <Empty>Putting the month together…</Empty>) : (
        <>
          {pack.sent && (
            <div style={{ ...sub, marginBottom: 10 }}>
              Sent {new Date(pack.sent.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} by {pack.sent.by || "—"}{pack.sent.note ? ` · ${pack.sent.note}` : ""}
              {pack.status === "changed" && <> · <b style={{ color: "var(--alert-red)" }}>since then: {pack.diff.changed} changed, {pack.diff.added} new, {pack.diff.removed.length} taken out</b></>}
            </div>
          )}
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>Before sending</div>
            <div style={{ ...sub, marginBottom: 8 }}>The CA gets the month only as complete as these are.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13.5 }}>
              {pack.checklist.map((c) => (
                <div key={c.key} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span className={`badge ${c.ok ? "badge-success" : "badge-warning"}`} style={{ minWidth: 64, textAlign: "center" }}>{c.ok ? "Done" : "Look"}</span>
                  <span>{c.label}{!c.ok && c.go && <> — <a href={c.go}>open</a></>}</span>
                </div>
              ))}
            </div>
          </div>
          <Table minWidth={760} head={<><th style={TH}>Sheet</th><th style={TH}>What&rsquo;s in it</th><th style={{ ...TH, textAlign: "right" }}>Rows</th><th style={TH} /></>}>
            {pack.sheets.map((s) => {
              const changed = s.rows.filter((r) => r.change).length;
              return (
                <tr key={s.key} style={row}>
                  <td style={{ ...TD, fontWeight: 700, whiteSpace: "nowrap" }}>{s.name}</td>
                  <td style={{ ...TD, fontSize: 12.5 }}>{s.note}{changed > 0 && <div style={{ color: "var(--alert-red)", fontSize: 12 }}>{changed} row{changed > 1 ? "s" : ""} new or changed since sent</div>}</td>
                  <td style={NUM}>{s.rows.length}</td>
                  <td style={TD}><button type="button" style={{ fontSize: 12.5, padding: "5px 10px" }} onClick={() => download(s.key)}>Download</button></td>
                </tr>
              );
            })}
          </Table>
          <div style={{ ...sub, marginTop: 8 }}>Excel only. Every invoice and every C Ledger entry is included. Each row with a head also carries the CA&rsquo;s ledger name for it, once set.</div>

          {history.length > 0 && (
            <div className="card" style={{ marginTop: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>Sent to the CA</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.month} style={row}>
                      <td style={TD}><button type="button" className="btn-link" style={{ border: "none", padding: 0, color: "var(--rebar)", background: "none" }} onClick={() => setMonth(h.month.trim())}>{h.label}</button></td>
                      <td style={TD}>{new Date(h.sent_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · {h.sent_by || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ ...sub, marginTop: 6 }}>Open a month to see whether anything in it changed after it was sent.</div>
            </div>
          )}
        </>
      )}
      {heads && pack && <HeadNames heads={pack.heads} onClose={() => setHeads(false)} onSaved={() => { setHeads(false); setMsg("Ledger names saved."); setTick((t) => t + 1); }} />}
    </>
  );
}

function HeadNames({ heads, onClose, onSaved }) {
  const [names, setNames] = useState(() => Object.fromEntries(heads.map((h) => [h.key, h.ledger_name])));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await apiRequest("/accounts/ca/heads", { method: "PUT", body: { names } }); onSaved(); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title="Head names for the CA" onClose={onClose} width={640}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        <div style={{ ...sub, marginBottom: 10 }}>Set once: each head in the app with the CA&rsquo;s own ledger name, so they can post it straight in. Leave blank to send the app&rsquo;s name only.</div>
        <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
          {heads.map((h) => (
            <Field key={h.key} label={h.label}>
              <input value={names[h.key] || ""} onChange={(e) => setNames({ ...names, [h.key]: e.target.value })} placeholder="CA's ledger name" />
            </Field>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}
