// Round 245 — Cost → Water (owner, 27 Oct 2026): a rate for the plant's own
// water and the water bought, so the water used in batching has a cost.
// Water used comes from the batching plant (Water 1 + Water 2 of every batch,
// 1 kg = 1 litre). Cost = purchased water bills + (used − bought) × own rate per
// kilolitre. Rules: backend lib/waterCost.js.
import { useState } from "react";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { apiRequest } from "../../lib/api.js";
import { istDay } from "../../lib/istDate.js";
import { useCostData, Loading, Actions, BTN, Tile, Note, Modal, MonthSelect, rs, num, fmtDay, monthName, H2, MUTED, R, GRID, panel } from "./costUi.jsx";

const TH = { textAlign: "left", fontSize: 11.5, color: "var(--slate)", fontWeight: 600, padding: "6px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
const TD = { padding: "7px 8px", borderBottom: "1px solid var(--border)", fontSize: 13 };
const TDR = { ...TD, ...R };
const kl = (l) => (l == null ? "—" : `${num(l / 1000, l >= 100000 ? 0 : 1)} kL`);

export default function CostWaterTab({ month, setMonth }) {
  const { can } = usePermissions();
  const canEdit = can("cost.entries", "edit");
  const { data: d, error, reload } = useCostData(`/cost/water?month=${month}`);
  const [buy, setBuy] = useState(null);
  const [rates, setRates] = useState(false);
  const [msg, setMsg] = useState("");

  const head = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 14 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Water</h1>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4 }}>Water used in batching, the water bought, and its cost — goes into the Profit &amp; Loss and break-even as “Water”</div>
      </div>
      <Actions>
        <MonthSelect value={month} onChange={setMonth} />
        {canEdit && <button type="button" style={BTN} onClick={() => setRates(true)}>Own water rate</button>}
        {canEdit && <button type="button" className="btn-primary" style={BTN} onClick={() => setBuy({ bought_on: istDay(), supplier: "", litres: "", amount: "", bill_no: "", note: "" })}>Add water bought</button>}
      </Actions>
    </div>
  );
  if (!d) return <>{head}<div style={{ marginTop: 16 }}><Loading error={error} /></div></>;
  const w = d.month, s = d.settings;
  const done = (m) => { setMsg(m); reload(); };
  async function remove(p) {
    if (!window.confirm(`Remove the water bought on ${fmtDay(p.bought_on)} — ${num(p.litres)} L for ${rs(p.amount)}?`)) return;
    try { await apiRequest(`/cost/water/purchases/${p.id}`, { method: "DELETE" }); done("Removed."); } catch (e) { setMsg(e.message); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {head}
      {msg && <Note tone="good">{msg}</Note>}
      {w.rate_missing && <Note>No rate is set for the plant’s own water yet, so {kl(w.own_l)} of own water used in {monthName(month)} has no cost. Set it under “Own water rate”.</Note>}
      {w.surplus_l > 0 && <Note>More water was bought than the batches used ({kl(w.surplus_l)} more) — the rest went to washing, curing or is still in the tank; all of it is costed as bought.</Note>}

      <div style={GRID(190)}>
        <Tile dark label={`Water cost · ${monthName(month)}`} value={rs(w.value)} note={w.used_l > 0 ? `${rs(Math.round(w.value / (w.used_l / 1000)))} per kL used` : "no batching water this month"} />
        <Tile label="Water used in batching" value={kl(w.used_l)} note={`${num(w.used_l)} L · ${w.batches} batch${w.batches === 1 ? "" : "es"} (Water 1 + Water 2)`} />
        <Tile label="Water bought" value={kl(w.bought_l)} note={`${rs(w.bought_value)}${w.bought_rate_kl != null ? ` · ${rs(w.bought_rate_kl)} per kL` : ""} · ${w.purchases.length} bill${w.purchases.length === 1 ? "" : "s"}`} />
        <Tile label="Own water" value={kl(w.own_l)} note={w.own_rate_kl == null ? "rate not set" : `× ${rs(w.own_rate_kl)} per kL = ${rs(w.own_value)}`} />
      </div>

      <section style={panel("1 1 100%")}>
        <h2 style={H2}>How it’s worked out</h2>
        <table style={{ width: "100%", maxWidth: 640, borderCollapse: "collapse", marginTop: 8 }}>
          <tbody>
            <tr><td style={TD}>Water used — batching plant, Water 1 + Water 2 (1 kg = 1 L)</td><td style={TDR}>{num(w.used_l)} L</td></tr>
            <tr><td style={TD}>Less water bought this month</td><td style={TDR}>− {num(Math.min(w.bought_l, w.used_l))} L</td></tr>
            <tr><td style={TD}><b>Own water used</b></td><td style={TDR}><b>{num(w.own_l)} L</b></td></tr>
            <tr><td style={TD}>× own water rate {w.own_rate_kl == null ? "(not set)" : `${rs(w.own_rate_kl)} per kL`}</td><td style={TDR}>{rs(w.own_value)}</td></tr>
            <tr><td style={TD}>+ water bought (the bills)</td><td style={TDR}>{rs(w.bought_value)}</td></tr>
            <tr><td style={{ ...TD, fontWeight: 700 }}>Water cost</td><td style={{ ...TDR, fontWeight: 700 }}>{rs(w.value)}</td></tr>
          </tbody>
        </table>
        <div style={{ ...MUTED, marginTop: 8 }}>The own-water rate is your cost of the plant’s own water — well / borewell pumping, supply charges — per kilolitre (1,000 litres). If a tanker bill was also given a cost head on Bank statements or in C Ledger, change that line to “Omit”, so it is not counted twice.</div>
      </section>

      <section style={panel("1 1 100%")}>
        <h2 style={H2}>Water bought — {monthName(month)}</h2>
        {!w.purchases.length ? <div style={{ ...MUTED, marginTop: 6 }}>None entered for this month.</div> : (
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table style={{ width: "100%", minWidth: 680, borderCollapse: "collapse" }}>
              <thead><tr><th style={TH}>Date</th><th style={TH}>Supplier</th><th style={{ ...TH, ...R }}>Litres</th><th style={{ ...TH, ...R }}>Amount</th><th style={{ ...TH, ...R }}>Per kL</th><th style={TH}>Bill no.</th><th style={TH}>Note</th><th style={TH} /></tr></thead>
              <tbody>{w.purchases.map((p) => (
                <tr key={p.id}>
                  <td style={TD}>{fmtDay(p.bought_on)}</td><td style={TD}>{p.supplier || "—"}</td><td style={TDR}>{num(p.litres)}</td><td style={TDR}>{rs(p.amount)}</td>
                  <td style={TDR}>{p.litres > 0 ? rs(Math.round((p.amount / p.litres) * 1000)) : "—"}</td><td style={TD}>{p.bill_no || "—"}</td><td style={{ ...TD, ...MUTED }}>{p.note || ""}</td>
                  <td style={{ ...TD, whiteSpace: "nowrap" }}>{canEdit && <>
                    <button type="button" style={{ padding: "3px 8px", fontSize: 11.5 }} onClick={() => setBuy({ ...p })}>Edit</button>{" "}
                    <button type="button" style={{ padding: "3px 8px", fontSize: 11.5 }} onClick={() => remove(p)}>Remove</button></>}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={panel("1 1 100%")}>
        <h2 style={H2}>Last six months</h2>
        <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 520, borderCollapse: "collapse", marginTop: 8 }}>
          <thead><tr><th style={TH}>Month</th><th style={{ ...TH, ...R }}>Used</th><th style={{ ...TH, ...R }}>Bought</th><th style={{ ...TH, ...R }}>Cost</th><th style={{ ...TH, ...R }}>Per kL used</th></tr></thead>
          <tbody>{d.trend.map((t) => (
            <tr key={t.month} style={{ fontWeight: t.month === month ? 700 : 400 }}>
              <td style={TD}>{monthName(t.month)}</td><td style={TDR}>{kl(t.used_l)}</td><td style={TDR}>{kl(t.bought_l)}</td><td style={TDR}>{rs(t.value)}</td>
              <td style={TDR}>{t.used_l > 0 ? rs(Math.round(t.value / (t.used_l / 1000))) : "—"}</td>
            </tr>))}
          </tbody>
        </table>
        </div>
      </section>

      {buy && <BuyModal p={buy} onClose={() => setBuy(null)} onDone={(m) => { setBuy(null); done(m); }} />}
      {rates && <RateModal s={s} onClose={() => setRates(false)} onDone={(m) => { setRates(false); done(m); }} />}
    </div>
  );
}

function BuyModal({ p, onClose, onDone }) {
  const [f, setF] = useState({ ...p, litres: p.litres ?? "", amount: p.amount ?? "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      if (p.id) await apiRequest(`/cost/water/purchases/${p.id}`, { method: "PUT", body: f });
      else await apiRequest("/cost/water/purchases", { method: "POST", body: f });
      onDone(p.id ? "Water bought — changed." : "Water bought — added.");
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }
  const lab = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 };
  const perKl = Number(f.litres) > 0 && f.amount !== "" ? Math.round((Number(f.amount) / Number(f.litres)) * 1000) : null;
  return (
    <Modal title={p.id ? "Change water bought" : "Add water bought"} onClose={onClose} width={560}>
      <form onSubmit={save} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <label style={lab}>Date bought<input type="date" max={istDay()} value={f.bought_on} onChange={set("bought_on")} required /></label>
        <label style={lab}>Supplier<input value={f.supplier || ""} onChange={set("supplier")} maxLength={120} placeholder="tanker owner" /></label>
        <label style={lab}>Litres<input inputMode="decimal" value={f.litres} onChange={set("litres")} required placeholder="e.g. 12000" /></label>
        <label style={lab}>Amount (₹, the bill)<input inputMode="decimal" value={f.amount} onChange={set("amount")} required /></label>
        <label style={lab}>Bill no.<input value={f.bill_no || ""} onChange={set("bill_no")} maxLength={60} /></label>
        <label style={lab}>Note<input value={f.note || ""} onChange={set("note")} maxLength={200} /></label>
        {perKl != null && <div style={{ ...MUTED, gridColumn: "1 / -1" }}>{rs(perKl)} per kilolitre</div>}
        {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, gridColumn: "1 / -1" }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, gridColumn: "1 / -1" }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}

function RateModal({ s, onClose, onDone }) {
  const [rate, setRate] = useState(s.own_rate_kl ?? "");
  const [note, setNote] = useState(s.own_note || "");
  const [changes, setChanges] = useState(s.rates.map((r) => ({ from_date: r.from_date, rate_kl: String(r.rate_kl), note: r.note || "" })));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr("");
    try {
      await apiRequest("/cost/water/settings", { method: "PUT", body: { own_rate_kl: rate === "" ? null : Number(rate), own_note: note,
        rates: changes.filter((c) => c.from_date && c.rate_kl !== "").map((c) => ({ ...c, rate_kl: Number(c.rate_kl) })) } });
      onDone("Own water rate saved.");
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  const lab = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, fontWeight: 600 };
  return (
    <Modal title="Own water rate" onClose={onClose} width={600}>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 10 }}>
        What the plant’s own water costs per kilolitre (1,000 litres) — borewell / well pumping power, maintenance, supply charges. Used for the water the batches use beyond what was bought.
        Example: a pump that costs ₹6,000 a month and gives about 600 kL → ₹10 per kL.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <label style={lab}>₹ per kilolitre<input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 10" /></label>
        <label style={lab}>How it was worked out (note)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></label>
      </div>
      <div style={{ ...MUTED, marginTop: 12 }}>Rate changes (optional) — a new rate from a date; months before it keep the old rate.</div>
      {changes.map((c, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input type="date" value={c.from_date} onChange={(e) => setChanges(changes.map((x, j) => (j === i ? { ...x, from_date: e.target.value } : x)))} aria-label="From" />
          <input inputMode="decimal" value={c.rate_kl} onChange={(e) => setChanges(changes.map((x, j) => (j === i ? { ...x, rate_kl: e.target.value } : x)))} style={{ width: 100 }} aria-label="₹ per kL" /> ₹/kL
          <input value={c.note} onChange={(e) => setChanges(changes.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} placeholder="note" style={{ flex: 1, minWidth: 120 }} aria-label="Note" />
          <button type="button" onClick={() => setChanges(changes.filter((_, j) => j !== i))} aria-label="Remove change">✕</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
        <button type="button" onClick={() => setChanges([...changes, { from_date: "", rate_kl: "", note: "" }])}>+ Rate change</button>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
      {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 10 }}>{err}</div>}
    </Modal>
  );
}
