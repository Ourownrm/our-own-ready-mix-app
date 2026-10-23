// Round 224 — Cost → C Ledger (owner, 21 Oct 2026; mock-up "C Ledger Mockup").
// The owner's Site Ledger app inside the Cost module: delivery records with
// split cash collections, cash holders who accept / reject them, transfers,
// bank deposits and expenses.
//
// Shown ONLY to people given C Ledger rights by name (Super Admin → C Ledger
// users) — Administrator included. What each person sees follows their four
// rights: Entry, View entry data, Cash holder, View transactions.
//
// Round 227: "Paid to bank" collection lines; other income (scrap, used oil);
// a record with no delivery note is a collection only, not a sale.
//
// The flag: the owner's rule decides how a flagged / not-flagged record is
// counted in Sales and Cost. That rule is applied in the backend
// (lib/cLedger.js) and is deliberately NOT written on any screen.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import {
  useCostData, Loading, MonthSelect, Actions, BTN, Tile, Note, Modal, downloadExcel, currentMonth,
  rs, num, fmtDay, H2, SUB, MUTED, R, NUM, GRID, ROW, panel,
} from "./costUi.jsx";

const STATUS = {
  accepted: { label: "Accepted", bg: "var(--signal-green-bg)", fg: "#155C40" },
  pending: { label: "Pending", bg: "#E2EAF6", fg: "#1F4A82" },
  rejected: { label: "Rejected", bg: "var(--alert-red-bg)", fg: "var(--alert-red)" },
  done: { label: "", bg: "transparent", fg: "var(--slate)" },
};
const MODES = [["cash", "Cash"], ["upi", "UPI"], ["cheque", "Cheque"]];
const INPUT = { padding: "9px 10px", fontSize: 14, border: "1px solid var(--border-strong)", borderRadius: 7, background: "var(--surface)",
  color: "var(--charcoal)", minHeight: 42, width: "100%", boxSizing: "border-box", fontFamily: "inherit" };
const LBL = { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4 };
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export function FlagIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 22V3" /><path d="M5 3h12l-2.5 4.5L17 12H5" />
    </svg>
  );
}
function FlagPill() {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 20, background: "var(--amber-bg)", color: "#7A4F00", whiteSpace: "nowrap" }}><FlagIcon size={10} />Flagged</span>;
}
function Badge({ status }) {
  const s = STATUS[status] || STATUS.done;
  if (!s.label) return null;
  return <span style={{ fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 20, background: s.bg, color: s.fg, whiteSpace: "nowrap" }}>{s.label}</span>;
}
function Pills({ value, onChange, options }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {options.map(([k, label]) => (
        <button key={k} type="button" className={`btn-tab${value === k ? " active" : ""}`} onClick={() => onChange(k)}
          style={{ padding: "7px 13px", minHeight: 36, borderRadius: 999, fontSize: 12.5 }}>{label}</button>
      ))}
    </div>
  );
}
function FlagButton({ on, onClick, disabled, label }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={on}
      style={{ padding: "6px 10px", minHeight: 36, fontSize: 12, fontWeight: 600, display: "inline-flex", gap: 5, alignItems: "center", whiteSpace: "nowrap",
        background: on ? "var(--amber-bg)" : "var(--surface)", color: on ? "#7A4F00" : "var(--slate)", borderColor: on ? "#D9A62B" : "var(--border-strong)" }}>
      <FlagIcon />{on ? "Flagged" : "Flag"}
    </button>
  );
}

export default function CostCLedgerTab() {
  const { data: me, error } = useCostData("/cost/c-ledger/me");
  const [view, setView] = useState(null);
  const [month, setMonth] = useState(currentMonth());
  if (!me) return <Loading error={error} />;
  const a = me.access;
  if (!a.any) return <div className="card" style={{ fontSize: 13.5 }}>C Ledger has not been opened for you. A Super Admin gives access by name.</div>;
  const views = [
    a.view_entries && ["entries", "Deliveries & collections"],
    a.cash_holder && ["wallet", "My wallet"],
    // Round 229 (owner): independent rights — Entry is deliveries only.
    a.view_txns && ["txns", "Expenses & transactions"],
  ].filter(Boolean);
  const cur = views.find((v) => v[0] === view)?.[0] || views[0][0];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
        {views.length > 1 ? <Pills value={cur} onChange={setView} options={views} /> : <h1 style={{ margin: 0, fontSize: 22 }}>{views[0][1]}</h1>}
        <MonthSelect value={month} onChange={setMonth} />
      </div>
      {cur === "entries" && <EntriesView me={me} month={month} />}
      {cur === "wallet" && <WalletView me={me} month={month} />}
      {cur === "txns" && <TxnsView me={me} month={month} />}
    </div>
  );
}

