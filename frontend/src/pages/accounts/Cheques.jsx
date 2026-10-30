// Round 253 — Accounts → Cheques (owner, 30 Oct 2026; mock-up "Cheques &
// Petty Cash", artboards 1 and 3). Cheques received from customers and issued
// by us, from receipt to clearing; cheque books leaf by leaf. A cheque does
// not post money itself — its credit / debit is posted from Cost → Bank
// statements, and the register clears itself from those lines. Owner's
// extra: "Returned · paid another way" for a PDC the customer took back and
// paid by bank transfer or cash instead.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { todayStr } from "../../lib/istDate.js";
import { inr2, fmtDate } from "../../lib/quotationTerms.js";
import { TH, TD, NUM, row, money, Banner, Field, Modal, Empty, Table, readPhotoSmall, PhotoModal } from "./ui.jsx";

const STATUS = {
  in_hand: ["In hand", "badge-neutral"], deposited: ["Deposited · clearing", "badge-warning"], cleared: ["Cleared", "badge-success"],
  bounced: ["Bounced", "badge-danger"], returned: ["Returned · paid another way", "badge-info"], cancelled: ["Cancelled", "badge-neutral"],
  issued: ["Issued", "badge-warning"], stopped: ["Payment stopped", "badge-danger"],
};
const VIEWS = [["received", "Received"], ["issued", "Issued"], ["bounced", "Bounced"], ["returned", "Returned"], ["closed", "Cancelled / void"], ["books", "Cheque books"]];
const sub = { fontSize: 11.5, color: "var(--slate)" };
const dayLabel = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

