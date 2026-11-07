// Round 271 — Accounts › B2C → Tally (mock-up "B2C Invoices to Tally Mockup",
// claude/b2c-tally-posting-mockup-v1.md; owner: "Code this", 7 Nov 2026).
//
// B2C invoices (no GSTIN) from the start date: verify and approve each one
// (it gets the next Tally voucher number), then tick the approved ones and
// "Post to Tally". Only that button sends anything; the Tally Bridge on the
// Tally computer carries it to Tally and brings back Posted / Failed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest, BASE_URL } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { fmtDate } from "../../lib/quotationTerms.js";
import { TH, TD, NUM, row, Banner, Empty, Table, Modal, Field, money } from "./ui.jsx";

const sub = { fontSize: 12, color: "var(--slate)" };
const pad = (n) => String(n).padStart(2, "0");
const thisMonth = () => {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
function months(n) {
  const d0 = new Date(`${thisMonth()}-01T00:00:00`);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(d0.getFullYear(), d0.getMonth() - i, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  });
}
const monthName = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
const rs2 = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (t) => (t ? new Date(t).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");

const STATE = {
  to_verify: ["To verify", "badge-warning"],
  back: ["Sent back", "badge-warning"],
  approved: ["Approved", "badge-info"],
  queued: ["Sending…", "badge-progress"],
  posting: ["Sending…", "badge-progress"],
  posted: ["Posted", "badge-success"],
  manual: ["In Tally (by hand)", "badge-success"],
  failed: ["Failed", "badge-danger"],
};
const FILTERS = [
  ["to_verify", "To verify"], ["approved", "Approved"], ["failed", "Failed"], ["queued", "Sending"], ["posted", "Posted"], ["changed", "Changed"], ["all", "All B2C"],
];
const postable = (r) => ["approved", "failed"].includes(r.state) && !r.changed && r.voucher_no;

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function BridgeStrip({ bridge, onSettings }) {
  if (!bridge) return null;
  const [dot, title, line] = !bridge.configured
    ? ["var(--slate)", "Tally Bridge not set up", "Tally settings › Download the bridge file, then run it on the Tally computer. Until then, use “Download Tally XML”."]
    : !bridge.online
      ? ["var(--alert-red)", "Tally Bridge not running", `Start OORM-Tally-Bridge on ${bridge.pc || "the Tally computer"}${bridge.seen_at ? ` (last seen ${when(bridge.seen_at)})` : ""}.`]
      : !bridge.tally_open
        ? ["var(--amber)", "Tally is not open", `The bridge is running on ${bridge.pc || "the Tally computer"}, but Tally isn't answering — open TallyPrime${bridge.company ? ` with ${bridge.company}` : ""}.`]
        : ["var(--signal-green)", "Tally connected", `Tally Bridge on ${bridge.pc || "the Tally computer"} · company ${bridge.company || "— not set"} · checked ${when(bridge.seen_at)}`];
  return (
    <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, flex: "1 1 420px", minWidth: 0 }}>
      <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: "50%", background: dot, flex: "none" }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{title}</div>
        <div style={sub}>{line}</div>
      </div>
      {onSettings && <button type="button" onClick={onSettings} style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>Tally settings</button>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verify & approve one invoice
// ---------------------------------------------------------------------------
function Verify({ id, onClose, onOpen, canEdit }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [no, setNo] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [backNote, setBackNote] = useState(null);

  const load = useCallback(() => {
    setErr("");
    apiRequest(`/accounts/tally/b2c/${id}`).then((r) => {
      setD(r);
      setNo(r.proposal?.voucher_no || "");
      setDate(r.invoice.voucher_date || r.invoice.date);
    }).catch((e) => setErr(e.message));
  }, [id]);
  useEffect(() => { setD(null); setBackNote(null); load(); }, [load]);

  if (!d) return <div>{err ? <Banner>{err}</Banner> : <Empty>Loading…</Empty>}<button type="button" onClick={onClose}>← Back to list</button></div>;
  const inv = d.invoice;
  const locked = ["queued", "posting", "posted", "manual"].includes(inv.state);
  const blocked = d.checks.some((c) => c.ok === false && !/Changed after it was approved/.test(c.text));

  async function approve(goNext) {
    setBusy(true); setErr("");
    try {
      await apiRequest(`/accounts/tally/b2c/${id}/approve`, { method: "POST", body: { voucher_no: no, date } });
      if (goNext && d.to_verify.next_id) onOpen(d.to_verify.next_id);
      else onClose(true);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function act(path, body) {
    setBusy(true); setErr("");
    try { await apiRequest(`/accounts/tally/b2c/${id}/${path}`, { method: "POST", body }); onClose(true); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const propNote = d.proposal?.why === "first" ? "Type the next Tally voucher number once — the app counts on from it."
    : d.proposal?.why === "new_fy" ? `New financial year (${d.proposal.fy}) — type the first Tally number of the year.`
      : d.proposal?.why === "own" ? "The number already on this invoice (typed at a Tally-format print, or approved before)."
        : d.proposal?.why === "next" ? "Next in your series. Change it if needed — a number used on another invoice is refused." : "";
  const st = inv.changed ? ["Changed", "badge-danger"] : STATE[inv.state] || [inv.state, "badge-neutral"];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <button type="button" onClick={() => onClose(false)}>← Back to list</button>
        <span style={{ fontSize: 13, color: "var(--slate)" }}>Delivery note <b style={{ color: "var(--charcoal)" }}>{inv.ticket_number}</b></span>
        <span className={`badge ${st[1]}`}>{st[0]}</span>
        {d.to_verify.count > 0 && <span style={{ ...sub, marginLeft: "auto" }}>{d.to_verify.position ? `${d.to_verify.position} of ${d.to_verify.count} to verify` : `${d.to_verify.count} to verify`}
          {d.to_verify.next_id && <button type="button" style={{ marginLeft: 8 }} onClick={() => onOpen(d.to_verify.next_id)}>Next ›</button>}</span>}
      </div>
      <Banner>{err}</Banner>
      {inv.note && <Banner kind={inv.state === "failed" ? "error" : "warn"}>{inv.state === "failed" ? "Tally: " : "Sent back: "}{inv.note}</Banner>}

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div className="card" style={{ flex: "999 1 520px", minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.5, color: "var(--slate)" }}>TAX INVOICE · B2C</div>
              <div style={{ fontSize: 19, fontWeight: 800 }}>{inv.customer}</div>
              {inv.billing_address && <div style={sub}>{inv.billing_address}</div>}
            </div>
            <div style={{ fontSize: 13, textAlign: "right" }}>
              <div>Date <b>{fmtDate(inv.date)}</b></div>
              <div>Delivery note <b>{inv.ticket_number}</b></div>
              {inv.truck && <div>Vehicle <b>{inv.truck}</b></div>}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, margin: "12px 0", fontSize: 13 }}>
            <div style={{ background: "var(--concrete)", borderRadius: 8, padding: "8px 10px" }}><div style={sub}>Site</div><b>{inv.site || "—"}</b></div>
            <div style={{ background: "var(--concrete)", borderRadius: 8, padding: "8px 10px" }}><div style={sub}>Grade</div><b>{inv.grade || "—"}</b></div>
            <div style={{ background: "var(--concrete)", borderRadius: 8, padding: "8px 10px" }}><div style={sub}>Quantity</div><b>{inv.returned ? `${inv.loaded} − ${inv.returned} = ` : ""}{inv.m3} m³</b></div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 420 }}>
              <thead><tr><th style={TH}>Item</th><th style={{ ...TH, textAlign: "right" }}>Qty</th><th style={{ ...TH, textAlign: "right" }}>Rate</th><th style={{ ...TH, textAlign: "right" }}>Amount</th></tr></thead>
              <tbody>
                {d.figures.lines.map((l) => (
                  <tr key={l.name} style={row}><td style={TD}>{l.name}</td><td style={NUM}>{l.qty != null ? `${l.qty} m³` : ""}</td><td style={NUM}>{l.rate != null ? rs2(l.rate) : ""}</td><td style={NUM}>{rs2(l.amount)}</td></tr>
                ))}
                <tr style={row}><td style={TD} colSpan={3}>Taxable value</td><td style={NUM}>{rs2(d.figures.taxable)}</td></tr>
                <tr><td style={TD} colSpan={3}>CGST 9%</td><td style={NUM}>{rs2(d.figures.cgst)}</td></tr>
                <tr><td style={TD} colSpan={3}>SGST 9%</td><td style={NUM}>{rs2(d.figures.sgst)}</td></tr>
                {!!d.figures.roundoff && <tr><td style={TD} colSpan={3}>Round off</td><td style={NUM}>{rs2(d.figures.roundoff)}</td></tr>}
                <tr style={{ borderTop: "2px solid var(--charcoal)" }}><td style={{ ...TD, fontWeight: 800, fontSize: 15 }} colSpan={3}>Total</td><td style={{ ...NUM, fontWeight: 800, fontSize: 15 }}>{rs2(d.figures.total)}</td></tr>
              </tbody>
            </table>
          </div>
          <div style={{ ...sub, marginTop: 8 }}>Figures as Tally works them out (rate ÷ 1.18, tax on the taxable total, rounded to the rupee) — the same as the Tally-format print.</div>
        </div>

        <div style={{ flex: "1 1 360px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card">
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5, color: "var(--slate)", marginBottom: 6 }}>CHECKS</div>
            {d.checks.map((c, i) => (
              <div key={i} style={{ display: "flex", gap: 8, fontSize: 13.5, padding: "3px 0" }}>
                <span aria-hidden="true" style={{ fontWeight: 800, width: 14, flex: "none", color: c.ok === true ? "var(--signal-green)" : c.ok === false ? "var(--alert-red)" : "var(--amber)" }}>{c.ok === true ? "✓" : c.ok === false ? "✕" : "!"}</span>
                <span>{c.text}</span>
              </div>
            ))}
          </div>

          <div className="card">
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5, color: "var(--slate)", marginBottom: 6 }}>TALLY VOUCHER · {d.voucher_type}</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Field label="Voucher no." style={{ flex: "1 1 140px" }}>
                <input value={no} onChange={(e) => setNo(e.target.value)} disabled={locked || !canEdit} maxLength={40}
                  style={{ fontSize: 17, fontWeight: 800, width: "100%" }} aria-label="Tally voucher number" />
              </Field>
              <Field label="Date" style={{ flex: "1 1 140px" }}>
                <input type="date" value={date || ""} onChange={(e) => setDate(e.target.value)} disabled={locked || !canEdit} style={{ width: "100%" }} />
              </Field>
            </div>
            {!locked && propNote && <div style={{ ...sub, marginTop: -4 }}>{propNote}</div>}
            {locked && <div style={sub}>{inv.state === "posted" ? `Posted ${when(inv.posted_at)}${inv.posted_by ? ` · ${inv.posted_by}` : ""}` : inv.state === "manual" ? "Entered in Tally by hand" : "Being sent to Tally"} — the number is fixed.</div>}
            {inv.approved_by && !["to_verify", "back"].includes(inv.state) && <div style={{ ...sub, marginTop: 4 }}>Approved {when(inv.approved_at)} · {inv.approved_by}</div>}
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--slate)", margin: "12px 0 4px" }}>GOES TO THESE TALLY LEDGERS</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <tbody>
                {d.entries.map((e) => (
                  <tr key={e.role}><td style={{ padding: "3px 0" }}>{e.ledger || <i style={{ color: "var(--alert-red)" }}>no name</i>}</td>
                    <td style={{ padding: "3px 0", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{e.amount < 0 ? "Dr" : "Cr"} {rs2(Math.abs(e.amount))}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          {canEdit && !locked && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn-primary" style={{ flex: 1, minHeight: 44 }} disabled={busy || !no.trim() || blocked} onClick={() => approve(false)}>
                  {inv.state === "approved" || inv.state === "failed" ? "Save number & date" : "Approve"}
                </button>
                {d.to_verify.next_id && !["approved", "failed"].includes(inv.state) && (
                  <button type="button" style={{ flex: 1, minHeight: 44 }} disabled={busy || !no.trim() || blocked} onClick={() => approve(true)}>Approve &amp; next</button>
                )}
              </div>
              {backNote == null
                ? <button type="button" disabled={busy} style={{ color: "var(--alert-red)" }} onClick={() => setBackNote("")}>Send back with a note</button>
                : (
                  <div className="card" style={{ padding: 10 }}>
                    <Field label="What needs correcting?"><textarea rows={2} value={backNote} onChange={(e) => setBackNote(e.target.value)} style={{ width: "100%" }} /></Field>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" className="btn-primary" disabled={busy || !backNote.trim()} onClick={() => act("send-back", { note: backNote })}>Send back</button>
                      <button type="button" onClick={() => setBackNote(null)}>Cancel</button>
                    </div>
                  </div>
                )}
              {["approved", "failed"].includes(inv.state) && (
                <button type="button" disabled={busy} onClick={() => act("reopen")}>Back to “To verify” (to correct the invoice)</button>
              )}
              <div style={sub}>Approving sends nothing to Tally. Approved invoices are posted from the list with “Post to Tally”.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tally settings
// ---------------------------------------------------------------------------
function Settings({ onClose, canEdit }) {
  const [s, setS] = useState(null);
  const [f, setF] = useState(null);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => apiRequest("/accounts/tally/settings").then((r) => {
    setS(r);
    setF((old) => old || { company: r.company, voucher_type: r.voucher_type, prefix: r.prefix, suffix: r.suffix, next_no: r.next_no ?? "", restart_april: r.restart_april, party_mode: r.party_mode, ledgers: { ...r.ledgers }, from_date: r.from_date || "" });
  }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const pending = s?.check?.pending;
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [pending, load]);

  if (!s || !f) return <Modal title="Tally settings" onClose={onClose} width={760}>{err ? <Banner>{err}</Banner> : "Loading…"}</Modal>;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const preview = f.next_no !== "" && f.next_no != null ? `${f.prefix}${f.next_no}${f.suffix}` : null;
  const missing = new Set((s.check?.missing || []).map((m) => m.key));
  const found = new Set(s.check?.found || []);

  async function save() {
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await apiRequest("/accounts/tally/settings", { method: "PUT", body: { ...f, next_no: f.next_no === "" ? null : Number(f.next_no) } });
      setS(r); setOk("Saved.");
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function bridgeFile() {
    if (s.bridge.configured && !window.confirm("Make a new bridge file? The one already on the Tally computer stops working — replace it with the new one.")) return;
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await apiRequest("/accounts/tally/bridge-file", { method: "POST", body: { api_base: BASE_URL } });
      download(r.filename, r.content, "application/octet-stream");
      setOk("Bridge file downloaded. Copy it to the Tally computer and double-click it (if Windows asks, More info › Run anyway). Keep its window open.");
      load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function check() {
    setBusy(true); setErr(""); setOk("");
    try { await save(); await apiRequest("/accounts/tally/check", { method: "POST" }); load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const b = s.bridge;
  return (
    <Modal title="Tally settings" onClose={onClose} width={820}>
      <Banner>{err}</Banner>
      <Banner kind="ok">{ok}</Banner>
      <fieldset disabled={!canEdit || busy} style={{ border: "none", padding: 0, margin: 0 }}>
        <h4 style={{ margin: "4px 0 8px" }}>Connection</h4>
        <div style={{ fontSize: 13.5, marginBottom: 8 }}>
          <span aria-hidden="true" style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", marginRight: 8, background: b.tally_open ? "var(--signal-green)" : b.online ? "var(--amber)" : "var(--alert-red)" }} />
          {!b.configured ? "No bridge file made yet." : b.tally_open ? `Connected — bridge on ${b.pc}, Tally open.` : b.online ? `Bridge running on ${b.pc}; Tally not answering.` : `Bridge not running${b.seen_at ? ` (last seen ${when(b.seen_at)})` : ""}.`}
        </div>
        <Field label="Tally company name — exactly as in Tally" hint="Posting goes to this company; it must be open in Tally.">
          <input value={f.company} onChange={(e) => set("company", e.target.value)} style={{ width: "100%" }} />
        </Field>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          <button type="button" onClick={bridgeFile}>{b.configured ? "Download a new bridge file" : "Download the bridge file"}</button>
        </div>
        <div style={{ ...sub, lineHeight: 1.5 }}>
          On the Tally computer: in TallyPrime turn on <b>Help › Settings › Connectivity › “TallyPrime acts as Server”</b> (port 9000). Then run OORM-Tally-Bridge.bat and keep its window open while posting. Windows may say it protected the PC the first time — More info › Run anyway.
        </div>

        <h4 style={{ margin: "16px 0 8px" }}>Voucher &amp; numbering</h4>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Field label="Voucher type in Tally" style={{ flex: "2 1 200px" }}><input value={f.voucher_type} onChange={(e) => set("voucher_type", e.target.value)} style={{ width: "100%" }} /></Field>
          <Field label="Prefix" style={{ flex: "1 1 90px" }}><input value={f.prefix} onChange={(e) => set("prefix", e.target.value)} placeholder="none" style={{ width: "100%" }} /></Field>
          <Field label="Next number" style={{ flex: "1 1 110px" }}><input type="number" min="1" value={f.next_no} onChange={(e) => set("next_no", e.target.value)} style={{ width: "100%", fontWeight: 800 }} /></Field>
          <Field label="Suffix" style={{ flex: "1 1 90px" }}><input value={f.suffix} onChange={(e) => set("suffix", e.target.value)} placeholder="none" style={{ width: "100%" }} /></Field>
        </div>
        <div style={{ fontSize: 13, marginBottom: 6 }}>{preview ? <>Next voucher will be <b>{preview}</b>, then {f.prefix}{Number(f.next_no) + 1}{f.suffix} …</> : "Type the next Tally number once — each approval takes the next."}</div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5, marginBottom: 8 }}>
          <input type="checkbox" checked={!!f.restart_april} onChange={(e) => set("restart_april", e.target.checked)} /> Ask for a new start number on 1 April
        </label>
        <Field label="B2C invoices dated from" hint="Earlier invoices are not listed (they were entered in Tally by hand).">
          <input type="date" value={f.from_date} onChange={(e) => set("from_date", e.target.value)} />
        </Field>

        <h4 style={{ margin: "16px 0 8px" }}>Tally ledger names <span style={{ ...sub, fontWeight: 400 }}>— spelt exactly as in Tally</span></h4>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13.5, marginBottom: 8 }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="radio" name="party" checked={f.party_mode === "cash"} onChange={() => set("party_mode", "cash")} /> One ledger for every B2C customer</label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="radio" name="party" checked={f.party_mode === "customer"} onChange={() => set("party_mode", "customer")} /> Each customer's own ledger (the bill name — it must exist in Tally)</label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "0 20px" }}>
          {Object.keys(s.ledger_labels).filter((k) => !(k === "party" && f.party_mode === "customer")).map((k) => (
            <Field key={k} label={<>{s.ledger_labels[k]} {s.check && !s.check.pending && s.check.ok && (missing.has(k) ? <span style={{ color: "var(--alert-red)" }}>· not in Tally</span> : found.has(k) ? <span style={{ color: "var(--signal-green)" }}>· found</span> : null)}</>}>
              <input value={f.ledgers[k] || ""} onChange={(e) => setF((x) => ({ ...x, ledgers: { ...x.ledgers, [k]: e.target.value } }))} style={{ width: "100%" }} />
            </Field>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={check} disabled={!b.tally_open}>Check names in Tally</button>
          <span style={{ fontSize: 13 }}>
            {pending ? "Asking Tally…"
              : s.check?.ok ? (s.check.missing.length ? <span style={{ color: "var(--alert-red)" }}>{s.check.missing.length} not in Tally: {s.check.missing.map((m) => `“${m.name}”`).join(", ")}</span>
                : <span style={{ color: "var(--signal-green)" }}>✓ All found in {s.check.company} ({s.check.ledger_count} ledgers)</span>)
                : s.check?.error ? <span style={{ color: "var(--alert-red)" }}>{s.check.error}</span> : !b.tally_open ? <span style={sub}>Needs the bridge running and Tally open.</span> : null}
          </span>
        </div>
        <div style={{ ...sub, marginTop: 10 }}>Vouchers go in as accounting vouchers (ledgers and amounts), with the delivery note, site, grade, m³, rate and vehicle in the narration.</div>
      </fieldset>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button type="button" onClick={onClose}>Close</button>
        {canEdit && <button type="button" className="btn-primary" disabled={busy} onClick={save}>Save</button>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------
export default function TallyB2c() {
  const { can } = usePermissions();
  const canEdit = can("accounts.tally-b2c", "edit");
  const canSettings = can("accounts.tally-settings", "view");
  const canSettingsEdit = can("accounts.tally-settings", "edit");
  const [month, setMonth] = useState(thisMonth());
  const [state, setState] = useState("to_verify");
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [sel, setSel] = useState(() => new Set());
  const [open, setOpen] = useState(null);
  const [settings, setSettings] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [watch, setWatch] = useState(null); // ids just posted — show their result
  const [busy, setBusy] = useState(false);
  const firstLoad = useRef(true);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ state, ...(month !== "all" ? { month } : {}), ...(q.trim() ? { q: q.trim() } : {}) });
    return apiRequest(`/accounts/tally/b2c?${qs}`).then((r) => {
      setData(r); setErr("");
      // First visit: nothing to verify this month but something approved → show that.
      if (firstLoad.current) {
        firstLoad.current = false;
        if (state === "to_verify" && !r.counts.to_verify && (r.counts.approved || r.counts.failed)) setState(r.counts.failed ? "failed" : "approved");
      }
      return r;
    }).catch((e) => setErr(e.message));
  }, [month, state, q]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSel(new Set()); }, [month, state, q]);

  // While anything is on its way to Tally, look again every few seconds.
  const sending = (data?.counts?.queued || 0) > 0 || !!watch;
  useEffect(() => {
    const t = setInterval(load, sending ? 3000 : 20000);
    return () => clearInterval(t);
  }, [sending, load]);

  const rows = data?.rows || [];
  const picked = rows.filter((r) => sel.has(r.id));
  const pickTotal = picked.reduce((t, r) => t + Number(r.tally_total || 0), 0);
  const allPostable = rows.filter(postable);
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function post(list) {
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await apiRequest("/accounts/tally/b2c/post", { method: "POST", body: { ids: list.map((x) => x.id) } });
      setConfirm(null); setSel(new Set());
      setWatch({ ids: r.queued.map((x) => x.id), refused: r.refused, started: Date.now() });
      setState("all"); setMonth("all");
      load();
    } catch (e) { setErr(e.message); setConfirm(null); } finally { setBusy(false); }
  }
  async function xml() {
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await apiRequest("/accounts/tally/b2c/xml", { method: "POST", body: { ids: picked.map((x) => x.id) } });
      download(r.filename, r.xml, "application/xml");
      setOk(`${r.count} voucher(s) in ${r.filename}. In TallyPrime: Import › Transactions › choose this file. Then tick them here and “Mark as entered in Tally”.`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function bulk(path, msg) {
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await apiRequest(`/accounts/tally/b2c/${path}`, { method: "POST", body: { ids: picked.map((x) => x.id) } });
      setOk(msg(r)); setSel(new Set()); load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const watched = useMemo(() => {
    if (!watch) return null;
    const list = watch.ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
    const done = list.filter((r) => !["queued", "posting"].includes(r.state));
    return { list, done: done.length === watch.ids.length, posted: list.filter((r) => r.state === "posted").length };
  }, [watch, rows]);

  if (open) {
    return <Verify id={open} canEdit={canEdit} onOpen={(id) => setOpen(id)} onClose={(changedSomething) => { setOpen(null); if (changedSomething) load(); }} />;
  }

  const c = data?.counts || {};
  const b = data?.bridge;
  return (
    <div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <BridgeStrip bridge={b} onSettings={canSettings ? () => setSettings(true) : null} />
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 14, flex: "0 1 auto" }}>
          <div>
            <div style={sub}>Next Tally voucher no.</div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{data?.next_voucher_no || "—"}</div>
          </div>
          {canSettings && <button type="button" onClick={() => setSettings(true)}>{data?.next_voucher_no ? "Change" : "Set"}</button>}
        </div>
      </div>
      <Banner>{err}</Banner>
      <Banner kind="ok">{ok}</Banner>
      {!!data && (data.elsewhere?.to_verify > 0 || data.elsewhere?.to_post > 0) && (
        <Banner kind="warn">Other months: {data.elsewhere.to_verify} to verify, {data.elsewhere.to_post} approved and not in Tally yet. <button type="button" className="btn-link" style={{ border: "none", background: "none", padding: 0, color: "var(--rebar)" }} onClick={() => setMonth("all")}>Show all months</button></Banner>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {FILTERS.map(([k, label]) => {
            const n = k === "all" ? c.all : c[k];
            if (k === "changed" && !c.changed) return null;
            return (
              <button key={k} type="button" className={`btn-tab${state === k ? " active" : ""}`} onClick={() => setState(k)}
                style={k === "failed" && n ? { color: state === k ? "#fff" : "var(--alert-red)", fontWeight: 700 } : undefined}>
                {label}{n != null ? ` · ${n}` : ""}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" style={{ minHeight: 38, padding: "6px 8px", fontSize: 14 }}>
            {months(14).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
            <option value="all">All months</option>
          </select>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer, DN, Tally no." aria-label="Search" style={{ width: 220, minHeight: 38, padding: "6px 10px", fontSize: 14 }} />
        </div>
      </div>

      {!data ? <Empty>Loading…</Empty> : !rows.length ? (
        <Empty>{state === "to_verify" ? `Nothing to verify${month !== "all" ? ` in ${monthName(month)}` : ""}.` : "Nothing here."} Only B2C invoices (no GSTIN) dated from {fmtDate(data.from_date)} are listed.</Empty>
      ) : (
        <Table minWidth={980} head={<>
          <th style={{ ...TH, width: 34 }}>
            {canEdit && allPostable.length > 0 && (
              <input type="checkbox" aria-label="Tick every approved invoice" checked={allPostable.every((r) => sel.has(r.id))}
                onChange={(e) => setSel(e.target.checked ? new Set(allPostable.map((r) => r.id)) : new Set())} />
            )}
          </th>
          <th style={TH}>Date</th><th style={TH}>Delivery note</th><th style={TH}>Customer</th><th style={TH}>Site</th><th style={TH}>Grade</th>
          <th style={{ ...TH, textAlign: "right" }}>m³</th><th style={{ ...TH, textAlign: "right" }}>Total</th><th style={TH}>Tally no.</th><th style={TH}>Status</th><th style={TH} />
        </>}>
          {rows.map((r) => {
            const st = STATE[r.state] || [r.state, "badge-neutral"];
            const canTick = canEdit && postable(r);
            const canStop = canEdit && r.state === "queued";
            return (
              <tr key={r.id} style={{ ...row, background: sel.has(r.id) ? "#FFF8F1" : undefined }}>
                <td style={TD}>{(canTick || canStop) && <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Tick ${r.ticket_number}`} />}</td>
                <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmtDate(r.date)}</td>
                <td style={TD}>{r.ticket_number}</td>
                <td style={{ ...TD, fontWeight: 600 }}>{r.customer}{r.cash && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>Cash</span>}</td>
                <td style={TD}>{r.site || "—"}</td>
                <td style={TD}>{r.grade || "—"}</td>
                <td style={NUM}>{r.m3}</td>
                <td style={NUM}>{money(r.tally_total)}</td>
                <td style={{ ...TD, fontWeight: 700 }}>{r.voucher_no || "—"}</td>
                <td style={TD}>
                  <span className={`badge ${st[1]}`}>{st[0]}</span>
                  {r.changed && <span className="badge badge-danger" style={{ marginLeft: 4 }}>{["posted", "manual"].includes(r.state) ? "Changed after posting" : "Changed — approve again"}</span>}
                  {r.note && <div style={{ fontSize: 11.5, marginTop: 3, color: r.state === "failed" ? "var(--alert-red)" : "var(--amber)", maxWidth: 300 }}>{r.note}</div>}
                  {["posted", "manual"].includes(r.state) && r.posted_at && <div style={{ ...sub, fontSize: 11.5, marginTop: 3 }}>{when(r.posted_at)}{r.posted_by ? ` · ${r.posted_by}` : ""}</div>}
                </td>
                <td style={TD}>
                  <button type="button" className={["to_verify", "back"].includes(r.state) || r.changed ? "btn-primary" : ""} onClick={() => setOpen(r.id)}
                    style={{ whiteSpace: "nowrap" }}>{["to_verify", "back"].includes(r.state) || (r.changed && !["posted", "manual"].includes(r.state)) ? "Verify" : "Open"}</button>
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <div style={{ ...sub, margin: "8px 0 70px" }}>Only invoices without a GSTIN (B2C) are listed. Tick approved invoices to post them. Once in Tally an invoice is not sent again; a change after that is made in Tally (or with a credit note).</div>

      {canEdit && picked.length > 0 && (
        <div style={{ position: "sticky", bottom: 52, background: "#fff", border: "1px solid var(--border-strong)", borderRadius: 10, padding: "10px 14px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", boxShadow: "var(--shadow)", zIndex: 5 }}>
          <div style={{ fontSize: 14 }}><b>{picked.length} ticked</b> · {picked.map((r) => r.voucher_no).filter(Boolean).slice(0, 6).join(", ")}{picked.length > 6 ? " …" : ""} · {rs2(pickTotal)}</div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {picked.every((r) => r.state === "queued")
              ? <button type="button" disabled={busy} onClick={() => bulk("unqueue", (r) => `${r.stopped} stopped (the rest were already with Tally).`)}>Stop sending</button>
              : <>
                <button type="button" disabled={busy} onClick={() => bulk("mark-entered", (r) => `${r.marked} marked as entered in Tally.`)}>Mark as entered in Tally</button>
                <button type="button" disabled={busy} onClick={xml}>Download Tally XML</button>
                <button type="button" className="btn-primary" disabled={busy || !picked.every(postable)} onClick={() => setConfirm(picked.filter(postable))}>Post {picked.length} to Tally</button>
              </>}
          </div>
        </div>
      )}

      {confirm && (
        <Modal title={`Post ${confirm.length} invoice${confirm.length > 1 ? "s" : ""} to Tally?`} onClose={() => setConfirm(null)} width={620}>
          <div className="card" style={{ background: b?.tally_open ? "var(--signal-green-bg)" : "var(--amber-bg)", color: b?.tally_open ? "var(--signal-green)" : "var(--amber)", fontSize: 13, marginBottom: 10 }}>
            {b?.tally_open ? <>Tally is open on {b.pc} — company <b>{data.company}</b></> : "Tally is not connected right now — the app will say so if you post."}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead><tr><th style={TH}>Voucher no.</th><th style={TH}>Date</th><th style={TH}>Customer</th><th style={{ ...TH, textAlign: "right" }}>Total</th></tr></thead>
            <tbody>
              {confirm.map((r) => (
                <tr key={r.id} style={row}><td style={{ ...TD, fontWeight: 700 }}>{r.voucher_no}{r.state === "failed" && <span style={{ color: "var(--alert-red)", fontWeight: 600, fontSize: 12 }}> · retry</span>}</td>
                  <td style={TD}>{fmtDate(r.voucher_date || r.date)}</td><td style={TD}>{r.customer}</td><td style={NUM}>{rs2(r.tally_total)}</td></tr>
              ))}
              <tr style={row}><td style={{ ...TD, fontWeight: 700 }} colSpan={3}>Total</td><td style={{ ...NUM, fontWeight: 700 }}>{rs2(confirm.reduce((t, r) => t + Number(r.tally_total || 0), 0))}</td></tr>
            </tbody>
          </table>
          <div style={{ ...sub, fontSize: 13, margin: "10px 0" }}>Each becomes a <b>{data.voucher_type}</b> voucher in Tally with the same number and date. The app first checks that Tally doesn't already have that number. Once posted, an invoice is not sent again.</div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={() => setConfirm(null)}>Cancel</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => post(confirm)}>Post to Tally</button>
          </div>
        </Modal>
      )}

      {watch && watched && (
        <Modal title={watched.done ? `${watched.posted} of ${watch.ids.length} posted to Tally` : `Sending ${watch.ids.length} to Tally…`} onClose={() => setWatch(null)} width={620}>
          {watch.refused?.length > 0 && <Banner>Not sent: {watch.refused.map((x) => `${x.voucher_no || `#${x.id}`} — ${x.error}`).join("; ")}</Banner>}
          <div className="card" style={{ padding: 0 }}>
            {watched.list.map((r, i) => {
              const okk = r.state === "posted", bad = r.state === "failed", wait = ["queued", "posting"].includes(r.state);
              return (
                <div key={r.id} style={{ display: "flex", gap: 12, padding: "10px 14px", borderTop: i ? "1px solid var(--border)" : "none", background: bad ? "var(--alert-red-bg)" : undefined }}>
                  <span aria-hidden="true" style={{ width: 24, height: 24, borderRadius: "50%", flex: "none", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800,
                    background: okk ? "var(--signal-green-bg)" : bad ? "#fff" : "var(--concrete)", color: okk ? "var(--signal-green)" : bad ? "var(--alert-red)" : "var(--slate)" }}>{okk ? "✓" : bad ? "✕" : "…"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{r.voucher_no} · {r.customer} · {rs2(r.tally_total)}</div>
                    <div style={{ fontSize: 12.5, color: bad ? "var(--alert-red)" : "var(--slate)" }}>
                      {okk ? `${data.voucher_type} voucher ${r.voucher_no} created in Tally` : bad ? r.note : r.state === "posting" ? "Tally is making the voucher…" : "Checking the number in Tally…"}
                    </div>
                    {bad && canEdit && (
                      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                        <button type="button" onClick={() => { setWatch(null); setOpen(r.id); }}>Change number &amp; retry</button>
                      </div>
                    )}
                  </div>
                  {wait && <span style={sub}>waiting</span>}
                </div>
              );
            })}
          </div>
          {!watched.done && Date.now() - watch.started > 20000 && (
            <div style={{ ...sub, marginTop: 8 }}>Taking longer than usual — is the Tally Bridge window open on {b?.pc || "the Tally computer"} and Tally open? You can close this; the list keeps the status.</div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <button type="button" onClick={() => setWatch(null)}>Close</button>
          </div>
        </Modal>
      )}

      {settings && <Settings canEdit={canSettingsEdit} onClose={() => { setSettings(false); load(); }} />}
    </div>
  );
}
