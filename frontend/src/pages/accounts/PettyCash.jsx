// Round 253 — Accounts → Petty cash (owner, 30 Oct 2026; mock-up "Cheques &
// Petty Cash", artboard 2). A cash box with a fixed float, its cash book,
// vouchers (expense / advance), approvals, cash counts by notes, and money in
// two ways (owner): a top-up REQUEST (holder asks → approver approves → paid)
// or DIRECT, from a bank transfer, a self cheque, a cash withdrawal or a C
// Ledger cash holder's cash — every one recorded.
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { todayStr, istMonth } from "../../lib/istDate.js";
import { inr2, fmtDate } from "../../lib/quotationTerms.js";
import { TH, TD, NUM, row, money, Banner, Field, Modal, Empty, Table, readPhotoSmall, PhotoModal } from "./ui.jsx";

const sub = { fontSize: 11.5, color: "var(--slate)" };
const TDN = { ...TD, whiteSpace: "nowrap" };
const VBADGE = { pending: ["Pending", "badge-warning"], approved: ["Approved", "badge-success"], rejected: ["Rejected", "badge-danger"] };
const NOTES = [500, 200, 100, 50, 20, 10];
const monthName = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
const shiftMonth = (ym, n) => { const [y, m] = ym.split("-").map(Number); const t = new Date(y, m - 1 + n, 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`; };

export default function PettyCash({ params, go }) {
  const [d, setD] = useState(null);
  const [book, setBook] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const month = params.get("month") || istMonth();
  const load = () => apiRequest("/accounts/petty-cash").then(setD).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const boxes = d?.boxes || [];
  const box = boxes.find((b) => String(b.id) === params.get("box")) || boxes.find((b) => b.is_active) || boxes[0];
  const loadBook = () => box && apiRequest(`/accounts/petty-cash/${box.id}?month=${month}`).then(setBook).catch((e) => setError(e.message));
  useEffect(() => { setBook(null); loadBook(); }, [box?.id, month]);
  const nav = (extra) => go("petty-cash", { ...(box ? { box: box.id } : {}), month, ...extra });
  const done = (text) => { setModal(null); setMsg(text); setError(""); load(); loadBook(); };

  async function act(path, body, text) {
    setBusy(true); setError(""); setMsg("");
    try { await apiRequest(path, { method: "POST", body }); done(text); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (!d) return <><Banner>{error}</Banner>{!error && <Empty>Loading…</Empty>}</>;
  if (!boxes.length) {
    return (
      <>
        <Banner>{error}</Banner><Banner kind="ok">{msg}</Banner>
        <Empty>No petty cash box is set up yet.{d.rights.setup ? "" : " An Administrator sets one up (holder, approver, float)."}</Empty>
        {d.rights.setup && <button type="button" className="btn-primary" style={{ marginTop: 10 }} onClick={() => setModal({ kind: "box" })}>+ Set up a cash box</button>}
        {modal?.kind === "box" && <BoxForm d={d} onClose={() => setModal(null)} onDone={done} />}
      </>
    );
  }
  const can = box.can;
  const request = d.requests.find((r) => r.box_id === box.id);
  const low = box.pct != null && box.pct <= box.topup_below_pct;

  return (
    <>
      <Banner>{error}</Banner>
      <Banner kind="ok">{msg}</Banner>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
        <div style={{ flex: "1 1 260px" }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{box.name}{!box.is_active && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>closed</span>}</div>
          <div style={sub}>Cash holder: {box.holder_name || "—"} · Approver: {box.approver_name || "Administrator"} · vouchers above {money(box.approval_limit)} need approval</div>
        </div>
        {boxes.length > 1 && (
          <Field label="Cash box" style={{ marginBottom: 0 }}>
            <select value={box.id} onChange={(e) => go("petty-cash", { box: e.target.value, month })}>
              {boxes.map((b) => <option key={b.id} value={b.id}>{b.name}{b.is_active ? "" : " (closed)"}</option>)}
            </select>
          </Field>
        )}
        {can.count && <button type="button" onClick={() => setModal({ kind: "count" })}>Count cash</button>}
        {can.request && !request && <button type="button" onClick={() => setModal({ kind: "request" })}>Request top-up</button>}
        {(can.fund || can.fund_cl) && <button type="button" onClick={() => setModal({ kind: "topup" })}>Add money</button>}
        {d.rights.setup && <button type="button" onClick={() => setModal({ kind: "box", box })}>Box settings</button>}
        {d.rights.setup && <button type="button" onClick={() => setModal({ kind: "box" })}>+ New box</button>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 14 }}>
        <div className="card" style={{ padding: 14, background: "var(--charcoal)", color: "#fff", borderColor: "var(--charcoal)" }}>
          <div style={{ fontSize: 12.5, opacity: 0.85 }}>Cash in box (book)</div>
          <div style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 8px", fontVariantNumeric: "tabular-nums" }}>₹{inr2(box.balance)}</div>
          <div style={{ height: 8, borderRadius: 99, background: "rgba(255,255,255,.2)", overflow: "hidden" }}>
            <div style={{ width: `${Math.max(0, Math.min(100, box.pct || 0))}%`, height: "100%", background: low ? "#F2B35B" : "var(--signal-green-bg)" }} />
          </div>
          <div style={{ fontSize: 12, opacity: 0.85, marginTop: 6 }}>{box.pct ?? "—"}% of float {money(box.float_amount)} · top-up below {box.topup_below_pct}%</div>
        </div>
        <Tile label={`Spent · ${monthName(month)}`} value={money(book?.summary.spent)} sub={book ? `${book.summary.vouchers} voucher${book.summary.vouchers === 1 ? "" : "s"}${book.summary.no_bill ? ` · ${book.summary.no_bill} without a bill` : ""}` : ""} />
        <Tile label="Awaiting approval" value={String(box.pending.n)} sub={box.pending.n ? `${money(box.pending.amount)} · oldest ${fmtDate(box.pending.oldest)}` : "Nothing waiting"} tone={box.pending.n ? "amber" : null} />
        <Tile label={box.last_count ? `Last cash count · ${fmtDate(box.last_count.counted_on)}` : "Cash count"} tone={box.last_count && Math.abs(box.last_count.diff) >= 1 ? "amber" : null}
          value={box.last_count ? (Math.abs(box.last_count.diff) < 1 ? "Matched" : `${box.last_count.diff > 0 ? "+" : "−"}₹${inr2(Math.abs(box.last_count.diff))}`) : "Not counted"}
          sub={box.last_count ? (Math.abs(box.last_count.diff) < 1 ? `₹${inr2(box.last_count.counted)} counted` : `${box.last_count.diff > 0 ? "Over" : "Short"} · ${box.last_count.reason || ""}`) : "Count the notes now and then"} />
      </div>

      {/* Requests and approvals first — what someone has to act on. */}
      {request && (
        <div className="card" style={{ padding: 14, marginBottom: 12, borderLeft: "3px solid var(--amber)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <b>Top-up {request.status === "requested" ? "requested" : "approved — to be paid"}: {money(request.status === "approved" ? request.amount : request.request_amount)}</b>
              <div style={sub}>by {request.requested_by_name || "—"}{request.request_note ? ` — “${request.request_note}”` : ""}{request.status === "approved" ? ` · approved by ${request.decided_by_name}${request.amount !== request.request_amount ? ` (asked ${money(request.request_amount)})` : ""}` : ""}</div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {request.status === "requested" && can.approve && <>
                <button type="button" disabled={busy} onClick={() => { const note = window.prompt("Why is the top-up rejected?", ""); if (note) act(`/accounts/petty-cash/topups/${request.id}/decide`, { decision: "reject", note }, "Top-up request rejected."); }}>Reject</button>
                <button type="button" className="btn-primary" disabled={busy} onClick={() => setModal({ kind: "approve", request })}>Approve</button>
              </>}
              {request.status === "approved" && (can.fund || can.fund_cl) && <button type="button" className="btn-primary" onClick={() => setModal({ kind: "topup", request })}>Pay it</button>}
              {(request.requested_by === d.me || can.approve) && <button type="button" disabled={busy} onClick={() => { if (window.confirm("Take back this top-up request?")) act(`/accounts/petty-cash/topups/${request.id}/cancel`, {}, "Top-up request withdrawn."); }}>Withdraw</button>}
            </div>
          </div>
        </div>
      )}
      {can.approve && book?.pending.length > 0 && (
        <div className="card" style={{ padding: 0, marginBottom: 12, overflowX: "auto" }}>
          <div style={{ padding: "10px 14px", fontWeight: 600, borderBottom: "1px solid var(--border)" }}>Vouchers to approve</div>
          {book.pending.map((v) => (
            <div key={v.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", padding: "10px 14px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
              <div style={{ fontSize: 13 }}>
                <b>{v.no}</b> · {fmtDate(v.d)} · {v.paid_to} — {v.purpose} · <b>₹{inr2(v.amount)}</b>
                <div style={sub}>{v.kind === "advance" ? "Advance" : catLabel(d, v.category)}{v.kind === "settle" ? " · settles an advance" : ""} · by {v.created_by_name}{v.bill === "none" ? " · no bill" : v.bill === "slip" ? " · signed slip" : ""}</div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {v.has_photo && <button type="button" onClick={() => setModal({ kind: "photo", id: v.id, title: v.no })}>Bill</button>}
                <button type="button" disabled={busy} onClick={() => { const note = window.prompt("Why is it rejected? The cash goes back into the box.", ""); if (note) act(`/accounts/petty-cash/vouchers/${v.id}/reject`, { note }, `${v.no} rejected.`); }}>Reject</button>
                <button type="button" className="btn-primary" disabled={busy} onClick={() => act(`/accounts/petty-cash/vouchers/${v.id}/approve`, {}, `${v.no} approved.`)}>Approve</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {book?.open_advances.length > 0 && (
        <div className="card" style={{ padding: 0, marginBottom: 12 }}>
          <div style={{ padding: "10px 14px", fontWeight: 600, borderBottom: "1px solid var(--border)" }}>Advances to settle</div>
          {book.open_advances.map((v) => (
            <div key={v.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", padding: "10px 14px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
              <div style={{ fontSize: 13 }}><b>{v.no}</b> · {fmtDate(v.d)} · {v.paid_to} — {v.purpose} · <b>₹{inr2(v.amount)}</b>
                <div style={sub}>Out for {Math.max(0, Math.round((new Date(d.today) - new Date(v.d)) / 86400000))} day(s) · not a cost until settled</div></div>
              {(can.voucher || can.approve) && <button type="button" onClick={() => setModal({ kind: "settle", voucher: v })}>Settle</button>}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
        <div style={{ flex: "999 1 600px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <b style={{ fontSize: 15 }}>Cash book · {monthName(month)}</b>
            <button type="button" aria-label="Previous month" style={{ padding: "4px 10px" }} onClick={() => nav({ month: shiftMonth(month, -1) })}>‹</button>
            <button type="button" aria-label="Next month" style={{ padding: "4px 10px" }} disabled={month >= istMonth()} onClick={() => nav({ month: shiftMonth(month, 1) })}>›</button>
          </div>
          {!book ? <Empty>Loading…</Empty> : (
            <Table minWidth={820} head={<>
              <th style={TH}>Date</th><th style={TH}>No.</th><th style={TH}>Paid to / from</th><th style={TH}>Head</th>
              <th style={{ ...TH, textAlign: "right" }}>In</th><th style={{ ...TH, textAlign: "right" }}>Out</th><th style={{ ...TH, textAlign: "right" }}>Balance</th><th style={TH}>Bill · status</th>
            </>}>
              <tr style={{ ...row, background: "var(--concrete)" }}><td style={TDN}>{fmtDate(`${month}-01`)}</td><td style={TD} /><td style={TD}>Opening balance</td><td style={TD} /><td style={NUM} /><td style={NUM} /><td style={{ ...NUM, fontWeight: 600 }}>₹{inr2(book.opening)}</td><td style={TD} /></tr>
              {book.rows.map((x) => <BookRow key={`${x.type}${x.id}`} x={x} d={d} can={can} me={d.me} busy={busy} act={act} open={setModal} />)}
              <tr style={{ ...row, background: "var(--concrete)" }}><td style={TD} /><td style={TD} /><td style={TD}><b>Closing balance</b></td><td style={TD} /><td style={NUM} /><td style={NUM} /><td style={{ ...NUM, fontWeight: 700 }}>₹{inr2(book.closing)}</td><td style={TD} /></tr>
            </Table>
          )}
          <div style={{ ...sub, marginTop: 8 }}>
            Approved vouchers go into their expense head in the Cost dashboard{book?.summary.cost ? ` (${money(book.summary.cost)} this month)` : ""}. ⚑ flagged vouchers are counted the C Ledger way.
            An advance is not a cost until it is settled with what it was spent on; what came back is shown on the day it was settled.
          </div>
          {book?.cancelled_topups.length > 0 && <div style={{ ...sub, marginTop: 4 }}>Cancelled top-ups this month: {book.cancelled_topups.map((t) => `${fmtDate(t.d)} ₹${inr2(t.amount)} (${t.cancel_reason || "—"})`).join("; ")}</div>}
        </div>
        {can.voucher && box.is_active && <div style={{ flex: "1 1 320px", minWidth: 0 }}><VoucherForm d={d} box={box} onDone={done} /></div>}
      </div>

      {book?.counts.length > 0 && (
        <div className="card" style={{ marginTop: 14, padding: 14 }}>
          <b style={{ fontSize: 14 }}>Cash counts</b>
          {book.counts.map((c) => (
            <div key={c.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, padding: "5px 0", borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
              <span>{fmtDate(c.counted_on)} · {c.counted_by_name} · {Object.entries(c.notes || {}).map(([k, v]) => (k === "coins" ? `coins ₹${v}` : `₹${k}×${v}`)).join(", ")}</span>
              <span>counted ₹{inr2(c.counted)} / book ₹{inr2(c.book)} {Math.abs(c.diff) >= 1 && <b style={{ color: "var(--alert-red)" }}>{c.diff > 0 ? "over" : "short"} ₹{inr2(Math.abs(c.diff))}{c.reason ? ` — ${c.reason}` : ""}</b>}</span>
            </div>
          ))}
        </div>
      )}

      {modal?.kind === "box" && <BoxForm d={d} box={modal.box} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "count" && <CountForm box={box} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "request" && <RequestForm box={box} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "approve" && <ApproveForm request={modal.request} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "topup" && <TopupForm d={d} box={box} request={modal.request} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "settle" && <SettleForm d={d} voucher={modal.voucher} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "edit" && <Modal title={`Change ${modal.voucher.no}`} onClose={() => setModal(null)} width={460}><VoucherForm d={d} box={box} voucher={modal.voucher} onDone={done} /></Modal>}
      {modal?.kind === "photo" && <PhotoModal path={`/accounts/petty-cash/vouchers/${modal.id}/photo`} title={`Bill · ${modal.title}`} onClose={() => setModal(null)} />}
    </>
  );
}

const catLabel = (d, key) => d.categories.find((c) => c.key === key)?.label || key || "—";

function Tile({ label, value, sub: s, tone }) {
  const amber = tone === "amber";
  return (
    <div className="card" style={{ padding: 14, ...(amber ? { background: "var(--amber-bg)", borderColor: "var(--amber)" } : {}) }}>
      <div style={{ fontSize: 12.5, color: amber ? "var(--amber)" : "var(--slate)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: amber ? "var(--amber)" : undefined, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 12, color: amber ? "var(--amber)" : "var(--slate)", marginTop: 2 }}>{s}</div>
    </div>
  );
}

function BookRow({ x, d, can, me, busy, act, open }) {
  const tint = x.type === "topup" || x.type === "return" ? { background: "#F7FAF9" } : {};
  if (x.type === "topup") {
    const from = x.source === "cledger" ? `C Ledger · ${x.cl_holder}` : `${x.source_label}${x.account ? ` · ${x.account}` : ""}`;
    return (
      <tr style={{ ...row, ...tint }}>
        <td style={TDN}>{fmtDate(x.d)}</td><td style={TDN}>TU-{String(x.id).padStart(4, "0")}</td>
        <td style={TD}>Top-up{x.direct ? " (direct)" : " (on request)"}<div style={sub}>{from}{x.reference ? ` · ${x.reference}` : ""}{x.cheque_no && !String(x.reference || "").includes(x.cheque_no) ? ` · cheque ${x.cheque_no}` : ""}</div></td>
        <td style={TD}>—</td><td style={NUM}>₹{inr2(x.amount)}</td><td style={NUM} /><td style={NUM}>₹{inr2(x.balance)}</td>
        <td style={TD}>{can.approve && <button type="button" disabled={busy} style={{ fontSize: 12, padding: "3px 9px" }} onClick={() => { const reason = window.prompt("Cancel this top-up (entered by mistake)? Give the reason. C Ledger cash goes back; a self cheque is cancelled.", ""); if (reason) act(`/accounts/petty-cash/topups/${x.id}/cancel`, { reason }, "Top-up cancelled."); }}>Cancel</button>}</td>
      </tr>
    );
  }
  if (x.type === "return") {
    return (
      <tr style={{ ...row, ...tint }}>
        <td style={TDN}>{fmtDate(x.d)}</td><td style={TDN}>{x.no}</td><td style={TD}>{x.amount >= 0 ? "Change returned" : "Spent over the advance"} · {x.paid_to}</td><td style={TD}>—</td>
        <td style={NUM}>{x.amount > 0 ? `₹${inr2(x.amount)}` : ""}</td><td style={NUM}>{x.amount < 0 ? `₹${inr2(-x.amount)}` : ""}</td><td style={NUM}>₹{inr2(x.balance)}</td><td style={TD} />
      </tr>
    );
  }
  const [label, cls] = VBADGE[x.status] || [x.status, "badge-neutral"];
  const mine = x.created_by === me;
  const canChange = (x.status === "pending" && (mine || can.voucher)) || can.approve;
  return (
    <tr style={row}>
      <td style={TDN}>{fmtDate(x.d)}</td><td style={TDN}>{x.no}</td>
      <td style={TD}>{x.paid_to}{x.flagged && <span title="flagged" style={{ color: "var(--amber)", marginLeft: 4 }}>⚑</span>}<div style={sub}>{x.purpose}</div></td>
      <td style={TD}>{x.kind === "advance" ? (x.settled_on ? `Advance · settled ${fmtDate(x.settled_on)}` : "Advance (to settle)") : catLabel(d, x.category)}{x.asset_name && <div style={sub}>{x.asset_name}</div>}{x.kind === "settle" && <div style={sub}>paid from the advance</div>}</td>
      <td style={NUM} /><td style={NUM}>{x.cash ? `₹${inr2(-x.cash)}` : x.kind === "settle" && x.status !== "rejected" ? <span style={sub}>₹{inr2(x.amount)}</span> : ""}</td><td style={NUM}>₹{inr2(x.balance)}</td>
      <td style={TD}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {x.has_photo ? <button type="button" style={{ fontSize: 12, padding: "2px 8px" }} onClick={() => open({ kind: "photo", id: x.id, title: x.no })}>Photo</button>
            : x.kind !== "advance" && <span style={sub}>{x.bill === "slip" ? "Signed slip" : "No bill"}</span>}
          <span className={`badge ${cls}`}>{label}</span>
          {x.decision_note && x.status === "rejected" && <span style={sub}>{x.decision_note}</span>}
          {canChange && !(x.kind === "advance" && x.settled_on) && <button type="button" style={{ fontSize: 12, padding: "2px 8px" }} onClick={() => open({ kind: "edit", voucher: x })}>Change</button>}
          {canChange && !(x.kind === "advance" && x.settled_on) && <button type="button" disabled={busy} style={{ fontSize: 12, padding: "2px 8px" }} onClick={() => {
            const reason = x.status === "pending" ? "" : window.prompt(`Delete ${x.no}? Give the reason.`, "");
            if (x.status !== "pending" && !reason) return;
            if (x.status === "pending" && !window.confirm(`Take back ${x.no}?`)) return;
            act(`/accounts/petty-cash/vouchers/${x.id}/delete`, { reason }, `${x.no} deleted.`);
          }}>Delete</button>}
        </div>
      </td>
    </tr>
  );
}

// -------------------------------------------------------------- forms ---
function VoucherForm({ d, box, voucher, onDone }) {
  const editing = !!voucher;
  const [f, setF] = useState(editing
    ? { kind: voucher.kind, txn_date: voucher.d, amount: String(voucher.amount), paid_to: voucher.paid_to, purpose: voucher.purpose || "", category: voucher.category || "", asset_id: voucher.asset_id || "", bill: voucher.bill, flagged: voucher.flagged, photo: undefined }
    : { kind: "expense", txn_date: todayStr(), amount: "", paid_to: "", purpose: "", category: "", asset_id: "", bill: "slip", flagged: false, photo: null });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  async function photo(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try { setF({ ...f, photo: await readPhotoSmall(file), bill: "photo" }); } catch (err) { setError(err.message); }
  }
  async function save(e) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const body = { ...f, amount: Number(f.amount) };
      if (editing) {
        await apiRequest(`/accounts/petty-cash/vouchers/${voucher.id}/edit`, { method: "POST", body });
        onDone(`${voucher.no} changed.`);
      } else {
        const r = await apiRequest(`/accounts/petty-cash/${box.id}/vouchers`, { method: "POST", body });
        onDone(`${r.no} saved${r.status === "pending" ? " — waiting for approval" : ""}.`);
      }
    } catch (err) { setError(err.message); setBusy(false); }
  }
  const adv = f.kind === "advance";
  const inner = (
    <form onSubmit={save}>
      <Banner>{error}</Banner>
      {!editing && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, background: "var(--concrete)", borderRadius: 10, padding: 4, marginBottom: 10 }}>
          {[["expense", "Expense"], ["advance", "Advance"]].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setF({ ...f, kind: k })}
              style={{ minHeight: 40, border: "none", borderRadius: 8, fontWeight: f.kind === k ? 700 : 500, background: f.kind === k ? "var(--surface)" : "transparent" }}>{l}</button>
          ))}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label="Amount ₹"><input type="number" min="1" step="0.01" required value={f.amount} onChange={set("amount")} /></Field>
        <Field label="Date"><input type="date" required max={todayStr()} value={f.txn_date} onChange={set("txn_date")} /></Field>
      </div>
      <Field label={adv ? "Given to" : "Paid to"}><input required value={f.paid_to} onChange={set("paid_to")} placeholder={adv ? "Person" : "Shop or person"} /></Field>
      <Field label={adv ? "For" : "What for"}><input required value={f.purpose} onChange={set("purpose")} placeholder={adv ? "e.g. diesel run, site purchase" : "e.g. hose clamps for TM"} /></Field>
      {!adv && (
        <Field label="Expense head">
          <select required value={f.category} onChange={set("category")}>
            <option value="">Choose…</option>
            {d.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>
      )}
      <Field label="Vehicle / equipment (optional)">
        <select value={f.asset_id} onChange={set("asset_id")}><option value="">—</option>{d.assets.map((a) => <option key={a.id} value={a.id}>{a.name}{a.reg_no ? ` · ${a.reg_no}` : ""}</option>)}</select>
      </Field>
      {!adv && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <label style={{ display: "inline-flex", alignItems: "center", minHeight: 44, padding: "0 12px", border: "1px dashed var(--border-strong)", borderRadius: 8, fontSize: 13.5, cursor: "pointer" }}>
            {f.photo || (editing && voucher.has_photo && f.photo === undefined) ? "Bill photo ✓ — change" : "Attach bill photo"}
            <input type="file" accept="image/*" capture="environment" onChange={photo} style={{ display: "none" }} />
          </label>
          {!f.photo && !(editing && voucher.has_photo) && (
            <select value={f.bill} onChange={set("bill")} aria-label="Bill" style={{ minHeight: 44 }}>
              <option value="slip">Signed slip</option><option value="none">No bill</option>
            </select>
          )}
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 44, fontSize: 13.5 }}>
            <input type="checkbox" checked={f.flagged} onChange={set("flagged")} style={{ width: 20, height: 20 }} /><span style={{ color: "var(--amber)" }}>⚑</span> Flag
          </label>
        </div>
      )}
      <button type="submit" className="btn-primary" disabled={busy} style={{ width: "100%", minHeight: 46 }}>{busy ? "Saving…" : editing ? "Save changes" : adv ? "Give advance" : "Save voucher"}</button>
      <div style={{ ...sub, marginTop: 6 }}>{box.approval_limit > 0 ? `Above ${money(box.approval_limit)} it waits for the approver.` : "Every voucher waits for the approver."}</div>
    </form>
  );
  if (editing) return inner;
  return <div className="card" style={{ padding: 14 }}><b style={{ fontSize: 15, display: "block", marginBottom: 10 }}>New voucher</b>{inner}</div>;
}

function SettleForm({ d, voucher, onClose, onDone }) {
  const [f, setF] = useState({ amount: String(voucher.amount), settled_on: todayStr(), category: "", purpose: voucher.purpose || "", paid_to: voucher.paid_to, asset_id: voucher.asset_id || "", bill: "slip", flagged: false, photo: null });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const back = voucher.amount - (Number(f.amount) || 0);
  async function save(e) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const r = await apiRequest(`/accounts/petty-cash/vouchers/${voucher.id}/settle`, { method: "POST", body: { ...f, amount: Number(f.amount) } });
      onDone(`${voucher.no} settled${r.returned > 0 ? ` — ₹${inr2(r.returned)} back in the box` : r.returned < 0 ? ` — ₹${inr2(-r.returned)} more paid from the box` : ""}.`);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title={`Settle ${voucher.no} · ₹${inr2(voucher.amount)} to ${voucher.paid_to}`} onClose={onClose} width={480}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Spent ₹"><input type="number" min="0" step="0.01" required value={f.amount} onChange={set("amount")} /></Field>
          <Field label="Settled on"><input type="date" required max={todayStr()} value={f.settled_on} onChange={set("settled_on")} /></Field>
        </div>
        <div style={{ fontSize: 12.5, marginBottom: 10, color: back < 0 ? "var(--amber)" : "var(--slate)" }}>
          {back > 0 ? `₹${inr2(back)} cash comes back into the box.` : back < 0 ? `₹${inr2(-back)} more than the advance — paid from the box now.` : "All of it was spent."}
        </div>
        {Number(f.amount) > 0 && <>
          <Field label="Spent on"><input required value={f.purpose} onChange={set("purpose")} /></Field>
          <Field label="Expense head"><select required value={f.category} onChange={set("category")}><option value="">Choose…</option>{d.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></Field>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
            <label style={{ display: "inline-flex", alignItems: "center", minHeight: 44, padding: "0 12px", border: "1px dashed var(--border-strong)", borderRadius: 8, fontSize: 13.5, cursor: "pointer" }}>
              {f.photo ? "Bill photo ✓" : "Attach bill photo"}
              <input type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={async (e) => { const file = e.target.files?.[0]; if (file) setF({ ...f, photo: await readPhotoSmall(file), bill: "photo" }); }} />
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 44, fontSize: 13.5 }}><input type="checkbox" checked={f.flagged} onChange={set("flagged")} style={{ width: 20, height: 20 }} /><span style={{ color: "var(--amber)" }}>⚑</span> Flag</label>
          </div>
        </>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button type="button" onClick={onClose}>Close</button><button type="submit" disabled={busy}>{busy ? "Saving…" : "Settle"}</button></div>
      </form>
    </Modal>
  );
}

// Money in: pays an approved request, or a direct top-up.
function TopupForm({ d, box, request, onClose, onDone }) {
  const sources = d.sources.filter((s) => (s.key === "cledger" ? box.can.fund_cl : box.can.fund));
  const [f, setF] = useState({ source: sources[0]?.key || "", amount: request ? String(request.amount) : String(box.suggested_topup || ""), received_on: todayStr(), account_id: d.accounts[0]?.id || "", reference: "", cheque_no: "", note: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const body = { ...f, amount: Number(f.amount) };
      const r = await apiRequest(request ? `/accounts/petty-cash/topups/${request.id}/pay` : `/accounts/petty-cash/${box.id}/topups`, { method: "POST", body });
      onDone(`₹${inr2(body.amount)} added to ${box.name}${r.cheque_no ? ` — self cheque ${r.cheque_no} is in the cheque register` : ""}.`);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  const bank = f.source && f.source !== "cledger";
  return (
    <Modal title={request ? `Pay the top-up · ${box.name}` : `Add money · ${box.name}`} onClose={onClose} width={480}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        {!request && <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 10 }}>A direct top-up, without a request. To fill up to the float: {money(box.suggested_topup)}.</div>}
        <Field label="Money from">
          <select required value={f.source} onChange={set("source")}>{sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
        </Field>
        {f.source === "cledger" && <div style={{ fontSize: 12.5, marginBottom: 10 }}>From your C Ledger cash (in hand {money(d.cl_balance)}). It shows in your C Ledger as “Given to petty cash”.</div>}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Amount ₹"><input type="number" min="1" step="0.01" required value={f.amount} onChange={set("amount")} /></Field>
          <Field label="Received on"><input type="date" required max={todayStr()} value={f.received_on} onChange={set("received_on")} /></Field>
        </div>
        {bank && (
          <Field label="From account"><select required value={f.account_id} onChange={set("account_id")}><option value="">Choose…</option>{d.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></Field>
        )}
        {f.source === "cheque" && <Field label="Self cheque leaf number" hint="It is entered in the cheque register as issued to Self — petty cash."><input required inputMode="numeric" value={f.cheque_no} onChange={set("cheque_no")} /></Field>}
        {bank && f.source !== "cheque" && <Field label="Reference (UTR / slip)" hint="On the bank statement this debit is left out by itself — the vouchers carry the cost."><input value={f.reference} onChange={set("reference")} /></Field>}
        {!request && <Field label="Note (optional)"><input value={f.note} onChange={set("note")} /></Field>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button type="button" onClick={onClose}>Close</button><button type="submit" disabled={busy || !sources.length}>{busy ? "Saving…" : "Add to the box"}</button></div>
      </form>
    </Modal>
  );
}

function RequestForm({ box, onClose, onDone }) {
  const [f, setF] = useState({ amount: String(box.suggested_topup || ""), note: "" });
  const [error, setError] = useState("");
  async function save(e) {
    e.preventDefault(); setError("");
    try { await apiRequest(`/accounts/petty-cash/${box.id}/requests`, { method: "POST", body: { ...f, amount: Number(f.amount) } }); onDone("Top-up requested — sent to the approver."); }
    catch (err) { setError(err.message); }
  }
  return (
    <Modal title={`Request a top-up · ${box.name}`} onClose={onClose} width={420}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 10 }}>Float {money(box.float_amount)} − cash in box {money(box.balance)} = {money(box.suggested_topup)}: what was spent since the last top-up.</div>
        <Field label="Amount ₹"><input type="number" min="1" step="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Note (optional)"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button type="button" onClick={onClose}>Close</button><button type="submit">Send request</button></div>
      </form>
    </Modal>
  );
}

function ApproveForm({ request, onClose, onDone }) {
  const [amount, setAmount] = useState(String(request.request_amount));
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  async function save(e) {
    e.preventDefault(); setError("");
    try { await apiRequest(`/accounts/petty-cash/topups/${request.id}/decide`, { method: "POST", body: { decision: "approve", amount: Number(amount), note } }); onDone("Top-up approved — it can now be paid."); }
    catch (err) { setError(err.message); }
  }
  return (
    <Modal title="Approve the top-up" onClose={onClose} width={400}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        <Field label="Amount approved ₹"><input type="number" min="1" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button type="button" onClick={onClose}>Close</button><button type="submit">Approve</button></div>
      </form>
    </Modal>
  );
}

function CountForm({ box, onClose, onDone }) {
  const [n, setN] = useState({ coins: "" });
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const counted = NOTES.reduce((s, k) => s + k * (Number(n[k]) || 0), 0) + (Number(n.coins) || 0);
  const diff = Math.round((counted - box.balance) * 100) / 100;
  async function save(e) {
    e.preventDefault(); setError("");
    try {
      const r = await apiRequest(`/accounts/petty-cash/${box.id}/counts`, { method: "POST", body: { notes: n, reason } });
      onDone(Math.abs(r.diff) < 1 ? "Cash count matches the book." : `Cash count saved — ${r.diff > 0 ? "over" : "short"} by ₹${inr2(Math.abs(r.diff))}.`);
    } catch (err) { setError(err.message); }
  }
  return (
    <Modal title={`Count cash · ${box.name}`} onClose={onClose} width={440}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
          {NOTES.map((k) => <Field key={k} label={`₹${k} ×`}><input type="number" min="0" step="1" inputMode="numeric" value={n[k] || ""} onChange={(e) => setN({ ...n, [k]: e.target.value })} /></Field>)}
          <Field label="Coins ₹"><input type="number" min="0" step="1" value={n.coins} onChange={(e) => setN({ ...n, coins: e.target.value })} /></Field>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "8px 0", borderTop: "1px solid var(--border)", marginBottom: 8 }}>
          <span>Counted ₹{inr2(counted)} · book ₹{inr2(box.balance)}</span>
          <b style={{ color: Math.abs(diff) >= 1 ? "var(--alert-red)" : "var(--signal-green)" }}>{Math.abs(diff) < 1 ? "Matches" : `${diff > 0 ? "Over" : "Short"} ₹${inr2(Math.abs(diff))}`}</b>
        </div>
        {Math.abs(diff) >= 1 && <Field label="Reason for the difference"><input required value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button type="button" onClick={onClose}>Close</button><button type="submit">Save count</button></div>
      </form>
    </Modal>
  );
}

function BoxForm({ d, box, onClose, onDone }) {
  const [f, setF] = useState(box
    ? { name: box.name, holder_id: box.holder_id || "", approver_id: box.approver_id || "", float_amount: String(box.float_amount), approval_limit: String(box.approval_limit), topup_below_pct: String(box.topup_below_pct), is_active: box.is_active }
    : { name: "", holder_id: "", approver_id: "", float_amount: "", approval_limit: "1000", topup_below_pct: "25", is_active: true });
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  async function save(e) {
    e.preventDefault(); setError("");
    try {
      await apiRequest(box ? `/accounts/petty-cash/boxes/${box.id}` : "/accounts/petty-cash/boxes", { method: "POST",
        body: { ...f, float_amount: Number(f.float_amount), approval_limit: Number(f.approval_limit), topup_below_pct: Number(f.topup_below_pct) } });
      onDone(box ? "Cash box saved." : "Cash box set up.");
    } catch (err) { setError(err.message); }
  }
  return (
    <Modal title={box ? `Settings · ${box.name}` : "Set up a cash box"} onClose={onClose} width={460}>
      <form onSubmit={save}>
        <Banner>{error}</Banner>
        <Field label="Name"><input required value={f.name} onChange={set("name")} placeholder="Plant office" /></Field>
        <Field label="Cash holder"><select required value={f.holder_id} onChange={set("holder_id")}><option value="">Choose…</option>{d.users.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.role}</option>)}</select></Field>
        <Field label="Approver" hint="Approves vouchers above the limit and top-up requests. Empty: whoever holds the approve right (Administrator).">
          <select value={f.approver_id} onChange={set("approver_id")}><option value="">—</option>{d.users.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.role}</option>)}</select>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
          <Field label="Float ₹"><input type="number" min="1" required value={f.float_amount} onChange={set("float_amount")} /></Field>
          <Field label="Approve above ₹" hint="0 = every voucher"><input type="number" min="0" required value={f.approval_limit} onChange={set("approval_limit")} /></Field>
          <Field label="Top-up below %"><input type="number" min="0" max="100" required value={f.topup_below_pct} onChange={set("topup_below_pct")} /></Field>
        </div>
        {box && <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, marginBottom: 10 }}><input type="checkbox" checked={f.is_active} onChange={set("is_active")} /> Box in use</label>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button type="button" onClick={onClose}>Close</button><button type="submit">Save</button></div>
      </form>
    </Modal>
  );
}