export default function Cheques({ params, go }) {
  const { can } = usePermissions();
  const canCreate = can("accounts.cheques", "create");
  const canEdit = can("accounts.cheques", "edit");
  const [d, setD] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [q, setQ] = useState("");
  const [modal, setModal] = useState(null);   // { kind, cheque? }
  const view = params.get("view") || "received";
  const load = () => apiRequest("/accounts/cheques").then(setD).catch((e) => setError(e.message));
  const loadMeta = () => apiRequest("/accounts/cheques/meta").then(setMeta).catch(() => {});
  useEffect(() => { load(); loadMeta(); }, []);
  const done = (text) => { setModal(null); setMsg(text); setError(""); load(); loadMeta(); };

  const rows = useMemo(() => {
    if (!d) return [];
    const s = q.trim().toLowerCase();
    return d.list.filter((c) => {
      const ok = view === "received" ? c.direction === "received" && !["bounced", "returned", "cancelled"].includes(c.status)
        : view === "issued" ? c.direction === "issued" && !["cancelled", "stopped"].includes(c.status)
        : view === "bounced" ? c.status === "bounced"
        : view === "returned" ? c.status === "returned"
        : view === "closed" ? ["cancelled", "stopped"].includes(c.status) : false;
      if (!ok) return false;
      if (!s) return true;
      return [c.cheque_no, c.customer_name, c.payee_name, c.drawn_on, String(c.amount)].some((x) => String(x || "").toLowerCase().includes(s));
    }).sort((a, b) => {
      // What needs doing first: in hand by date, then the rest newest first.
      const pa = a.status === "in_hand" || a.status === "issued" ? 0 : 1, pb = b.status === "in_hand" || b.status === "issued" ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return pa === 0 ? (a.cheque_date < b.cheque_date ? -1 : 1) : (a.cheque_date < b.cheque_date ? 1 : -1);
    });
  }, [d, view, q]);

  if (!d) return <><Banner>{error}</Banner>{!error && <Empty>Loading…</Empty>}</>;
  const t = d.tiles;
  const counts = {
    received: d.list.filter((c) => c.direction === "received" && ["in_hand", "deposited"].includes(c.status)).length,
    issued: d.list.filter((c) => c.status === "issued").length, bounced: t.bounced.n,
    returned: d.list.filter((c) => c.status === "returned" && c.replaced < c.amount - 0.5).length,
  };

  return (
    <>
      <Banner>{error}</Banner>
      <Banner kind="ok">{msg}</Banner>
      {d.matched?.cleared > 0 && <Banner kind="ok">{d.matched.cleared} cheque{d.matched.cleared > 1 ? "s" : ""} marked cleared from the bank statements just now.</Banner>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 14 }}>
        <Tile label="Received · in hand (PDC)" value={money(t.in_hand.amount)} sub={`${t.in_hand.n} cheque${t.in_hand.n === 1 ? "" : "s"}${t.in_hand.next_due ? ` · next due ${fmtDate(t.in_hand.next_due)}` : ""}`} />
        <Tile label="Deposited · awaiting clearing" value={money(t.deposited.amount)} sub={`${t.deposited.n} in clearing`} />
        <Tile label="Issued · not yet presented" value={money(t.issued.amount)} sub="Keep this much in the bank" />
        <Tile label="Bounced · to recover" value={money(t.bounced.amount)} sub={`${t.bounced.n} cheque${t.bounced.n === 1 ? "" : "s"}`} tone={t.bounced.n ? "red" : null} />
      </div>

      <div className="card" style={{ marginBottom: 14, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          <b style={{ fontSize: 14 }}>Next 7 days</b>
          <span style={sub}>Deposit received PDCs on their date · keep money in the bank for cheques we issued</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
          {d.week.map((w, i) => (
            <div key={w.date} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", fontSize: 12.5 }}>
              <div style={{ fontWeight: 600 }}>{i === 0 ? "Today" : dayLabel(w.date)}</div>
              {w.deposit.n > 0 && <div style={{ color: "var(--signal-green)" }}>↓ {w.deposit.n} to deposit{i === 0 ? " (incl. overdue)" : ""} · {money(w.deposit.amount)}</div>}
              {w.issued.n > 0 && <div style={{ color: "var(--amber)" }}>↑ {w.issued.n} issued · {money(w.issued.amount)}</div>}
              {!w.deposit.n && !w.issued.n && <div style={sub}>Nothing due</div>}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {VIEWS.map(([k, label]) => (
          <button key={k} type="button" className={`btn-tab ${view === k ? "active" : ""}`} onClick={() => go("cheques", { view: k })}>
            {label}{counts[k] ? ` · ${counts[k]}` : ""}
          </button>
        ))}
        {canCreate && <button type="button" className="btn-primary" style={{ marginLeft: "auto" }} onClick={() => setModal({ kind: "new" })}>+ Record cheque</button>}
      </div>

      {view === "books" ? <Books books={d.books} meta={meta} canEdit={canEdit} canCreate={canCreate} onDone={done} setError={setError} /> : (
        <>
          <div style={{ marginBottom: 10 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search party, cheque no., bank, amount" aria-label="Search cheques"
              style={{ width: "100%", maxWidth: 360, minHeight: 40, padding: "0 10px", border: "1px solid var(--border-strong)", borderRadius: 8 }} />
          </div>
          {!rows.length ? <Empty>No cheques here.</Empty> : (
            <Table minWidth={860} head={<>
              <th style={TH}>Cheque date</th><th style={TH}>Cheque no.</th><th style={TH}>{view === "issued" ? "Pay to" : "Party"}</th>
              <th style={TH}>{view === "issued" ? "Drawn on (ours)" : "Drawn on"}</th>
              <th style={{ ...TH, textAlign: "right" }}>Amount</th><th style={TH}>Status</th><th style={TH}>Next action</th>
            </>}>
              {rows.map((c) => (
                <tr key={c.id} style={row}>
                  <td style={TD}>{fmtDate(c.cheque_date)}{c.direction === "received" && c.status === "in_hand" && c.cheque_date > d.today && <div style={sub}>post-dated</div>}</td>
                  <td style={TD}><button type="button" className="btn-link" onClick={() => setModal({ kind: "view", cheque: c })} style={{ fontVariantNumeric: "tabular-nums", padding: 0, border: "none", background: "none", color: "var(--info)", textDecoration: "underline" }}>{c.cheque_no}</button></td>
                  <td style={TD}>{c.direction === "received" ? c.customer_name : c.payee_name || "—"}{c.purpose && <div style={sub}>{c.purpose}</div>}</td>
                  <td style={TD}>{c.direction === "received" ? c.drawn_on : c.our_account}{c.direction === "received" && c.deposit_account && <div style={sub}>into {c.deposit_account}</div>}</td>
                  <td style={NUM}>{c.amount == null ? "—" : `₹${inr2(c.amount)}`}{c.status === "returned" && <div style={sub}>paid ₹{inr2(c.replaced)}</div>}</td>
                  <td style={TD}><Badge s={c.status} />{c.status === "bounced" && <div style={sub}>{c.bounce_reason}{c.notice_on ? ` · notice ${fmtDate(c.notice_on)}` : ""}</div>}</td>
                  <td style={TD}><NextAction c={c} today={d.today} canEdit={canEdit} open={(kind) => setModal({ kind, cheque: c })} /></td>
                </tr>
              ))}
            </Table>
          )}
          <div style={{ ...sub, marginTop: 8 }}>
            A cheque clears itself when an uploaded bank statement shows its number and amount. Its money reaches the customer's or supplier's ledger
            when that bank line is posted (Cost → Bank statements). A bounce cancels the receipt the cheque had posted, so the dues are open again.
          </div>
        </>
      )}

      {modal?.kind === "new" && meta && <NewCheque meta={meta} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "view" && <ChequeDetail id={modal.cheque.id} canEdit={canEdit} onClose={() => setModal(null)} onDone={done} />}
      {modal && !["new", "view"].includes(modal.kind) && (
        <StepModal kind={modal.kind} c={modal.cheque} meta={meta} today={d.today} onClose={() => setModal(null)} onDone={done} />
      )}
    </>
  );
}

function Tile({ label, value, sub: s, tone }) {
  const red = tone === "red";
  return (
    <div className="card" style={{ padding: 14, ...(red ? { background: "var(--alert-red-bg)", borderColor: "var(--alert-red)" } : {}) }}>
      <div style={{ fontSize: 12.5, color: red ? "var(--alert-red)" : "var(--slate)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: red ? "var(--alert-red)" : undefined, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 12, color: red ? "var(--alert-red)" : "var(--slate)", marginTop: 2 }}>{s}</div>
    </div>
  );
}
function Badge({ s }) {
  const [label, cls] = STATUS[s] || [s, "badge-neutral"];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function NextAction({ c, today, canEdit, open }) {
  if (!canEdit) return <span style={sub}>—</span>;
  const B = (kind, label, primary) => <button key={kind} type="button" className={primary ? "btn-primary" : ""} style={{ fontSize: 12.5, padding: "5px 10px" }} onClick={() => open(kind)}>{label}</button>;
  const wrap = (...b) => <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{b}</div>;
  if (c.status === "in_hand") {
    return c.cheque_date <= today ? wrap(B("deposit", "Deposit", true), B("return", "Returned · paid another way"))
      : wrap(<span key="d" style={sub}>Due in {Math.round((new Date(c.cheque_date) - new Date(today)) / 86400000)} days</span>, B("return", "Returned · paid another way"));
  }
  if (c.status === "deposited") return wrap(B("clear", "Mark cleared"), B("bounce", "Bounced"));
  if (c.status === "cleared" && c.direction === "received") return <span style={sub}>{c.bank_line_id ? "Matched to the bank statement" : `Cleared ${fmtDate(c.cleared_on)}`}</span>;
  if (c.status === "bounced") return wrap(B("represent", "Present again"), B("return", "Returned · paid another way"), !c.notice_on && B("notice", "Notice sent"));
  if (c.status === "returned") return c.replaced < c.amount - 0.5 ? wrap(B("view", `₹${inr2(c.amount - c.replaced)} still to come`)) : <span style={sub}>Paid in full another way</span>;
  if (c.status === "issued") return wrap(B("clear", "Mark cleared"), B("stop", "Stop payment"));
  if (c.status === "cleared") return <span style={sub}>{c.bank_line_id ? "Matched to the bank statement" : `Cleared ${fmtDate(c.cleared_on)}`}</span>;
  return <span style={sub}>{c.cancel_reason || "—"}</span>;
}

// ---------------------------------------------------------- record new ---
function NewCheque({ meta, onClose, onDone }) {
  const [f, setF] = useState({ direction: "received", customer_id: "", cheque_no: "", cheque_date: todayStr(), amount: "", drawn_on: "", deposit_account_id: meta.accounts.find((a) => a.is_active)?.id || "",
    received_on: todayStr(), account_id: meta.books.find((b) => b.is_active)?.account_id || meta.accounts[0]?.id || "", payee_kind: "supplier", payee_id: "", payee_name: "", purpose: "", remarks: "", photo: null });
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const book = meta.books.find((b) => b.is_active && b.account_id === Number(f.account_id) && b.next);
  useEffect(() => {
    setInfo(null);
    if (f.direction === "received" && f.customer_id) apiRequest(`/accounts/cheques/customer/${f.customer_id}`).then(setInfo).catch(() => {});
  }, [f.customer_id, f.direction]);
  useEffect(() => { if (f.direction === "issued" && book && !f.cheque_no) setF((x) => ({ ...x, cheque_no: book.next })); }, [f.direction, f.account_id]);
  const stale = f.cheque_date && (new Date(todayStr()) - new Date(f.cheque_date)) / 86400000 > 90;
  async function photo(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try { setF({ ...f, photo: await readPhotoSmall(file) }); } catch (err) { setError(err.message); }
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await apiRequest("/accounts/cheques", { method: "POST", body: { ...f, amount: Number(f.amount) } });
      onDone(`Cheque ${r.cheque_no} recorded.`);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  const parties = { supplier: meta.suppliers, transporter: meta.transporters, contractor: meta.contractors }[f.payee_kind];
  return (
    <Modal title="Record a cheque" onClose={onClose} width={620}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, background: "var(--concrete)", borderRadius: 10, padding: 4, marginBottom: 12 }}>
          {[["received", "↓ Received from customer"], ["issued", "↑ Issued by us"]].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setF({ ...f, direction: k, cheque_no: "" })}
              style={{ minHeight: 42, border: "none", borderRadius: 8, fontWeight: f.direction === k ? 700 : 500, background: f.direction === k ? "var(--surface)" : "transparent" }}>{l}</button>
          ))}
        </div>
        {f.direction === "received" ? (
          <>
            <Field label="Customer">
              <select required value={f.customer_id} onChange={set("customer_id")}>
                <option value="">Choose…</option>{meta.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            {info && (
              <div style={{ fontSize: 12.5, marginBottom: 10, padding: "8px 10px", borderRadius: 8, background: info.bounces.length ? "var(--amber-bg)" : "var(--concrete)" }}>
                Balance due {money(info.balance)}{info.advance > 0 ? ` · advance ${money(info.advance)}` : ""}
                {info.bounces.length > 0 && <div style={{ color: "var(--amber)", fontWeight: 600 }}>⚠ {info.bounces.length} cheque{info.bounces.length > 1 ? "s" : ""} bounced in the last 6 months (last {fmtDate(info.bounces[0].bounced_on)} — {info.bounces[0].bounce_reason})</div>}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
              <Field label="Amount ₹"><input type="number" min="1" step="0.01" required value={f.amount} onChange={set("amount")} /></Field>
              <Field label="Cheque number"><input required inputMode="numeric" value={f.cheque_no} onChange={set("cheque_no")} placeholder="6 digits" /></Field>
              <Field label="Date on the cheque" hint={f.cheque_date > todayStr() ? "Post-dated — deposit on this date" : stale ? "⚠ Over 3 months old — the bank may refuse it as stale" : null}>
                <input type="date" required value={f.cheque_date} onChange={set("cheque_date")} />
              </Field>
              <Field label="Received on"><input type="date" required max={todayStr()} value={f.received_on} onChange={set("received_on")} /></Field>
              <Field label="Drawn on (their bank, branch)"><input required value={f.drawn_on} onChange={set("drawn_on")} placeholder="Bank, branch" /></Field>
              <Field label="Deposit into">
                <select value={f.deposit_account_id} onChange={set("deposit_account_id")}>
                  <option value="">Decide later</option>{meta.accounts.filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Against" hint="Receipts are set against the oldest dues when the bank statement is posted; anything over stays as an advance.">
              <input value={f.purpose} onChange={set("purpose")} placeholder="e.g. October deliveries, advance for an order" />
            </Field>
          </>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
              <Field label="Our account">
                <select required value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value, cheque_no: "" })}>
                  <option value="">Choose…</option>{meta.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>
              <Field label="Leaf number" hint={book ? `Next unused leaf: ${book.next} (${book.left} left)` : "No cheque book entered for this account"}>
                <input required inputMode="numeric" value={f.cheque_no} onChange={set("cheque_no")} />
              </Field>
              <Field label="Amount ₹"><input type="number" min="1" step="0.01" required value={f.amount} onChange={set("amount")} /></Field>
              <Field label="Cheque date"><input type="date" required value={f.cheque_date} onChange={set("cheque_date")} /></Field>
              <Field label="Pay to">
                <select value={f.payee_kind} onChange={(e) => setF({ ...f, payee_kind: e.target.value, payee_id: "" })}>
                  <option value="supplier">Raw material supplier</option><option value="transporter">Transporter</option>
                  <option value="contractor">Contractor / pump gang</option><option value="self">Self (cash)</option><option value="other">Other</option>
                </select>
              </Field>
              {parties ? (
                <Field label="Who">
                  <select required value={f.payee_id} onChange={set("payee_id")}><option value="">Choose…</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                </Field>
              ) : f.payee_kind === "other" && <Field label="Name on the cheque"><input required value={f.payee_name} onChange={set("payee_name")} /></Field>}
            </div>
            <Field label="For" hint="The payment reaches the party's ledger, or its cost head, when the bank statement line is posted.">
              <input value={f.purpose} onChange={set("purpose")} placeholder="e.g. bills of September, power bill" />
            </Field>
          </>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "inline-flex", alignItems: "center", minHeight: 44, padding: "0 14px", border: "1px dashed var(--border-strong)", borderRadius: 8, fontSize: 13.5, cursor: "pointer" }}>
            {f.photo ? "Photo attached ✓ — change" : "Attach cheque photo"}
            <input type="file" accept="image/*" capture="environment" onChange={photo} style={{ display: "none" }} />
          </label>
          <Field label="Remarks" style={{ flex: "1 1 220px", marginBottom: 0 }}><input value={f.remarks} onChange={set("remarks")} /></Field>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save cheque"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------- one step modal ---
function StepModal({ kind, c, meta, today, onClose, onDone }) {
  const [f, setF] = useState({ date: today, account_id: c.deposit_account_id || "", slip_no: "", reason: "", charges: "", note: "" });
  const [pays, setPays] = useState([{ mode: "bank_transfer", amount: c.amount ? String(c.amount) : "", paid_on: today, reference: "", posting: "later", receipt_id: "" }]);
  const [linkable, setLinkable] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  useEffect(() => { if (kind === "return") apiRequest(`/accounts/cheques/${c.id}`).then((x) => setLinkable(x.linkable || [])).catch(() => {}); }, [kind, c.id]);
  const T = {
    deposit: "Deposit cheque", clear: "Mark cleared", bounce: "Cheque bounced", represent: "Present again", notice: "Legal notice sent",
    return: "Returned · paid another way", cancel: "Cancel cheque", stop: "Stop payment",
  };
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError("");
    const body = {
      deposit: { deposited_on: f.date, account_id: f.account_id, slip_no: f.slip_no },
      clear: { cleared_on: f.date },
      bounce: { bounced_on: f.date, reason: f.reason, charges: f.charges },
      represent: { deposited_on: f.date, slip_no: f.slip_no },
      notice: { notice_on: f.date },
      return: { returned_on: f.date, note: f.note, payments: pays.filter((p) => Number(p.amount) > 0).map((p) => ({ ...p, amount: Number(p.amount) })) },
      cancel: { reason: f.reason }, stop: { reason: f.reason },
    }[kind];
    try {
      const r = await apiRequest(`/accounts/cheques/${c.id}/${kind}`, { method: "POST", body });
      onDone(kind === "bounce" ? `Cheque ${c.cheque_no} marked bounced${r.receipt_cancelled ? " — the receipt it posted is cancelled and the dues are open again" : ""}.`
        : kind === "return" ? `Cheque ${c.cheque_no} returned to the customer${r.replaced ? `; ₹${inr2(r.replaced)} paid another way recorded` : ""}.`
        : `Cheque ${c.cheque_no}: ${T[kind].toLowerCase()} — saved.`);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  const dateLabel = { deposit: "Deposited on", clear: "Cleared on", bounce: "Returned by the bank on", represent: "Presented again on", notice: "Notice sent on", return: "Given back to the customer on" }[kind];
  const total = pays.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  return (
    <Modal title={`${T[kind]} — ${c.cheque_no}`} onClose={onClose} width={kind === "return" ? 640 : 460}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 10 }}>
          {c.direction === "received" ? c.customer_name : c.payee_name} · ₹{inr2(c.amount)} · dated {fmtDate(c.cheque_date)}
        </div>
        {dateLabel && <Field label={dateLabel}><input type="date" required max={today} value={f.date} onChange={set("date")} /></Field>}
        {kind === "deposit" && (
          <>
            <Field label="Into account">
              <select required value={f.account_id} onChange={set("account_id")}>
                <option value="">Choose…</option>{(meta?.accounts || []).filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </Field>
            <Field label="Pay-in slip no. (optional)"><input value={f.slip_no} onChange={set("slip_no")} /></Field>
          </>
        )}
        {kind === "represent" && <Field label="Pay-in slip no. (optional)"><input value={f.slip_no} onChange={set("slip_no")} /></Field>}
        {kind === "bounce" && (
          <>
            <Field label="Reason the bank gave"><input required value={f.reason} onChange={set("reason")} placeholder="Funds insufficient, signature differs …" /></Field>
            <Field label="Bank charges ₹ (optional)" hint="The charge itself comes in from the bank statement as Bank charges."><input type="number" min="0" step="0.01" value={f.charges} onChange={set("charges")} /></Field>
            {c.receipt_id && <div style={{ fontSize: 12.5, color: "var(--amber)", marginBottom: 10 }}>The receipt this cheque posted will be cancelled, so the customer's dues are open again.</div>}
          </>
        )}
        {(kind === "cancel" || kind === "stop") && (
          <Field label="Reason"><input required value={f.reason} onChange={set("reason")} placeholder={kind === "stop" ? "Lost in transit, wrong amount …" : "Entered by mistake …"} /></Field>
        )}
        {kind === "return" && (
          <>
            <Field label="Note"><input value={f.note} onChange={set("note")} placeholder="e.g. customer paid by NEFT and took the PDC back" /></Field>
            <div style={{ fontSize: 13, fontWeight: 600, margin: "4px 0 6px" }}>Paid instead</div>
            {pays.map((p, i) => (
              <ReplacementLine key={i} p={p} linkable={linkable} today={today}
                onChange={(np) => setPays(pays.map((x, j) => (j === i ? np : x)))} onRemove={pays.length > 1 ? () => setPays(pays.filter((_, j) => j !== i)) : null} />
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5, marginBottom: 10 }}>
              <button type="button" onClick={() => setPays([...pays, { mode: "cash", amount: c.amount - total > 0 ? String(c.amount - total) : "", paid_on: today, reference: "", posting: "new", receipt_id: "" }])}>+ Another payment</button>
              <span>Paid ₹{inr2(total)} of ₹{inr2(c.amount)}{total < c.amount - 0.5 ? ` · ₹${inr2(c.amount - total)} still to come (add it later)` : ""}</span>
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>Close</button>
          <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}

// One payment that replaced a returned cheque.
function ReplacementLine({ p, linkable, today, onChange, onRemove }) {
  const set = (k) => (e) => {
    const np = { ...p, [k]: e.target.value };
    if (k === "mode") np.posting = e.target.value === "cash" ? "new" : "later";
    onChange(np);
  };
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginBottom: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
        <Field label="How" style={{ marginBottom: 4 }}>
          <select value={p.mode} onChange={set("mode")}><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option></select>
        </Field>
        <Field label="Amount ₹" style={{ marginBottom: 4 }}><input type="number" min="1" step="0.01" required value={p.amount} onChange={set("amount")} /></Field>
        <Field label="Paid on" style={{ marginBottom: 4 }}><input type="date" max={today} value={p.paid_on} onChange={set("paid_on")} /></Field>
        <Field label={p.mode === "cash" ? "Reference (optional)" : "UTR / reference"} style={{ marginBottom: 4 }}><input value={p.reference} onChange={set("reference")} /></Field>
      </div>
      <Field label="Customer ledger" style={{ marginBottom: 4 }}>
        <select value={p.posting} onChange={set("posting")}>
          {p.mode === "cash" ? <option value="new">Record the cash receipt now</option> : <option value="later">Link when the bank statement credit is posted</option>}
          <option value="link">Link a receipt already entered</option>
          {p.mode === "cash" && <option value="none">Not here — the cash was taken in C Ledger</option>}
        </select>
      </Field>
      {p.posting === "link" && (
        <Field label="Receipt" style={{ marginBottom: 4 }}>
          <select required value={p.receipt_id} onChange={set("receipt_id")}>
            <option value="">{linkable.length ? "Choose…" : "No unlinked receipts for this customer"}</option>
            {linkable.map((r) => <option key={r.id} value={r.id}>{fmtDate(r.receipt_date)} · ₹{inr2(r.amount)} · {r.mode}{r.reference_number ? ` · ${r.reference_number}` : ""}</option>)}
          </select>
        </Field>
      )}
      {onRemove && <button type="button" onClick={onRemove} style={{ fontSize: 12, padding: "3px 10px" }}>Remove</button>}
    </div>
  );
}

// ---------------------------------------------------------- one cheque ---
function ChequeDetail({ id, canEdit, onClose, onDone }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState("");
  const [add, setAdd] = useState(null);
  const [photo, setPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => apiRequest(`/accounts/cheques/${id}`).then(setC).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);
  async function addPayment() {
    setBusy(true); setError("");
    try { await apiRequest(`/accounts/cheques/${id}/replacements`, { method: "POST", body: { ...add, amount: Number(add.amount) } }); setAdd(null); await load(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function remove(r) {
    if (!window.confirm(`Remove this ₹${inr2(r.amount)} ${r.mode === "cash" ? "cash" : "bank"} payment?${r.posting === "new" ? " The cash receipt recorded with it is cancelled." : ""}`)) return;
    setBusy(true); setError("");
    try { await apiRequest(`/accounts/cheques/${id}/replacements/${r.id}/remove`, { method: "POST" }); await load(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function cancel() {
    const reason = window.prompt(c.direction === "issued" ? "Cancel this cheque (leaf void)? Give the reason." : "Cancel this cheque (entered by mistake)? Give the reason.", "");
    if (!reason) return;
    try { await apiRequest(`/accounts/cheques/${id}/cancel`, { method: "POST", body: { reason } }); onDone(`Cheque ${c.cheque_no} cancelled.`); }
    catch (e) { setError(e.message); }
  }
  if (!c) return <Modal title="Cheque" onClose={onClose}><Banner>{error}</Banner>{!error && "Loading…"}</Modal>;
  const left = c.status === "returned" ? Math.max(0, c.amount - c.replaced) : 0;
  return (
    <Modal title={`Cheque ${c.cheque_no}`} onClose={onClose} width={620}>
      <Banner>{error}</Banner>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700 }}>{c.direction === "received" ? c.customer_name : c.payee_name || "Leaf void"} {c.amount != null && `· ₹${inr2(c.amount)}`}</div>
          <div style={sub}>
            {c.direction === "received" ? `Drawn on ${c.drawn_on}${c.deposit_account ? ` · into ${c.deposit_account}` : ""}` : `From ${c.our_account}`} · dated {fmtDate(c.cheque_date)}
            {c.purpose && ` · ${c.purpose}`}
          </div>
        </div>
        <Badge s={c.status} />
      </div>
      {c.bank_line && <div style={{ fontSize: 12.5, marginBottom: 8 }}>Bank statement: {fmtDate(c.bank_line.txn_date)} · {c.bank_line.account} — <span style={sub}>{String(c.bank_line.narration || "").slice(0, 90)}</span></div>}
      {c.receipt && <div style={{ fontSize: 12.5, marginBottom: 8 }}>Customer receipt of {fmtDate(c.receipt.receipt_date)}, ₹{inr2(c.receipt.amount)}{c.receipt.cancelled ? " — cancelled (bounce)" : ""}</div>}
      {c.direction === "received" && c.status === "cleared" && !c.receipt && <div style={{ fontSize: 12.5, color: "var(--amber)", marginBottom: 8 }}>Not in the customer's ledger yet — post the bank statement line as a customer payment (Cost → Bank statements).</div>}

      {c.status === "returned" && (
        <div className="card" style={{ padding: 12, marginBottom: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>Paid instead of the cheque — ₹{inr2(c.replaced)} of ₹{inr2(c.amount)}</div>
          {!c.replacements.length && <div style={sub}>Nothing recorded yet.</div>}
          {c.replacements.map((r) => (
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, padding: "5px 0", borderTop: "1px solid var(--border)" }}>
              <span>
                {r.mode === "cash" ? "Cash" : "Bank transfer"} · ₹{inr2(r.amount)}{r.paid_on ? ` · ${fmtDate(r.paid_on)}` : ""}{r.reference ? ` · ${r.reference}` : ""}
                <div style={sub}>{r.receipt_id ? `In the customer ledger (receipt ${fmtDate(r.receipt_date)})${r.receipt_cancelled ? " — receipt cancelled" : ""}`
                  : r.posting === "none" ? "Cash taken in C Ledger" : "Waiting for the bank statement credit to be posted"}</div>
              </span>
              {canEdit && <button type="button" disabled={busy} style={{ fontSize: 12, padding: "3px 10px", alignSelf: "flex-start" }} onClick={() => remove(r)}>Remove</button>}
            </div>
          ))}
          {canEdit && !add && <button type="button" style={{ marginTop: 8 }} onClick={() => setAdd({ mode: "bank_transfer", amount: left ? String(left) : "", paid_on: todayStr(), reference: "", posting: "later", receipt_id: "" })}>+ Add a payment</button>}
          {add && (
            <div style={{ marginTop: 8 }}>
              <ReplacementLine p={add} linkable={c.linkable} today={todayStr()} onChange={setAdd} onRemove={() => setAdd(null)} />
              <button type="button" className="btn-primary" disabled={busy} onClick={addPayment}>Save payment</button>
            </div>
          )}
        </div>
      )}
      {c.status === "bounced" && <div style={{ fontSize: 12.5, marginBottom: 8 }}>Bounced {fmtDate(c.bounced_on)} — {c.bounce_reason}{c.bounce_charges ? ` · bank charges ₹${inr2(c.bounce_charges)}` : ""}{c.notice_on ? ` · notice sent ${fmtDate(c.notice_on)}` : ""}</div>}

      <div style={{ fontSize: 13, fontWeight: 600, margin: "10px 0 4px" }}>History</div>
      <div style={{ fontSize: 12.5 }}>
        {c.events.map((e, i) => (
          <div key={i} style={{ display: "flex", gap: 8, padding: "3px 0" }}>
            <span style={{ ...sub, minWidth: 92 }}>{new Date(e.done_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" })}</span>
            <span><b>{e.action}</b>{e.detail?.reason ? ` — ${e.detail.reason}` : ""}{e.detail?.mode ? ` — ${e.detail.mode === "cash" ? "cash" : "bank"} ₹${inr2(e.detail.amount)}` : ""} <span style={sub}>{e.done_by || "app"}</span></span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
        {c.has_photo && <button type="button" onClick={() => setPhoto(true)}>Cheque photo</button>}
        {canEdit && ["in_hand", "issued"].includes(c.status) && <button type="button" onClick={cancel}>{c.direction === "issued" ? "Cancel (leaf void)" : "Cancel — entered by mistake"}</button>}
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {photo && <PhotoModal path={`/accounts/cheques/${id}/photo`} title={`Cheque ${c.cheque_no}`} onClose={() => setPhoto(false)} />}
    </Modal>
  );
}

// -------------------------------------------------------- cheque books ---
function Books({ books, meta, canEdit, canCreate, onDone, setError }) {
  const [add, setAdd] = useState(null);
  const [voidLeaf, setVoidLeaf] = useState(null);
  const [busy, setBusy] = useState(false);
  async function saveBook(e) {
    e.preventDefault(); setBusy(true);
    try { await apiRequest("/accounts/cheque-books", { method: "POST", body: add }); setAdd(null); onDone("Cheque book added."); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function saveVoid(e) {
    e.preventDefault(); setBusy(true);
    try {
      const r = await apiRequest("/accounts/cheques", { method: "POST", body: { direction: "issued", void: true, ...voidLeaf } });
      setVoidLeaf(null); onDone(`Leaf ${r.cheque_no} recorded as cancelled.`);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function active(b) {
    try { await apiRequest(`/accounts/cheque-books/${b.id}/active`, { method: "POST", body: { active: !b.is_active } }); onDone(b.is_active ? "Book closed." : "Book reopened."); }
    catch (err) { setError(err.message); }
  }
  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        {canEdit && <button type="button" onClick={() => setAdd({ account_id: meta?.accounts[0]?.id || "", first_no: "", last_no: "", received_on: todayStr(), note: "" })}>+ Add cheque book</button>}
        {canCreate && <button type="button" onClick={() => setVoidLeaf({ account_id: meta?.accounts[0]?.id || "", cheque_no: "", cancel_reason: "" })}>Cancel a leaf (spoilt / torn)</button>}
      </div>
      {!books.length ? <Empty>No cheque books yet. Add one so issued cheques take the next leaf and every leaf is accounted for.</Empty> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
          {books.map((b) => (
            <div key={b.id} className="card" style={{ padding: 14, opacity: b.is_active ? 1 : 0.6 }}>
              <div style={{ fontWeight: 700 }}>{b.account}</div>
              <div style={sub}>Leaves {b.first_no}–{b.last_no}{b.received_on ? ` · from the bank ${fmtDate(b.received_on)}` : ""}{b.is_active ? "" : " · closed"}</div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 13 }}>
                <span>Next <b style={{ fontVariantNumeric: "tabular-nums" }}>{b.next || "—"}</b></span>
                <span style={{ color: b.left <= 5 ? "var(--amber)" : undefined }}>{b.left} of {b.leaves} left</span>
              </div>
              <div style={{ fontSize: 12.5, marginTop: 4 }}>{b.used} used{b.cancelled ? ` (${b.cancelled} cancelled)` : ""}</div>
              {b.gap_count > 0 && <div style={{ fontSize: 12.5, color: "var(--alert-red)", marginTop: 4 }}>⚠ {b.gap_count} leaf{b.gap_count > 1 ? "s" : ""} skipped: {b.gaps.join(", ")}{b.gap_count > b.gaps.length ? " …" : ""} — record each as issued or cancelled</div>}
              {canEdit && <button type="button" style={{ marginTop: 8, fontSize: 12.5, padding: "4px 10px" }} onClick={() => active(b)}>{b.is_active ? "Close book" : "Reopen"}</button>}
            </div>
          ))}
        </div>
      )}
      {add && (
        <Modal title="Add a cheque book" onClose={() => setAdd(null)} width={440}>
          <form onSubmit={saveBook}>
            <Field label="Account"><select required value={add.account_id} onChange={(e) => setAdd({ ...add, account_id: e.target.value })}>
              <option value="">Choose…</option>{(meta?.accounts || []).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="First leaf"><input required inputMode="numeric" value={add.first_no} onChange={(e) => setAdd({ ...add, first_no: e.target.value })} placeholder="000101" /></Field>
              <Field label="Last leaf"><input required inputMode="numeric" value={add.last_no} onChange={(e) => setAdd({ ...add, last_no: e.target.value })} placeholder="000150" /></Field>
            </div>
            <Field label="Received from the bank on"><input type="date" max={todayStr()} value={add.received_on} onChange={(e) => setAdd({ ...add, received_on: e.target.value })} /></Field>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button type="button" onClick={() => setAdd(null)}>Cancel</button><button type="submit" disabled={busy}>Save</button></div>
          </form>
        </Modal>
      )}
      {voidLeaf && (
        <Modal title="Cancel a leaf" onClose={() => setVoidLeaf(null)} width={440}>
          <form onSubmit={saveVoid}>
            <Field label="Account"><select required value={voidLeaf.account_id} onChange={(e) => setVoidLeaf({ ...voidLeaf, account_id: e.target.value })}>
              <option value="">Choose…</option>{(meta?.accounts || []).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></Field>
            <Field label="Leaf number"><input required inputMode="numeric" value={voidLeaf.cheque_no} onChange={(e) => setVoidLeaf({ ...voidLeaf, cheque_no: e.target.value })} /></Field>
            <Field label="Reason"><input required value={voidLeaf.cancel_reason} onChange={(e) => setVoidLeaf({ ...voidLeaf, cancel_reason: e.target.value })} placeholder="Spoilt, torn, wrongly written …" /></Field>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button type="button" onClick={() => setVoidLeaf(null)}>Close</button><button type="submit" disabled={busy}>Save</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}