// ================================================ deliveries & collections ===
function EntriesView({ me, month }) {
  const canEdit = me.access.entry;
  const { data: d, error, reload } = useCostData(`/cost/c-ledger/deliveries?month=${month}`);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [form, setForm] = useState(null); // {} new | record
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    if (!d) return [];
    const qq = q.trim().toLowerCase();
    return d.deliveries.filter((r) => (filter === "all" || (filter === "flagged" ? r.flagged : !r.flagged))
      && (!qq || `${r.customer_name} ${r.location || ""} ${r.tickets.map((t) => t.number).join(" ")}`.toLowerCase().includes(qq)));
  }, [d, filter, q]);

  if (!d) return <Loading error={error} />;
  const s = d.summary;

  async function flag(r) {
    setBusy(true); setErr("");
    try { await apiRequest(`/cost/c-ledger/deliveries/${r.id}/flag`, { method: "POST", body: { flagged: !r.flagged } }); reload(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function remove(r) {
    if (!window.confirm(`Delete the record for ${r.customer_name} (${fmtDay(r.entry_date)})?`)) return;
    setBusy(true); setErr("");
    try { await apiRequest(`/cost/c-ledger/deliveries/${r.id}`, { method: "DELETE" }); reload(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  function excel() {
    const head = ["Date", "Customer", "Location", "Delivery notes", "Grade", "m³", "Rate", "Other charges", "Total", "Collected", "Balance", "Sales value", "Flagged", "Collections"];
    downloadExcel(`C-Ledger-${month}.xlsx`, [{ name: "Deliveries", rows: [head, ...d.deliveries.map((r) => [
      r.entry_date, r.customer_name, r.location || "", r.tickets.map((t) => t.number).join(", "), r.grade || "", r.qty_m3, r.rate, r.other_charges,
      r.total, r.collected, r.balance, r.sales_value, r.flagged ? "Yes" : "",
      r.collections.map((c) => `${c.amount} ${c.holder} ${c.status}`).join("; ")])] }]);
  }

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h2 style={{ ...H2, fontSize: 18 }}>Deliveries &amp; collections — {d.label}</h2>
          <div style={SUB}>Amounts as billed and collected.</div>
        </div>
        <Actions>
          <label style={LBL}>Search
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer, site or delivery note" style={{ ...INPUT, minWidth: 220, fontSize: 13, minHeight: 40 }} />
          </label>
          <button type="button" style={BTN} onClick={excel}>Export Excel</button>
          {canEdit && <button type="button" className="btn-primary" style={BTN} onClick={() => setForm({})}>+ New delivery entry</button>}
        </Actions>
      </div>

      <div style={GRID(190)}>
        <Tile label="Billed" value={rs(s.billed)} note={`${s.count} deliveries · ${num(s.m3, 1)} m³`} />
        <Tile label="Collected" value={rs(s.collected)} note={s.pending ? `${rs(s.pending)} awaiting acceptance` : "all accepted"} />
        <Tile label="Balance due" value={rs(s.balance)} note={s.rejected ? `incl. ${rs(s.rejected)} rejected, to reassign` : null} />
        <Tile label="Sales value" value={rs(s.sales_value)} note={`${s.flagged} flagged · ${s.count - s.flagged} not flagged${s.unlinked ? ` · ${s.unlinked} without a delivery note not counted` : ""}`} dark />
      </div>

      {err && <Note tone="bad">{err}</Note>}
      {d.rejected_lines.length > 0 && (
        <Note tone="bad">
          {d.rejected_lines.map((c) => (
            <div key={c.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", padding: "3px 0" }}>
              <span><b>{rs(c.amount)} rejected by {c.holder}</b> — {c.customer_name}, {fmtDay(c.entry_date)}{c.reject_reason ? ` (“${c.reject_reason}”)` : ""}.</span>
              {canEdit && <button type="button" style={{ ...BTN, minHeight: 36 }} onClick={() => setForm(d.deliveries.find((r) => r.id === c.delivery_id))}>Reassign</button>}
            </div>
          ))}
        </Note>
      )}
      {s.unlinked > 0 && <Note>{s.unlinked} record{s.unlinked > 1 ? "s have" : " has"} no delivery note ({rs(s.unlinked_total)}). {s.unlinked > 1 ? "They are" : "It is"} kept for collections only and not counted in Sales{canEdit ? " — if there is a challan, open the record and pick it" : ""}.</Note>}

      <div style={panel("1 1 100%")}>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
          <h2 style={H2}>Delivery records</h2>
          <Pills value={filter} onChange={setFilter} options={[["all", `All (${d.deliveries.length})`], ["flagged", `Flagged (${s.flagged})`], ["unflagged", `Not flagged (${d.deliveries.length - s.flagged})`]]} />
        </div>
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table>
            <thead><tr>
              <th>Date</th><th>Customer · site</th><th>Delivery notes</th><th>Grade</th><th style={R}>m³</th><th style={R}>Rate</th><th style={R}>Other</th>
              <th style={R}>Total</th><th>Collections</th><th style={R}>Balance</th><th style={R}>Sales value</th><th>Flag</th>{canEdit && <th />}
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ background: r.flagged ? "#FFFBF2" : undefined, verticalAlign: "top" }}>
                  <td style={{ whiteSpace: "nowrap", ...NUM }}>{fmtDay(r.entry_date)}</td>
                  <td style={{ minWidth: 160 }}><div style={{ fontWeight: 600 }}>{r.customer_name}</div><div style={MUTED}>{r.location}</div></td>
                  <td style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{r.tickets.length ? r.tickets.map((t) => t.number).join(", ") : <span style={{ color: "var(--alert-red)" }}>not linked</span>}</td>
                  <td>{r.grade || "—"}</td>
                  <td style={R}>{num(r.qty_m3, 1)}</td>
                  <td style={R}>{num(r.rate)}</td>
                  <td style={{ ...R, color: "var(--slate)" }}>{r.other_charges ? num(r.other_charges) : "—"}</td>
                  <td style={{ ...R, fontWeight: 600 }}>{rs(r.total)}</td>
                  <td style={{ minWidth: 150 }}>
                    {r.collections.length === 0 ? <span style={MUTED}>—</span> : r.collections.map((c) => (
                      <div key={c.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, whiteSpace: "nowrap", padding: "1px 0" }}>
                        <b style={NUM}>{rs(c.amount)}</b><span>→ {c.holder}</span>{c.bank ? <span style={{ fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 20, background: "#E2EAF6", color: "#1F4A82" }}>Paid to bank</span> : <Badge status={c.status} />}
                      </div>
                    ))}
                  </td>
                  <td style={{ ...R, fontWeight: 600, color: r.balance > 0.5 ? "var(--alert-red)" : "var(--signal-green)" }}>{rs(r.balance)}</td>
                  <td style={{ ...R, fontWeight: 600 }}>{r.tickets.length ? rs(r.sales_value) : <span style={MUTED} title="No delivery note — not a sale">—</span>}</td>
                  <td>{canEdit ? <FlagButton on={r.flagged} disabled={busy} onClick={() => flag(r)} label={`${r.flagged ? "Remove flag on" : "Flag"} ${r.customer_name}`} /> : r.flagged ? <FlagPill /> : null}</td>
                  {canEdit && (
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button type="button" style={{ padding: "6px 10px", minHeight: 36, fontSize: 12 }} onClick={() => setForm(r)}>Edit</button>{" "}
                      {!r.collections.some((c) => c.status === "accepted") && <button type="button" style={{ padding: "6px 10px", minHeight: 36, fontSize: 12 }} onClick={() => remove(r)} disabled={busy}>Delete</button>}
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={13} style={{ ...MUTED, padding: 16 }}>No records{filter !== "all" || q ? " match" : " this month"}.</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ ...MUTED, marginTop: 8 }}>An accepted collection is locked. A rejected one comes back here to be given to another cash holder.</div>
      </div>
      {form && <DeliveryForm me={me} rec={form.id ? form : null} onClose={() => setForm(null)} onSaved={() => { setForm(null); reload(); }} />}
    </>
  );
}

function DeliveryForm({ me, rec, onClose, onSaved }) {
  const [f, setF] = useState(() => rec ? {
    entry_date: rec.entry_date, customer_name: rec.customer_name, location: rec.location || "", grade: rec.grade || "", qty_m3: String(rec.qty_m3),
    rate: String(rec.rate), other_charges: rec.other_charges ? String(rec.other_charges) : "", sales_rep: rec.sales_rep || "", note: rec.note || "", flagged: rec.flagged,
  } : { entry_date: today(), customer_name: "", location: "", grade: "", qty_m3: "", rate: "", other_charges: "", sales_rep: "", note: "", flagged: false });
  const [picked, setPicked] = useState(() => rec ? rec.tickets.map((t) => ({ id: t.id, number: t.number, date: t.date, loaded: t.loaded })) : []);
  // Locked: accepted by a cash holder. "Paid to bank" lines stay editable.
  const locked = rec ? rec.collections.filter((c) => c.status === "accepted" && !c.bank) : [];
  const [lines, setLines] = useState(() => rec ? rec.collections.filter((c) => !(c.status === "accepted" && !c.bank))
    .map((c) => ({ ...c, amount: String(c.amount), holder_id: c.bank ? "bank" : c.holder_id, paid_on: c.paid_on || "" })) : []);
  const [noNote, setNoNote] = useState(rec ? rec.tickets.length === 0 : false);
  const [tq, setTq] = useState("");
  const [cands, setCands] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (noNote) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      apiRequest(`/cost/c-ledger/tickets?day=${f.entry_date}${tq.trim() ? `&q=${encodeURIComponent(tq.trim())}` : ""}`)
        .then((r) => { if (alive) setCands(r.tickets); }).catch((e) => { if (alive) setErr(e.message); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [f.entry_date, tq, noNote]);

  function toggle(t) {
    const on = picked.some((p) => p.id === t.id);
    const next = on ? picked.filter((p) => p.id !== t.id) : [...picked, t];
    setPicked(next);
    if (!on) {
      // The challan fills in the record; the first one picked sets the names.
      setF((x) => ({
        ...x,
        customer_name: x.customer_name || t.customer || "",
        location: x.location || t.site || "",
        grade: x.grade || t.grade || "",
        rate: x.rate || (t.rate_per_m3 != null ? String(t.rate_per_m3) : ""),
        qty_m3: String(Math.round(next.reduce((s, p) => s + (Number(p.loaded) || 0), 0) * 100) / 100),
        other_charges: String(Math.round(next.reduce((s, p) => s + (Number(p.other) || 0), 0) * 100) / 100 || ""),
      }));
    } else {
      setF((x) => ({ ...x, qty_m3: String(Math.round(next.reduce((s, p) => s + (Number(p.loaded) || 0), 0) * 100) / 100) }));
    }
  }

  const total = (Number(f.qty_m3) || 0) * (Number(f.rate) || 0) + (Number(f.other_charges) || 0);
  const collected = locked.reduce((s, c) => s + c.amount, 0) + lines.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const balance = total - collected;

  async function save() {
    setBusy(true); setErr("");
    const body = { ...f, ticket_ids: noNote ? [] : picked.map((p) => p.id),
      collections: lines.map((l) => ({ id: l.id, amount: l.amount, holder_id: l.holder_id === "bank" ? "bank" : Number(l.holder_id), mode: l.mode,
        paid_on: l.holder_id === "bank" ? (l.paid_on || f.entry_date) : null })) };
    try {
      await apiRequest(rec ? `/cost/c-ledger/deliveries/${rec.id}` : "/cost/c-ledger/deliveries", { method: rec ? "PUT" : "POST", body });
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  const holders = me.holders;
  return (
    <Modal title={rec ? "Edit delivery record" : "New delivery entry"} onClose={onClose} width={760}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={GRID(200)}>
          <label style={LBL}>Date<input type="date" value={f.entry_date} max={today()} onChange={(e) => set("entry_date", e.target.value)} style={INPUT} /></label>
          {!noNote && <label style={LBL}>Find delivery note<input type="search" value={tq} onChange={(e) => setTq(e.target.value)} placeholder="Number, customer or site" style={INPUT} /></label>}
        </div>
        {!noNote && (
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, maxHeight: 220, overflowY: "auto" }}>
            {cands == null ? <div style={{ ...MUTED, padding: 10 }}>Loading delivery notes…</div>
              : cands.length === 0 ? <div style={{ ...MUTED, padding: 10 }}>No delivery notes around this date{tq ? " match" : ""}.</div>
                : cands.map((t) => {
                  const on = picked.some((p) => p.id === t.id);
                  const elsewhere = t.linked_to && t.linked_to !== rec?.id;
                  return (
                    <label key={t.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 10px", borderBottom: "1px solid var(--border)", fontSize: 13,
                      background: on ? "#F2F8F5" : undefined, opacity: elsewhere ? 0.5 : 1, cursor: elsewhere ? "not-allowed" : "pointer" }}>
                      <input type="checkbox" checked={on} disabled={!!elsewhere} onChange={() => toggle(t)} style={{ width: 18, height: 18, margin: 0 }} />
                      <span style={{ flex: 1 }}><b>{t.number}</b> · {fmtDay(t.date)} · {t.customer || "—"} · {t.site || "—"} · {t.grade || "—"} · {num(t.loaded, 1)} m³
                        {elsewhere ? " · already on another record" : ""}</span>
                    </label>
                  );
                })}
          </div>
        )}
        {!noNote && picked.length > 0 && <div style={{ fontSize: 12.5 }}>Picked: <b>{picked.map((p) => p.number).join(", ")}</b></div>}
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={noNote} onChange={(e) => { setNoNote(e.target.checked); if (e.target.checked) setPicked([]); }} style={{ width: 18, height: 18, margin: 0 }} />
          No delivery note in the app for this (pick it later)
        </label>

        <div style={GRID(170)}>
          <label style={LBL}>Customer<input value={f.customer_name} onChange={(e) => set("customer_name", e.target.value)} style={INPUT} /></label>
          <label style={LBL}>Location / site<input value={f.location} onChange={(e) => set("location", e.target.value)} style={INPUT} /></label>
          <label style={LBL}>Grade<input value={f.grade} onChange={(e) => set("grade", e.target.value.toUpperCase())} placeholder="e.g. M25" style={INPUT} /></label>
          <label style={LBL}>Quantity (m³)<input type="number" inputMode="decimal" min="0" value={f.qty_m3} onChange={(e) => set("qty_m3", e.target.value)} style={INPUT} /></label>
          <label style={LBL}>Rate (₹ / m³)<input type="number" inputMode="decimal" min="0" value={f.rate} onChange={(e) => set("rate", e.target.value)} style={INPUT} /></label>
          <label style={LBL}>Other charges (₹)<input type="number" inputMode="decimal" min="0" value={f.other_charges} onChange={(e) => set("other_charges", e.target.value)} style={INPUT} /></label>
          <label style={LBL}>Sales rep<input value={f.sales_rep} onChange={(e) => set("sales_rep", e.target.value)} style={INPUT} /></label>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={LBL}>Collections — split payments allowed</div>
          {locked.map((c) => (
            <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, background: "#F7F5F0", borderRadius: 7, padding: "8px 10px" }}>
              <b style={NUM}>{rs(c.amount)}</b> → {c.holder} <Badge status="accepted" /><span style={MUTED}>locked</span>
            </div>
          ))}
          {lines.map((l, i) => (
            <div key={l.id || `n${i}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, alignItems: "center" }}>
                <input type="number" inputMode="decimal" min="0" aria-label="Amount" placeholder="Amount" value={l.amount}
                  onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} style={INPUT} />
                <select aria-label="Cash holder" value={l.holder_id || ""} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, holder_id: e.target.value } : x)))} style={INPUT}>
                  <option value="">Cash holder…</option>
                  {holders.map((h) => <option key={h.id} value={h.id}>{h.short}</option>)}
                  <option value="bank">Paid to bank</option>
                </select>
                {l.holder_id === "bank" ? (
                  <input type="date" aria-label="Date it reached the bank" value={l.paid_on || f.entry_date} max={today()}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, paid_on: e.target.value } : x)))} style={INPUT} />
                ) : (
                  <select aria-label="Mode" value={l.mode === "bank" ? "cash" : l.mode || "cash"} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, mode: e.target.value } : x)))} style={INPUT}>
                    {MODES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                )}
                <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} style={{ minHeight: 42 }}>Remove</button>
              </div>
              {l.status === "rejected" && <div style={{ fontSize: 12, color: "var(--alert-red)" }}>Rejected by {l.holder}{l.reject_reason ? `: “${l.reject_reason}”` : ""} — change the cash holder (or keep) and save to send it again.</div>}
              {l.status === "pending" && l.id && <div style={MUTED}>Waiting for {l.holder} to accept.</div>}
              {l.holder_id === "bank" && <div style={MUTED}>Paid straight into the bank — counted as collected, in nobody&rsquo;s cash.</div>}
            </div>
          ))}
          <button type="button" onClick={() => setLines((ls) => [...ls, { amount: "", holder_id: holders[0]?.id || "", mode: "cash" }])}
            style={{ alignSelf: "flex-start", borderStyle: "dashed" }}>+ Add collection line</button>
          {holders.length === 0 && <div style={MUTED}>No cash holders yet — a Super Admin sets them under C Ledger users.</div>}
        </div>

        <label style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 14, fontWeight: 600, background: "var(--amber-bg)", border: "1px solid #E7D8AE", borderRadius: 8, padding: "10px 12px" }}>
          <input type="checkbox" checked={f.flagged} onChange={(e) => set("flagged", e.target.checked)} style={{ width: 18, height: 18, margin: 0 }} />
          <span style={{ color: "#7A4F00", display: "inline-flex" }}><FlagIcon size={14} /></span>Flag this record
        </label>
        <label style={LBL}>Note (optional)<input value={f.note} onChange={(e) => set("note", e.target.value)} style={INPUT} /></label>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
          {[["Total", total, null], ["Collected", collected, null], ["Balance", balance, balance > 0.5 ? "var(--alert-red)" : "var(--signal-green)"]].map(([k, v, c]) => (
            <div key={k} style={{ background: "#F7F5F0", borderRadius: 8, padding: "8px 12px" }}>
              <div style={{ ...LBL, display: "block" }}>{k}</div><div style={{ fontSize: 18, fontWeight: 700, color: c || undefined, ...NUM }}>{rs(Math.round(v * 100) / 100)}</div>
            </div>
          ))}
        </div>
        {err && <Note tone="bad">{err}</Note>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={BTN}>Cancel</button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy} style={BTN}>{busy ? "Saving…" : rec ? "Save changes" : "Save entry"}</button>
        </div>
      </div>
    </Modal>
  );
}

// ================================================================ wallet ===
function WalletView({ me, month }) {
  const { data: w, error, reload } = useCostData(`/cost/c-ledger/wallet?month=${month}`);
  const [modal, setModal] = useState(null); // transfer | bank | expense | {expense}
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState("");
  const [filter, setFilter] = useState("all");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!w) return <Loading error={error} />;
  const b = w.balance;

  async function act(path, body, method = "POST") {
    setBusy(true); setErr("");
    try { await apiRequest(path, { method, body }); setRejecting(null); setReason(""); reload(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const tx = w.transactions.filter((t) => filter === "all" || (filter === "flagged" ? t.flagged : !t.flagged));
  const respondPath = (i) => `/cost/c-ledger/${i.type === "collection" ? "collections" : i.type === "income" ? "incomes" : "transfers"}/${i.id}/respond`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 }}>
      <div style={panel("1 1 100%")}>
        <div style={{ ...LBL, display: "block" }}>Cash in hand</div>
        <div style={{ fontSize: 30, fontWeight: 700, color: b.balance < 0 ? "var(--alert-red)" : "var(--signal-green)", ...NUM }}>{rs(b.balance)}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 13, marginTop: 6 }}>
          {[["Collections accepted", b.collected], ["Other income", b.income || 0], ["Transfers in", b.transfer_in], ["Transfers out", -b.transfer_out], ["Deposited to bank", -b.deposited], ["Expenses", -b.expenses]].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--slate)" }}>{k}</span><span style={NUM}>{rs(v)}</span></div>
          ))}
        </div>
        {b.awaiting > 0 && <div style={{ fontSize: 12.5, color: "#1F4A82", fontWeight: 600, marginTop: 6 }}>+ {rs(b.awaiting)} awaiting your acceptance</div>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        <button type="button" style={{ minHeight: 48, fontWeight: 600 }} onClick={() => setModal("transfer")}>Transfer</button>
        <button type="button" style={{ minHeight: 48, fontWeight: 600 }} onClick={() => setModal("bank")}>Deposit to bank</button>
        <button type="button" style={{ minHeight: 48, fontWeight: 600 }} onClick={() => setModal("income")}>Other income</button>
        <button type="button" className="btn-primary" style={{ minHeight: 48, fontWeight: 600 }} onClick={() => setModal("expense")}>Add expense</button>
      </div>
      {err && <Note tone="bad">{err}</Note>}

      <div>
        <h2 style={{ ...H2, marginBottom: 8 }}>Incoming {w.incoming.length > 0 && <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 20, background: "#E2EAF6", color: "#1F4A82" }}>{w.incoming.length}</span>}</h2>
        {w.incoming.length === 0 ? <div className="card" style={{ ...MUTED, margin: 0 }}>Nothing waiting for you.</div> : w.incoming.map((i) => (
          <div key={`${i.type}${i.id}`} className="card" style={{ margin: "0 0 8px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <div><div style={{ fontWeight: 700 }}>{i.title}</div><div style={MUTED}>{i.meta}</div></div>
              <div style={{ textAlign: "right" }}><div style={MUTED}>{fmtDay(i.date)}</div>{i.flagged && <FlagPill />}</div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#F7F5F0", borderRadius: 8, padding: "8px 10px" }}>
              <span style={MUTED}>Amount</span><b style={{ fontSize: 18, ...NUM }}>{rs(i.amount)}</b>
            </div>
            {rejecting === `${i.type}${i.id}` ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {i.type !== "transfer" && <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? e.g. cash not received" aria-label="Reason" style={{ ...INPUT, flex: "1 1 200px" }} />}
                <button type="button" className="btn-danger" disabled={busy} style={{ minHeight: 44 }}
                  onClick={() => act(respondPath(i), { decision: "reject", reason })}>Reject</button>
                <button type="button" onClick={() => setRejecting(null)} style={{ minHeight: 44 }}>Back</button>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                <button type="button" style={{ minHeight: 46, color: "var(--alert-red)", borderColor: "var(--alert-red)" }} onClick={() => { setRejecting(`${i.type}${i.id}`); setReason(""); }}>Reject</button>
                <button type="button" disabled={busy} style={{ minHeight: 46, background: "var(--signal-green)", borderColor: "var(--signal-green)", color: "#fff", fontWeight: 600 }}
                  onClick={() => act(respondPath(i), { decision: "accept" })}>Accept</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <h2 style={H2}>My transactions — {w.label}</h2>
          <Pills value={filter} onChange={setFilter} options={[["all", "All"], ["flagged", "Flagged"], ["unflagged", "Not flagged"]]} />
        </div>
        <div className="card" style={{ margin: 0, padding: 0, overflow: "hidden" }}>
          {tx.length === 0 && <div style={{ ...MUTED, padding: 14 }}>Nothing this month.</div>}
          {tx.map((t) => (
            <div key={`${t.kind}${t.id}`} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.desc}</div>
                <div style={MUTED}>{fmtDay(t.date)}{t.meta ? ` · ${t.meta}` : ""}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
                  {t.flagged && <FlagPill />}
                  {t.kind === "expense" && <button type="button" style={{ padding: "3px 9px", fontSize: 12 }} onClick={() => setModal({ expense: t })}>Edit</button>}
                  {t.kind === "income" && t.can_edit && <button type="button" style={{ padding: "3px 9px", fontSize: 12 }} onClick={() => setModal({ income: t.income })}>Edit</button>}
                  {t.can_cancel && <button type="button" style={{ padding: "3px 9px", fontSize: 12 }} disabled={busy}
                    onClick={() => window.confirm("Take this back?") && act(`/cost/c-ledger/transfers/${t.id}`, null, "DELETE")}>Take back</button>}
                </div>
              </div>
              <div style={{ textAlign: "right", flex: "none" }}>
                <div style={{ fontWeight: 700, ...NUM, color: t.sign > 0 ? "var(--signal-green)" : t.status === "rejected" ? "var(--alert-red)" : "var(--charcoal)" }}>
                  {t.sign > 0 ? "+" : t.sign < 0 ? "−" : ""}{rs(t.amount)}
                </div>
                <Badge status={t.status} />
              </div>
            </div>
          ))}
        </div>
      </div>
      {(modal === "transfer" || modal === "bank") && <TransferForm me={me} kind={modal === "bank" ? "bank" : "holder"} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
      {(modal === "income" || modal?.income) && <IncomeForm me={me} rec={modal?.income || null} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
      {(modal === "expense" || modal?.expense) && <ExpenseForm me={me} rec={modal?.expense || null} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
    </div>
  );
}

function TransferForm({ me, kind, onClose, onSaved }) {
  const others = me.holders.filter((h) => h.id !== me.me);
  const [f, setF] = useState({ txn_date: today(), to_id: others[0]?.id || "", amount: "", note: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr("");
    try { await apiRequest("/cost/c-ledger/transfers", { method: "POST", body: { ...f, kind } }); onSaved(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={kind === "bank" ? "Deposit to bank" : "Send cash to another cash holder"} onClose={onClose} width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {kind === "holder" && (
          <label style={LBL}>To<select value={f.to_id} onChange={(e) => setF({ ...f, to_id: Number(e.target.value) })} style={INPUT}>
            {others.map((h) => <option key={h.id} value={h.id}>{h.short}</option>)}
          </select></label>
        )}
        <label style={LBL}>Date<input type="date" value={f.txn_date} max={today()} onChange={(e) => setF({ ...f, txn_date: e.target.value })} style={INPUT} /></label>
        <label style={LBL}>Amount (₹)<input type="number" inputMode="decimal" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={INPUT} /></label>
        <label style={LBL}>Note (optional)<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={kind === "bank" ? "Bank, branch or slip number" : ""} style={INPUT} /></label>
        {kind === "holder" && <div style={MUTED}>It leaves your cash now, and reaches theirs when they accept it.</div>}
        {err && <Note tone="bad">{err}</Note>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={BTN}>Cancel</button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy} style={BTN}>{kind === "bank" ? "Save deposit" : "Send"}</button>
        </div>
      </div>
    </Modal>
  );
}

function ExpenseForm({ me, rec, onClose, onSaved }) {
  const [f, setF] = useState(() => rec
    ? { txn_date: rec.date, amount: String(rec.amount), where_spent: rec.where_spent, category: rec.category, flagged: !!rec.flagged, party_id: rec.party_id ? String(rec.party_id) : "" }
    : { txn_date: today(), amount: "", where_spent: "", category: "", flagged: false, party_id: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const cats = me.categories.filter((c) => c.key !== "todo");
  // Round 235 — a payment to a supplier / transporter / contractor names who; it posts into their ledger.
  const partyKind = cats.find((c) => c.key === f.category)?.party || null;
  const [parties, setParties] = useState(null);
  useEffect(() => {
    if (!partyKind || parties) return;
    apiRequest("/cost/c-ledger/parties").then(setParties).catch(() => setParties({ supplier: [], transporter: [], contractor: [] }));
  }, [partyKind, parties]);
  async function save() {
    if (!f.category) { setErr("Pick the category."); return; }
    if (partyKind && !f.party_id && !rec) { setErr(`Choose the ${partyKind === "contractor" ? "contractor / gang" : partyKind} paid.`); return; }
    setBusy(true); setErr("");
    try { await apiRequest(rec ? `/cost/c-ledger/expenses/${rec.id}` : "/cost/c-ledger/expenses", { method: rec ? "PUT" : "POST", body: f }); onSaved(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  async function del() {
    if (!window.confirm("Delete this expense?")) return;
    setBusy(true);
    try { await apiRequest(`/cost/c-ledger/expenses/${rec.id}`, { method: "DELETE" }); onSaved(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={rec ? "Edit expense" : "New expense"} onClose={onClose} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
          <label style={LBL}>Date<input type="date" value={f.txn_date} max={today()} onChange={(e) => setF({ ...f, txn_date: e.target.value })} style={INPUT} /></label>
          <label style={LBL}>Amount (₹)<input type="number" inputMode="decimal" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={INPUT} /></label>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={LBL}>Category</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {cats.map((c) => (
              <button key={c.key} type="button" className={`btn-tab${f.category === c.key ? " active" : ""}`} onClick={() => setF({ ...f, category: c.key, party_id: c.party === partyKind ? f.party_id : "" })}
                style={{ padding: "8px 12px", minHeight: 40, borderRadius: 999, fontSize: 13 }}>{c.label}</button>
            ))}
          </div>
        </div>
        {partyKind && (
          <label style={LBL}>Paid to
            <select value={f.party_id} onChange={(e) => setF({ ...f, party_id: e.target.value })} style={INPUT}>
              <option value="">{parties ? "Choose…" : "Loading…"}</option>
              {(parties?.[partyKind] || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <span style={{ fontSize: 12, fontWeight: 400, color: "var(--slate)" }}>Goes into their ledger as a cash payment — no second entry there.</span>
          </label>
        )}
        <label style={LBL}>Where spent<input value={f.where_spent} onChange={(e) => setF({ ...f, where_spent: e.target.value })} placeholder="What it was for, and where" style={INPUT} /></label>
        <label style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 14, fontWeight: 600, background: "var(--amber-bg)", border: "1px solid #E7D8AE", borderRadius: 8, padding: "10px 12px" }}>
          <input type="checkbox" checked={f.flagged} onChange={(e) => setF({ ...f, flagged: e.target.checked })} style={{ width: 20, height: 20, margin: 0 }} />
          <span style={{ color: "#7A4F00", display: "inline-flex" }}><FlagIcon size={14} /></span>Flag this expense
        </label>
        {err && <Note tone="bad">{err}</Note>}
        <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>{rec && <button type="button" onClick={del} disabled={busy} style={BTN}>Delete</button>}</div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={onClose} style={BTN}>Cancel</button>
            <button type="button" className="btn-primary" onClick={save} disabled={busy} style={BTN}>{busy ? "Saving…" : "Save expense"}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Round 227 — other income: scrap sale, used oil sale … A cash holder records
// what they received; an Entry person may record it for a cash holder (who
// accepts it) or as received in the bank.
function IncomeForm({ me, rec, onClose, onSaved }) {
  const a = me.access;
  const [f, setF] = useState(() => rec
    ? { txn_date: rec.txn_date, amount: String(rec.amount), kind: rec.kind, source: rec.source, flagged: !!rec.flagged,
      received_by: rec.received_by == null ? "bank" : rec.received_by === me.me ? "me" : String(rec.received_by) }
    : { txn_date: today(), amount: "", kind: "scrap", source: "", flagged: false, received_by: a.cash_holder ? "me" : "bank" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const others = me.holders.filter((h) => h.id !== me.me);
  async function save() {
    setBusy(true); setErr("");
    try { await apiRequest(rec ? `/cost/c-ledger/incomes/${rec.id}` : "/cost/c-ledger/incomes", { method: rec ? "PUT" : "POST", body: f }); onSaved(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  async function del() {
    if (!window.confirm("Delete this income?")) return;
    setBusy(true);
    try { await apiRequest(`/cost/c-ledger/incomes/${rec.id}`, { method: "DELETE" }); onSaved(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={rec ? "Edit other income" : "Other income"} onClose={onClose} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {me.income_kinds.map((k) => (
            <button key={k.key} type="button" className={`btn-tab${f.kind === k.key ? " active" : ""}`} onClick={() => setF({ ...f, kind: k.key })}
              style={{ padding: "8px 12px", minHeight: 40, borderRadius: 999, fontSize: 13 }}>{k.label}</button>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
          <label style={LBL}>Date<input type="date" value={f.txn_date} max={today()} onChange={(e) => setF({ ...f, txn_date: e.target.value })} style={INPUT} /></label>
          <label style={LBL}>Amount (₹)<input type="number" inputMode="decimal" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={INPUT} /></label>
        </div>
        <label style={LBL}>What was sold, to whom<input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="e.g. 400 kg scrap steel to …" style={INPUT} /></label>
        <label style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 14, fontWeight: 600, background: "var(--amber-bg)", border: "1px solid #E7D8AE", borderRadius: 8, padding: "10px 12px" }}>
          <input type="checkbox" checked={f.flagged} onChange={(e) => setF({ ...f, flagged: e.target.checked })} style={{ width: 20, height: 20, margin: 0 }} />
          <span style={{ color: "#7A4F00", display: "inline-flex" }}><FlagIcon size={14} /></span>Flag this income
        </label>
        {err && <Note tone="bad">{err}</Note>}
        <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>{rec && <button type="button" onClick={del} disabled={busy} style={BTN}>Delete</button>}</div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={onClose} style={BTN}>Cancel</button>
            <button type="button" className="btn-primary" onClick={save} disabled={busy} style={BTN}>{busy ? "Saving…" : "Save income"}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ================================================ expenses & transactions ===
function TxnsView({ me, month }) {
  // Round 229: read only — expenses and income are changed only by the cash
  // holder who spent / received them (My wallet).
  const canEdit = false;
  const { data: d, error, reload } = useCostData(`/cost/c-ledger/transactions?month=${month}`);
  const [filter, setFilter] = useState("all");
  const [who, setWho] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [incomeForm, setIncomeForm] = useState(null);
  if (!d) return <Loading error={error} />;
  const s = d.summary;
  const exp = d.expenses.filter((x) => (filter === "all" || (filter === "flagged" ? x.flagged : filter === "todo" ? x.category === "todo" : !x.flagged)) && (!who || String(x.holder_id) === who));

  async function change(x, body) {
    setBusy(true); setErr("");
    try { await apiRequest(`/cost/c-ledger/expenses/${x.id}`, { method: "PUT", body }); reload(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  function excel() {
    const cat = (k) => me.categories.find((c) => c.key === k)?.label || k;
    const sheets = [{ name: "Expenses", rows: [["Date", "Paid by", "Where spent", "Category", "Paid", "Flagged"],
      ...d.expenses.map((x) => [x.txn_date, x.holder, x.where_spent, cat(x.category), x.amount, x.flagged ? "Yes" : ""])] }];
    sheets.push({ name: "Other income", rows: [["Date", "Kind", "What, to whom", "Received by", "Amount", "Status", "Flagged"],
      ...d.incomes.map((i) => [i.txn_date, i.kind_label, i.source, i.received_name, i.amount, i.received_by == null ? "in bank" : i.status, i.flagged ? "Yes" : ""])] });
    if (d.full) sheets.push({ name: "Transfers", rows: [["Date", "From", "To", "Amount", "Status", "Note"],
      ...d.transfers.map((t) => [t.txn_date, t.from_name, t.kind === "bank" ? "Bank" : t.to_name, t.amount, t.kind === "bank" ? "deposited" : t.status, t.note || ""])] });
    downloadExcel(`C-Ledger-transactions-${month}.xlsx`, sheets);
  }

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
        <div><h2 style={{ ...H2, fontSize: 18 }}>{d.full ? "Expenses & transactions" : "Expenses"} — {d.label}</h2>
          <div style={SUB}>Each expense goes into the cost head of its category.</div></div>
        <Actions>
          {canEdit && <button type="button" style={BTN} onClick={() => setIncomeForm({})}>+ Other income</button>}
          <button type="button" style={BTN} onClick={excel}>Export Excel</button>
        </Actions>
      </div>
      <div style={GRID(190)}>
        <Tile label="Spent" value={rs(s.paid)} note={`${d.expenses.length} expenses`} />
        <Tile label="To the cost heads" value={rs(s.cost)} note="not-a-cost items left out" />
        <Tile label="Other income" value={rs(s.income)} note={`${d.incomes.length} entr${d.incomes.length === 1 ? "y" : "ies"} · into Other income`} />
        {d.full && <Tile label="Cash with cash holders" value={rs(s.cash_in_hand)} note={`${rs(s.deposited)} deposited this month`} />}
        <Tile label="Flagged" value={num(s.flagged)} note={s.todo ? `${s.todo} to categorise` : null} dark />
      </div>
      {err && <Note tone="bad">{err}</Note>}

      {d.full && (
        <div style={GRID(220)}>
          {d.balances.map((b) => (
            <div key={b.id} style={panel("1 1 auto")}>
              <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 15 }}><span>{b.short}</span><span style={{ ...NUM, color: b.balance < 0 ? "var(--alert-red)" : "var(--signal-green)" }}>{rs(b.balance)}</span></div>
              <div style={{ ...MUTED, marginTop: 4, lineHeight: 1.5 }}>Accepted {rs(b.collected)} · in {rs(b.transfer_in)} · out {rs(b.transfer_out)} · bank {rs(b.deposited)} · expenses {rs(b.expenses)}</div>
              {b.awaiting > 0 && <div style={{ fontSize: 12, color: "#1F4A82", marginTop: 3 }}>+ {rs(b.awaiting)} awaiting acceptance</div>}
            </div>
          ))}
        </div>
      )}

      <div style={ROW}>
        <div style={panel("999 1 640px")}>
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
            <h2 style={H2}>Expenses</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Paid by" style={{ ...INPUT, width: "auto", minHeight: 36, fontSize: 12.5 }}>
                <option value="">Everyone</option>{me.holders.map((h) => <option key={h.id} value={h.id}>{h.short}</option>)}
              </select>
              <Pills value={filter} onChange={setFilter} options={[["all", "All"], ["flagged", "Flagged"], ["unflagged", "Not flagged"], ["todo", "To categorise"]]} />
            </div>
          </div>
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table>
              <thead><tr><th>Date</th><th>Paid by</th><th>Where spent</th><th>Category</th><th style={R}>Paid</th><th>Flag</th></tr></thead>
              <tbody>
                {exp.map((x) => (
                  <tr key={x.id} style={{ background: x.flagged ? "#FFFBF2" : undefined }}>
                    <td style={{ whiteSpace: "nowrap", ...NUM }}>{fmtDay(x.txn_date)}</td>
                    <td style={{ fontWeight: 600 }}>{x.holder}</td>
                    <td style={{ minWidth: 200 }}>{x.where_spent}</td>
                    <td>{canEdit ? (
                      <select value={x.category} disabled={busy} aria-label="Category" onChange={(e) => change(x, { category: e.target.value })}
                        style={{ ...INPUT, minHeight: 34, fontSize: 12.5, padding: "5px 8px", width: "auto", maxWidth: 230, background: x.category === "todo" ? "var(--amber-bg)" : "var(--surface)" }}>
                        {me.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                      </select>
                    ) : (me.categories.find((c) => c.key === x.category)?.label || x.category)}</td>
                    <td style={{ ...R, fontWeight: 600 }}>{rs(x.amount)}</td>
                    <td>{canEdit ? <FlagButton on={x.flagged} disabled={busy} onClick={() => change(x, { flagged: !x.flagged })} label={`${x.flagged ? "Remove flag on" : "Flag"} ${x.where_spent}`} /> : x.flagged ? <FlagPill /> : null}</td>
                  </tr>
                ))}
                {exp.length === 0 && <tr><td colSpan={6} style={{ ...MUTED, padding: 16 }}>No expenses{filter !== "all" || who ? " match" : " this month"}.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div style={panel("1 1 300px")}>
          <h2 style={H2}>By category</h2>
          <div style={SUB}>Added straight into each cost head</div>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Category</th><th style={R}>Paid</th><th style={R}>To cost</th></tr></thead>
            <tbody>
              {d.by_category.map((c) => <tr key={c.key}><td>{c.label}<div style={MUTED}>{c.n} expense{c.n > 1 ? "s" : ""}</div></td><td style={R}>{rs(c.paid)}</td><td style={{ ...R, fontWeight: 600 }}>{c.cost ? rs(c.cost) : "—"}</td></tr>)}
              {d.by_category.length === 0 && <tr><td colSpan={3} style={MUTED}>—</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div style={panel("1 1 100%")}>
        <h2 style={H2}>Other income</h2>
        <div style={SUB}>Scrap, used oil and other sales — goes into Other income</div>
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table>
            <thead><tr><th>Date</th><th>Kind</th><th>What, to whom</th><th>Received by</th><th style={R}>Amount</th><th>Status</th><th>Flag</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {d.incomes.map((i) => (
                <tr key={i.id} style={{ background: i.flagged ? "#FFFBF2" : undefined }}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDay(i.txn_date)}</td><td>{i.kind_label}</td><td style={{ minWidth: 180 }}>{i.source}</td>
                  <td>{i.received_name}</td><td style={{ ...R, fontWeight: 600 }}>{rs(i.amount)}</td>
                  <td>{i.received_by == null ? <span style={MUTED}>in bank</span> : <Badge status={i.status} />}</td>
                  <td>{i.flagged ? <FlagPill /> : null}</td>
                  {canEdit && <td><button type="button" style={{ padding: "6px 10px", minHeight: 36, fontSize: 12 }} onClick={() => setIncomeForm(i)}>Edit</button></td>}
                </tr>
              ))}
              {d.incomes.length === 0 && <tr><td colSpan={8} style={{ ...MUTED, padding: 16 }}>None this month.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {incomeForm && <IncomeForm me={me} rec={incomeForm.id ? incomeForm : null} onClose={() => setIncomeForm(null)} onSaved={() => { setIncomeForm(null); reload(); }} />}

      {d.full && (
        <div style={panel("1 1 100%")}>
          <h2 style={H2}>Transfers &amp; bank deposits</h2>
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table>
              <thead><tr><th>Date</th><th>From</th><th>To</th><th style={R}>Amount</th><th>Status</th><th>Note</th></tr></thead>
              <tbody>
                {d.transfers.map((t) => (
                  <tr key={t.id}><td style={{ whiteSpace: "nowrap" }}>{fmtDay(t.txn_date)}</td><td>{t.from_name}</td><td>{t.kind === "bank" ? "Bank" : t.to_name}</td>
                    <td style={{ ...R, fontWeight: 600 }}>{rs(t.amount)}</td><td>{t.kind === "bank" ? <span style={MUTED}>deposited</span> : <Badge status={t.status} />}</td><td style={MUTED}>{t.note}</td></tr>
                ))}
                {d.transfers.length === 0 && <tr><td colSpan={6} style={{ ...MUTED, padding: 16 }}>None this month.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
