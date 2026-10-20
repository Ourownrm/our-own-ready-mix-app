// Round 219 (owner, 20 Oct 2026: "better in cost dashboard if I can click and
// see how this cost is calculated and its details"). Each tile on the Cost
// dashboard opens this: the sum that makes the figure, step by step, then the
// entries behind it. Diesel is fetched line by line from /cost/fuel-detail;
// the others are already in the dashboard's own data.
import { useState } from "react";
import { Modal, useCostData, Loading, Note, lakh, rs, num, H2, MUTED, R, NUM, downloadExcel } from "./costUi.jsx";

const TITLES = {
  qty: "Sales quantity", sales: "Sales amount", rm_purchase: "Raw material purchase", rm_consumed: "Raw material consumption",
  fuel: "Diesel bought · issued", contribution: "Contribution", maintenance: "Maintenance", manpower: "Manpower",
};

// One line of a worked sum: "+ Label ........ value".
function Sum({ lines }) {
  return (
    <div style={{ background: "#F7F5F0", borderRadius: 8, padding: "10px 12px", fontSize: 13, ...NUM }}>
      {lines.map((l, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "4px 0",
          borderTop: l.total ? "1px solid var(--border-strong)" : undefined, marginTop: l.total ? 4 : 0, fontWeight: l.total ? 700 : 400 }}>
          <span>{l.sign ? <b style={{ display: "inline-block", width: 16 }}>{l.sign}</b> : null}{l.label}
            {l.hint && <span style={{ ...MUTED, marginLeft: 6 }}>{l.hint}</span>}</span>
          <span style={{ whiteSpace: "nowrap", color: l.bad ? "var(--alert-red)" : undefined }}>{l.value}</span>
        </div>
      ))}
    </div>
  );
}

function Section({ title, sub, children }) {
  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ ...H2, fontSize: 14 }}>{title}</h3>
      {sub && <div style={{ ...MUTED, marginTop: 2 }}>{sub}</div>}
      <div style={{ marginTop: 8 }}>{children}</div>
    </div>
  );
}

function Table({ head, rows, foot, minWidth = 560 }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ minWidth, fontSize: 12.5 }}>
        <thead><tr>{head.map((h, i) => <th key={i} style={h.r ? R : undefined}>{h.l}</th>)}</tr></thead>
        <tbody>{rows}</tbody>
        {foot && <tfoot>{foot}</tfoot>}
      </table>
    </div>
  );
}

const when = (ts) => (ts ? new Date(ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

export default function CostExplain({ kind, d, month, onClose }) {
  return (
    <Modal title={`How it’s worked out — ${TITLES[kind] || ""}, ${d.month_label}`} onClose={onClose} width={kind === "fuel" ? 1040 : 860}>
      {kind === "fuel" ? <FuelExplain month={month} d={d} /> : <Plain kind={kind} d={d} />}
    </Modal>
  );
}

// ------------------------------------------------------------------ fuel ---
function FuelExplain({ month, d }) {
  const { data: f, error } = useCostData(`/cost/fuel-detail?month=${month}`);
  const [tab, setTab] = useState("issued");
  if (!f) return <Loading error={error} />;
  const iss = f.issued, b = f.bought;
  const odd = [...iss.tank, ...iss.outside].filter((r) => r.odd_rate);
  const bigAdj = iss.adjustments.filter((a) => Math.abs(a.change) >= 500);
  const both = iss.adj_down_gross > 0 && iss.adj_up_gross > 0;

  function exportAll() {
    const fill = (r) => ({ Ref: r.ref, When: when(r.at), "Vehicle / machine": r.unit, Type: r.kind, Where: r.where, Litres: r.litres, "Rate (Rs/L)": r.rate ?? "", "Value (Rs)": r.value, "How valued": r.basis, By: r.by || "" });
    // downloadExcel takes { name, rows: [[header...], [values...]] } sheets.
    const sheet = (name, objs) => ({ name, rows: objs.length ? [Object.keys(objs[0]), ...objs.map((o) => Object.values(o))] : [["Nothing this month"]] });
    downloadExcel(`Fuel_cost_detail_${month}.xlsx`, [
      sheet("Issued from tank", iss.tank.map(fill)),
      sheet("Outside fills", iss.outside.map(fill)),
      sheet("Adjustments", iss.adjustments.map((a) => ({ Ref: a.ref, When: when(a.at), "Before (L)": a.before, "After (L)": a.after, "Change (L)": a.change, Note: a.note || "", By: a.by || "" }))),
      sheet("Tank deliveries", b.receipts.map((r) => ({ Ref: r.ref, When: when(r.at), Supplier: r.supplier, Litres: r.litres, "Rate (Rs/L)": r.rate ?? "", "Value (Rs)": r.value, By: r.by || "" }))),
    ]);
  }

  const fillRows = (list) => list.map((r) => (
    <tr key={r.ref} style={r.odd_rate ? { background: "var(--amber-bg)" } : undefined}>
      <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{r.ref}</td><td style={{ whiteSpace: "nowrap" }}>{when(r.at)}</td>
      <td><b>{r.unit}</b><div style={MUTED}>{r.kind}{r.outside ? ` · ${r.where}` : ""}</div></td>
      <td style={R}>{num(r.litres, 1)}</td><td style={R}>{r.rate != null ? `₹${num(r.rate, 2)}` : "—"}</td>
      <td style={{ ...R, fontWeight: 600 }}>{rs(r.value)}</td>
      <td style={{ ...MUTED, color: r.odd_rate ? "var(--alert-red)" : MUTED.color }}>{r.basis}{r.odd_rate ? " — rate far from the standing rate; check the amount" : ""}</td>
    </tr>
  ));
  const fillFoot = (list) => (
    <tr><td colSpan={3} style={{ fontWeight: 700 }}>{list.length} entr{list.length === 1 ? "y" : "ies"}</td>
      <td style={{ ...R, fontWeight: 700 }}>{num(list.reduce((t, r) => t + r.litres, 0), 1)}</td><td />
      <td style={{ ...R, fontWeight: 700 }}>{rs(list.reduce((t, r) => t + r.value, 0))}</td><td /></tr>
  );

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <div style={{ flex: "1 1 400px" }}>
          <div style={{ ...MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 6 }}>Issued — ₹{lakh(iss.total)} L</div>
          <Sum lines={[
            { sign: "", label: `Issued from the plant tank (${iss.tank.length})`, hint: `${num(iss.tank.reduce((t, r) => t + r.litres, 0))} L`, value: rs(iss.tank_value) },
            { sign: "+", label: `Outside-station fills (${iss.outside.length})`, hint: `${num(iss.outside.reduce((t, r) => t + r.litres, 0))} L`, value: rs(iss.outside_value) },
            { sign: "+", label: "Stock adjustments, net down", hint: iss.adj_out_litres > 0 ? `${num(iss.adj_out_litres)} L × ₹${num(f.rate, 2)}` : `net ${iss.adj_net >= 0 ? "up" : "down"} ${num(Math.abs(iss.adj_net))} L`, value: rs(iss.adj_value), bad: iss.adj_value > 0 },
            { total: true, label: "Diesel issued", value: rs(iss.total) },
          ]} />
        </div>
        <div style={{ flex: "1 1 400px" }}>
          <div style={{ ...MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 6 }}>Bought — ₹{lakh(b.total)} L</div>
          <Sum lines={[
            { sign: "", label: `Deliveries into the tank (${b.receipts.length})`, hint: `${num(b.receipts.reduce((t, r) => t + r.litres, 0))} L`, value: rs(b.tank_value) },
            { sign: "+", label: `Outside-station fills (${b.outside.length})`, hint: "bought and issued at once", value: rs(b.outside_value) },
            { total: true, label: "Diesel bought", value: rs(b.total) },
          ]} />
          <div style={{ ...MUTED, marginTop: 6 }}>Rate used where no amount was entered: {f.rate != null ? `₹${num(f.rate, 2)}/L` : "none"} — {f.rate_basis}.</div>
        </div>
      </div>

      {(both || bigAdj.length > 0 || odd.length > 0) && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {both && <Note>Adjustments this month went down {num(iss.adj_down_gross)} L and up {num(iss.adj_up_gross)} L. They are taken net, so a wrong count and its correction cancel out: net {iss.adj_net < 0 ? `down ${num(-iss.adj_net)} L, counted as issued` : `up ${num(iss.adj_net)} L, counted as stock added`}.</Note>}
          {odd.length > 0 && <Note>{odd.length} fill{odd.length === 1 ? "" : "s"} carr{odd.length === 1 ? "ies" : "y"} an amount far from the standing rate (highlighted) — usually a mistyped amount.</Note>}
        </div>
      )}

      <div className="no-print" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 16, alignItems: "center" }}>
        {[["issued", `Issued from tank (${iss.tank.length})`], ["outside", `Outside fills (${iss.outside.length})`], ["adjust", `Adjustments (${iss.adjustments.length})`], ["receipts", `Tank deliveries (${b.receipts.length})`]].map(([k, l]) => (
          <button key={k} type="button" className={`btn-tab${tab === k ? " active" : ""}`} onClick={() => setTab(k)}>{l}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={exportAll}>Export Excel</button>
      </div>

      <div style={{ marginTop: 10 }}>
        {tab === "issued" && (iss.tank.length ? (
          <Table head={[{ l: "Ref" }, { l: "Issued" }, { l: "Vehicle / machine" }, { l: "Litres", r: 1 }, { l: "Rate", r: 1 }, { l: "Value", r: 1 }, { l: "How valued" }]}
            rows={fillRows(iss.tank)} foot={fillFoot(iss.tank)} minWidth={820} />
        ) : <div style={MUTED}>Nothing issued from the tank this month.</div>)}
        {tab === "outside" && (iss.outside.length ? (
          <Table head={[{ l: "Ref" }, { l: "Filled" }, { l: "Vehicle / station" }, { l: "Litres", r: 1 }, { l: "Rate", r: 1 }, { l: "Value", r: 1 }, { l: "How valued" }]}
            rows={fillRows(iss.outside)} foot={fillFoot(iss.outside)} minWidth={820} />
        ) : <div style={MUTED}>No outside-station fills this month.</div>)}
        {tab === "adjust" && (iss.adjustments.length ? (
          <Table head={[{ l: "Ref" }, { l: "When" }, { l: "Book before → counted", r: 1 }, { l: "Change", r: 1 }, { l: "Reason · by" }]}
            minWidth={820}
            rows={iss.adjustments.map((a) => (
              <tr key={a.ref} style={Math.abs(a.change) >= 500 ? { background: "var(--amber-bg)" } : undefined}>
                <td style={{ fontWeight: 600 }}>{a.ref}</td><td style={{ whiteSpace: "nowrap" }}>{when(a.at)}</td>
                <td style={R}>{num(a.before)} → {num(a.after)}</td>
                <td style={{ ...R, fontWeight: 700, color: a.change < 0 ? "var(--alert-red)" : "var(--signal-green)" }}>{a.change > 0 ? "+" : "−"}{num(Math.abs(a.change))} L</td>
                <td style={MUTED}>{a.voided ? <b style={{ color: "var(--slate)" }}>Voided · </b> : a.entered != null ? `recalculated (entered ${a.entered > 0 ? "+" : ""}${num(a.entered)} L) · ` : ""}{a.note || "—"}{a.by ? ` · ${a.by}` : ""}</td>
              </tr>
            ))}
            foot={<tr><td colSpan={3} style={{ fontWeight: 700 }}>Down {num(iss.adj_down_gross)} L · up {num(iss.adj_up_gross)} L</td>
              <td style={{ ...R, fontWeight: 700 }}>{iss.adj_net > 0 ? "+" : iss.adj_net < 0 ? "−" : ""}{num(Math.abs(iss.adj_net))} L net</td>
              <td style={{ fontWeight: 700 }}>{iss.adj_value ? `${rs(iss.adj_value)} counted as issued` : iss.adj_net > 0 ? "counted as stock added" : ""}</td></tr>} />
        ) : <div style={MUTED}>No adjustments this month.</div>)}
        {tab === "receipts" && (b.receipts.length ? (
          <Table head={[{ l: "Ref" }, { l: "Received" }, { l: "Supplier" }, { l: "Litres", r: 1 }, { l: "Rate", r: 1 }, { l: "Value", r: 1 }, { l: "By" }]}
            rows={b.receipts.map((r) => (
              <tr key={r.ref}><td style={{ fontWeight: 600 }}>{r.ref}</td><td style={{ whiteSpace: "nowrap" }}>{when(r.at)}</td><td>{r.supplier}</td>
                <td style={R}>{num(r.litres)}</td><td style={R}>{r.rate != null ? `₹${num(r.rate, 2)}` : "—"}</td>
                <td style={{ ...R, fontWeight: 600 }}>{rs(r.value)}</td><td style={MUTED}>{r.by || "—"}</td></tr>
            ))}
            foot={<tr><td colSpan={3} style={{ fontWeight: 700 }}>{b.receipts.length} deliver{b.receipts.length === 1 ? "y" : "ies"}</td>
              <td style={{ ...R, fontWeight: 700 }}>{num(b.receipts.reduce((t, r) => t + r.litres, 0))}</td><td />
              <td style={{ ...R, fontWeight: 700 }}>{rs(b.tank_value)}</td><td /></tr>} />
        ) : <div style={MUTED}>No deliveries into the tank this month.</div>)}
      </div>
      <div style={{ ...MUTED, marginTop: 12, lineHeight: 1.5 }}>
        Tank book stock: {num(f.tank.opening)} L at the start → {num(f.tank.closing)} L at the end of the period
        ({d.is_current ? "month so far" : "whole month"}). A fill is valued at the amount entered for it; one with no amount at the standing diesel rate.
      </div>
    </div>
  );
}

// -------------------------------------------------- the other tiles ---
function Plain({ kind, d }) {
  const k = d.kpis, s = d.sales, qty = k.qty;
  const per = (v) => (qty ? `${rs(v / qty)} / m³` : "—");
  if (kind === "qty") {
    return (
      <>
        <Sum lines={[
          { label: `Concrete loaded on ${num(s.loads)} delivery notes`, value: `${num(s.qty + s.rejected_m3, 1)} m³` },
          { sign: "−", label: "Rejected at site (site QC)", value: `${num(s.rejected_m3, 1)} m³` },
          { total: true, label: "Sales quantity", value: `${num(s.qty, 1)} m³` },
        ]} />
        <Section title="Of which">
          <Sum lines={[
            { label: "Invoiced", value: `${num(s.invoiced_m3, 1)} m³` },
            { label: `Held — no price yet (${num(s.held_loads)} loads)`, hint: "counted in quantity, not in sales amount", value: `${num(s.held_m3, 1)} m³`, bad: s.held_m3 > 0 },
            { label: "Pumped", value: `${num(s.pumped_m3, 1)} m³` },
          ]} />
        </Section>
        <div style={{ ...MUTED, marginTop: 10 }}>Delivery notes dated in the month, cancelled ones left out; loads Admin omitted (JCB / no vehicle) are not delivery notes and are not counted.</div>
      </>
    );
  }
  if (kind === "sales") {
    return (
      <>
        <Sum lines={[
          { label: `Concrete on the tax invoices of ${num(s.invoiced_m3, 1)} m³`, hint: "GST taken out: total × 100 / 118", value: rs(s.concrete) },
          { total: true, label: "Sales amount (tile)", value: rs(k.sales) },
          { label: "÷ invoiced m³ = realisation", value: `${rs(s.realisation)} / m³` },
        ]} />
        <Section title="Not in the tile, on the same invoices" sub="shown in the Profit & Loss as their own lines">
          <Sum lines={[
            { label: "Pumping charges", value: rs(s.pumping) },
            { label: "Part-load & waiting charges", value: rs(s.part_load) },
            { label: "Invoice totals incl. GST", value: rs(s.gross) },
          ]} />
        </Section>
        {s.held_m3 > 0 && <div style={{ marginTop: 10 }}><Note>{num(s.held_m3, 1)} m³ on {num(s.held_loads)} loads has no price yet, so no invoice — not in this amount.</Note></div>}
      </>
    );
  }
  if (kind === "rm_purchase" || kind === "rm_consumed") {
    const rows = d.raw_material.rows;
    const cons = kind === "rm_consumed";
    return (
      <>
        <Sum lines={cons ? [
          { label: "Each material: kg used by the plant × its weighted-average rate for the month", value: "" },
          { total: true, label: "Raw material consumed", value: rs(d.raw_material.consumed) },
          { label: "÷ sales m³", value: per(d.raw_material.consumed) },
        ] : [
          { label: "Each material: kg accepted on Raw Material receipts × landed rate", value: "" },
          { total: true, label: "Raw material purchased", value: rs(d.raw_material.purchased) },
          { label: "Stock change (bought − used)", value: rs(d.raw_material.purchased - d.raw_material.consumed) },
        ]} />
        <Section title="By material">
          <Table head={[{ l: "Material" }, { l: "Bought kg", r: 1 }, { l: "Bought ₹", r: 1 }, { l: "Used kg", r: 1 }, { l: "Rate ₹/kg", r: 1 }, { l: "Used ₹", r: 1 }, { l: "₹ / m³", r: 1 }]}
            rows={rows.map((r) => (
              <tr key={r.material_id}><td style={{ fontWeight: 600 }}>{r.name}{r.no_rate && <div style={{ ...MUTED, color: "var(--alert-red)" }}>no rate — not valued</div>}</td>
                <td style={R}>{num(r.purchase_kg)}</td><td style={R}>{rs(r.purchase)}</td><td style={R}>{num(r.consumed_kg)}</td>
                <td style={R}>{r.rate != null ? num(r.rate, 3) : "—"}</td><td style={{ ...R, fontWeight: 600 }}>{rs(r.consumed)}</td>
                <td style={R}>{cons ? num(r.consumed_m3) : num(r.purchase_m3)}</td></tr>
            ))}
            foot={<tr><td style={{ fontWeight: 700 }}>Total</td><td /><td style={{ ...R, fontWeight: 700 }}>{rs(d.raw_material.purchased)}</td><td /><td />
              <td style={{ ...R, fontWeight: 700 }}>{rs(d.raw_material.consumed)}</td><td /></tr>} minWidth={680} />
        </Section>
      </>
    );
  }
  if (kind === "contribution") {
    return (
      <>
        <Sum lines={[
          { label: "Sales amount", value: rs(k.sales) },
          { sign: "−", label: "Raw material consumed", value: rs(k.rm_consumed) },
          { sign: "−", label: "Diesel issued", hint: "open the Diesel tile for every entry", value: rs(k.fuel_issued) },
          { total: true, label: "Contribution", value: rs(k.contribution), bad: k.contribution < 0 },
          { label: "÷ sales m³", value: per(k.contribution) },
        ]} />
        <div style={{ ...MUTED, marginTop: 10 }}>Pumping and part-load income, power, maintenance and manpower are not in this figure — the Profit & Loss carries them.</div>
      </>
    );
  }
  if (kind === "maintenance") {
    const m = d.maintenance, t = m.totals;
    return (
      <>
        <Sum lines={[
          { label: "Parts issued to job cards", hint: "store, at average rate", value: rs(t.parts) },
          { sign: "+", label: "Outside repairs", hint: "final amount, month returned", value: rs(t.outside) },
          { sign: "+", label: "Lubricants", hint: "general-works cards", value: rs(t.lubricant) },
          { sign: "+", label: "Tyres, batteries & retreads", hint: "not bought through the store", value: rs(t.tyres) },
          { total: true, label: "Maintenance", value: rs(t.total) },
        ]} />
        <Section title="By vehicle / machine">
          {m.vehicles.length ? (
            <Table head={[{ l: "Vehicle" }, { l: "Cards", r: 1 }, { l: "Parts", r: 1 }, { l: "Outside", r: 1 }, { l: "Lubricants", r: 1 }, { l: "Tyres", r: 1 }, { l: "Total", r: 1 }]}
              rows={m.vehicles.map((v) => (
                <tr key={v.asset_id || 0}><td style={{ fontWeight: 600 }}>{v.name}<div style={MUTED}>{[v.group, v.model].filter(Boolean).join(" · ")}</div></td>
                  <td style={R}>{num(v.cards)}</td><td style={R}>{rs(v.parts)}</td><td style={R}>{rs(v.outside)}</td><td style={R}>{rs(v.lubricant)}</td>
                  <td style={R}>{rs(v.tyres)}</td><td style={{ ...R, fontWeight: 700 }}>{rs(v.amount)}</td></tr>
              ))} minWidth={680} />
          ) : <div style={MUTED}>No maintenance cost this month.</div>}
        </Section>
      </>
    );
  }
  if (kind === "manpower") {
    const m = d.manpower;
    return (
      <>
        <Sum lines={[
          { label: `Staff — HR payroll, cost to company (${m.staff_count})`, hint: m.payroll_status === "locked" ? "payroll locked" : m.payroll_status === "draft" ? "payroll not locked yet" : "no payroll yet", value: rs(m.staff), bad: m.payroll_status !== "locked" },
          { sign: "+", label: "Pump gangs", hint: "approved contractor bills, else closed gang months", value: rs(m.gangs) },
          { sign: "+", label: "Other contract labour", value: rs(m.contract) },
          { total: true, label: "Manpower", value: rs(m.total) },
        ]} />
        <Section title="Inside the staff figure">
          <Sum lines={[
            { label: "Sales incentive", value: rs(m.incentive) },
            { label: "Trip allowance", value: rs(m.trip) },
            { label: "Overtime", value: rs(m.overtime) },
            { label: "Employer PF / ESI / bonus / gratuity", value: rs(m.employer) },
          ]} />
        </Section>
        {m.bills_draft > 0 && <div style={{ marginTop: 10 }}><Note>{m.bills_draft} contractor bill(s) not approved — payroll and closed gang months are used until they are.</Note></div>}
      </>
    );
  }
  return null;
}

