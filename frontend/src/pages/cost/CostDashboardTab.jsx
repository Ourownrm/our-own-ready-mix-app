// Round 218 — Cost dashboard (owner's mock-up "Monthly Cost Dashboard",
// revised 20 Oct 2026). Every per-m³ figure is on SALES quantity.
import {
  useCostData, Loading, MonthSelect, Actions, BTN, Tile, Tone, Swatch, Note, Bar, downloadExcel,
  lakh, rsL, rs, num, pct, signed, C, H2, SUB, MUTED, R, NUM, GRID, ROW, panel, fmtDay,
} from "./costUi.jsx";

function pctChange(now, before) {
  if (now == null || !before) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

export default function CostDashboardTab({ month, setMonth }) {
  const { data: d, error } = useCostData(`/cost/dashboard?month=${month}`);
  const head = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 14 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Cost Dashboard — {d && d.month === month ? d.month_label : "Monthly"}</h1>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4 }}>
          All per m³ figures are on <b style={{ color: "var(--charcoal)" }}>sales quantity</b> · amounts excl. GST · loads Admin omitted (JCB / no vehicle) are left out
          {d?.is_current && <> · <b style={{ color: "var(--amber)" }}>month so far, to {fmtDay(d.as_of)}</b></>}
        </div>
      </div>
      <Actions>
        <MonthSelect value={month} onChange={setMonth} />
        <button type="button" style={BTN} disabled={!d} onClick={() => exportDashboard(d)}>Export Excel</button>
        <button type="button" className="btn-primary" style={BTN} onClick={() => window.print()}>Print / PDF</button>
      </Actions>
    </div>
  );
  if (!d || d.month !== month) return <>{head}<div style={{ marginTop: 16 }}><Loading error={error} /></div></>;

  const k = d.kpis, p = d.per_m3;
  const qtyCh = pctChange(k.qty, k.prev_qty);
  const realCh = pctChange(k.realisation, k.prev_realisation);
  const rmCh = pctChange(p.rm, k.prev_rm_m3);
  const fuelCh = pctChange(p.fuel, k.prev_fuel_m3);
  const conCh = pctChange(p.contribution, k.prev_contribution_m3);
  const mntCh = pctChange(k.maintenance, k.prev_maintenance);
  const manCh = pctChange(p.manpower, k.prev_manpower_m3);
  const stockDelta = k.rm_purchase - k.rm_consumed;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {head}
      {k.qty === 0 && <Note>No delivery tickets in {d.month_label}. Pick another month.</Note>}

      <div style={GRID(200)}>
        <Tile label="Sales quantity" value={`${num(k.qty, 1)} m³`} sub={`${num(d.ops.loads)} loads · ${num(d.ops.avg_load, 1)} m³ avg`}
          delta={qtyCh == null ? null : signed(qtyCh)} good={qtyCh == null ? null : qtyCh >= 0} note={`vs ${num(k.prev_qty, 1)} m³ in ${d.prev_label}`} />
        <Tile label="Sales amount" value={rsL(k.sales)} sub={`${rs(k.realisation)} / m³`}
          delta={realCh == null ? null : `${signed(realCh)} /m³`} good={realCh == null ? null : realCh >= 0} note="realisation, invoices excl. GST" />
        <Tile label="RM purchase" value={rsL(k.rm_purchase)} sub={`${rs(k.qty ? k.rm_purchase / k.qty : null)} / m³`}
          delta={`${stockDelta >= 0 ? "+" : "−"}₹${lakh(Math.abs(stockDelta))} L stock`} good={null}
          note={stockDelta >= 0 ? "bought more than used" : "used more than bought"} />
        <Tile label="RM consumption" value={rsL(k.rm_consumed)} sub={`${rs(p.rm)} / m³`}
          delta={rmCh == null ? null : `${signed(rmCh)} /m³`} good={rmCh == null ? null : rmCh <= 0} note={k.prev_rm_m3 ? `vs ${rs(k.prev_rm_m3)} in ${d.prev_label}` : null} />
        <Tile label="Diesel bought · issued" value={`₹${lakh(k.fuel_bought)} · ₹${lakh(k.fuel_issued)} L`}
          sub={`${rs(k.qty ? k.fuel_bought / k.qty : null)} · ${rs(p.fuel)} / m³`}
          delta={fuelCh == null ? null : `${signed(fuelCh)} /m³`} good={fuelCh == null ? null : fuelCh <= 0} note="incl. outside fills" />
        <Tile label="Contribution" value={rsL(k.contribution)} sub={`${rs(p.contribution)} / m³ · ${pct(k.sales ? (k.contribution / k.sales) * 100 : null)}`}
          delta={conCh == null ? null : `${signed(conCh)} /m³`} good={conCh == null ? null : conCh >= 0} note="sales − RM − fuel" />
        <Tile label="Maintenance" value={rsL(k.maintenance)} sub={`${rs(p.maintenance)} / m³`}
          delta={mntCh == null ? null : signed(mntCh)} good={mntCh == null ? null : mntCh <= 0} note={`job cards · ${d.prev_label} ₹${lakh(k.prev_maintenance)} L`} />
        <Tile label="Manpower" value={rsL(k.manpower)} sub={`${rs(p.manpower)} / m³`}
          delta={manCh == null ? null : `${signed(manCh)} /m³`} good={manCh == null ? null : manCh <= 0} note="payroll + contractor bills" />
      </div>

      <div style={ROW}>
        <WhereItGoes d={d} />
        <Trend d={d} />
      </div>

      <RawMaterial d={d} />

      <div style={ROW}>
        <Recipe d={d} />
        <Grades d={d} />
      </div>

      <div style={ROW}>
        <Diesel d={d} />
        <FuelConsumers d={d} />
      </div>

      <div style={ROW}>
        <Maintenance d={d} />
        <Manpower d={d} />
      </div>

      <Ops d={d} />

      <div style={{ ...MUTED, lineHeight: 1.6 }}>
        Sources: Sales — tax invoices (one per delivery note), GST taken out (rate × 100 / 118; the total itself when GST is switched off) ·
        RM purchase — Raw Material receipts at landed rate · RM consumption — plant batch weights (hand-keyed before Sept 2026) × the month’s weighted average rate,
        shared silos first in, first out · Fuel — Fuel module: tank issues, outside-station fills, adjustments down ·
        Maintenance — Maintenance module job cards · Manpower — HR payroll and approved contractor bills.
        Accounts → Settings → Costing reads the same material, fuel and salary per m³ when it proposes a quotation rate.
      </div>
    </div>
  );
}

function WhereItGoes({ d }) {
  const p = d.per_m3;
  const real = p.realisation || 0;
  const left = real ? real - (p.rm || 0) - (p.fuel || 0) - (p.maintenance || 0) - (p.manpower || 0) : null;
  const parts = [
    ["Raw material", p.rm, C.rm], ["Fuel issued", p.fuel, C.fuel], ["Maintenance", p.maintenance, C.mnt],
    ["Manpower", p.manpower, C.man], ["Left after these", left, C.left],
  ];
  const share = (v) => (real > 0 && v != null ? (v / real) * 100 : 0);
  const prevCon = d.kpis.prev_contribution_m3;
  const rmUp = d.kpis.prev_rm_m3 ? p.rm - d.kpis.prev_rm_m3 : null;
  return (
    <div style={panel("1 1 420px")}>
      <h2 style={H2}>Where each m³ of sale goes</h2>
      <div style={SUB}>Realisation {rs(real)} / m³ — {d.month_label}</div>
      <div role="img" aria-label={parts.map(([l, v]) => `${l} ${num(v)}`).join(", ")}
        style={{ display: "flex", height: 34, borderRadius: 6, overflow: "hidden", marginTop: 18, gap: 2, background: "var(--concrete)" }}>
        {parts.map(([l, v, c]) => (share(v) > 0 ? <div key={l} style={{ width: `${share(v)}%`, background: c }} /> : null))}
      </div>
      <div style={{ ...GRID(105), marginTop: 14 }}>
        {parts.map(([l, v, c]) => (
          <div key={l}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, ...MUTED }}><Swatch c={c} />{l}</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2, ...NUM, color: v < 0 ? "var(--alert-red)" : undefined }}>{rs(v)}</div>
            <div style={{ ...MUTED, ...NUM }}>{real ? pct(share(v)) : "—"}</div>
          </div>
        ))}
      </div>
      <div style={{ ...MUTED, marginTop: 10 }}>Contribution after material and fuel only: {rs(p.contribution)} / m³{prevCon != null ? ` (${d.prev_label} ${rs(prevCon)})` : ""}.</div>
      {rmUp != null && Math.abs(rmUp) >= 1 && (
        <div style={{ marginTop: 12 }}>
          <Note tone={rmUp > 0 ? "warn" : "good"}>
            <b>{rmUp > 0 ? "Watch:" : "Good:"}</b> raw material per m³ {rmUp > 0 ? "rose" : "fell"} {rs(Math.abs(rmUp))} vs {d.prev_label}.
            {d.recipe.length > 0 && <> Batch weights against the recipe added {rs(d.kpis.qty ? d.recipe.reduce((t, r) => t + (r.impact || 0), 0) / d.kpis.qty : null)} / m³.</>}
          </Note>
        </div>
      )}
    </div>
  );
}

function Trend({ d }) {
  const scale = 170 / Math.max(1, ...d.trend.map((t) => t.realisation || 0), ...d.trend.map((t) => (t.rm || 0) + (t.fuel || 0) + Math.max(0, t.contribution || 0)));
  return (
    <div style={panel("1.4 1 520px")}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <h2 style={H2}>6-month trend — ₹ per m³</h2>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", ...MUTED }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Swatch c={C.rm} />RM</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Swatch c={C.fuel} />Fuel</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Swatch c={C.left} />Contribution</span>
        </div>
      </div>
      <div role="img" aria-label={d.trend.map((t) => `${t.label}: realisation ${num(t.realisation)}, raw material ${num(t.rm)}, fuel ${num(t.fuel)}`).join("; ")}
        style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12, marginTop: 16, alignItems: "end" }}>
        {d.trend.map((t, i) => (
          <div key={t.month} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, ...NUM }}>{t.realisation ? rs(t.realisation) : "—"}</div>
            <div style={{ width: "100%", maxWidth: 64, height: 180, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 2 }}>
              {t.qty > 0 && <>
                <div style={{ height: Math.max(0, Math.round((t.contribution || 0) * scale)), background: C.left, borderRadius: "4px 4px 0 0" }} />
                <div style={{ height: Math.max(3, Math.round((t.fuel || 0) * scale)), background: C.fuel }} />
                <div style={{ height: Math.round((t.rm || 0) * scale), background: C.rm }} />
              </>}
            </div>
            <div style={{ fontSize: 12, fontWeight: i === d.trend.length - 1 ? 700 : 400 }}>{t.label}</div>
            <div style={{ fontSize: 11, color: "var(--slate)", ...NUM }}>{t.qty ? `${num(t.qty)} m³` : "no sales"}</div>
          </div>
        ))}
      </div>
      <div style={{ ...MUTED, marginTop: 10 }}>Bar top = realisation per m³. Volume under each month is sales quantity.</div>
    </div>
  );
}

function RawMaterial({ d }) {
  const rm = d.raw_material;
  const q = d.kpis.qty;
  const max = Math.max(1, ...rm.rows.map((r) => r.consumed_m3 || 0));
  const totCh = d.kpis.prev_rm_m3 ? d.per_m3.rm - d.kpis.prev_rm_m3 : null;
  return (
    <div style={panel("1 1 100%")}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <h2 style={H2}>Raw material — purchase vs consumption</h2>
        <div style={MUTED}>Consumption at weighted average rate · shared silos first in, first out by brand · Stock Δ = purchase − consumption</div>
      </div>
      {rm.no_rate.length > 0 && <div style={{ marginTop: 8 }}><Note>No rate yet for {rm.no_rate.join(", ")} — its consumption is not valued.</Note></div>}
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ minWidth: 860 }}>
          <thead><tr><th>Material</th><th style={R}>Purchase ₹ L</th><th style={R}>Purchase ₹/m³</th><th style={R}>Consumed</th><th style={R}>Consumption ₹ L</th>
            <th style={R}>Consumption ₹/m³</th><th style={{ minWidth: 140 }}>Share of RM cost</th><th style={R}>vs {d.prev_label} (₹/m³)</th><th style={R}>Stock Δ ₹ L</th></tr></thead>
          <tbody>
            {rm.rows.length === 0 && <tr><td colSpan={9} style={{ color: "var(--slate)" }}>No receipts or consumption this month.</td></tr>}
            {rm.rows.map((r) => {
              const ch = r.prev_m3 ? r.consumed_m3 - r.prev_m3 : null;
              const share = rm.consumed ? (r.consumed / rm.consumed) * 100 : 0;
              return (
                <tr key={r.material_id}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td style={R}>{lakh(r.purchase)}</td>
                  <td style={R}>{num(r.purchase_m3)}</td>
                  <td style={R}>{num(r.consumed_kg / 1000, 1)} t</td>
                  <td style={R}>{lakh(r.consumed)}</td>
                  <td style={{ ...R, fontWeight: 700 }}>{num(r.consumed_m3)}</td>
                  <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Bar value={r.consumed_m3 || 0} max={max} color={C.rm} /><span style={{ ...MUTED, width: 42, textAlign: "right", ...NUM }}>{pct(share)}</span></div></td>
                  <td style={{ ...R, fontWeight: 600, color: ch == null ? "var(--slate)" : ch > 0 ? "var(--alert-red)" : "var(--signal-green)" }}>
                    {ch == null ? "—" : `${signed(ch, 0, "")} (${signed((ch / r.prev_m3) * 100)})`}</td>
                  <td style={R}>{signed(r.stock_change / 100000, 2, "")}</td>
                </tr>
              );
            })}
          </tbody>
          {rm.rows.length > 0 && (
            <tfoot><tr style={{ fontWeight: 700 }}>
              <td style={{ fontWeight: 700 }}>Total</td><td style={R}>{lakh(rm.purchased)}</td><td style={R}>{num(q ? rm.purchased / q : null)}</td><td />
              <td style={R}>{lakh(rm.consumed)}</td><td style={R}>{num(d.per_m3.rm)}</td><td />
              <td style={{ ...R, color: totCh == null ? undefined : totCh > 0 ? "var(--alert-red)" : "var(--signal-green)" }}>{totCh == null ? "—" : `${signed(totCh, 0, "")} (${signed((totCh / d.kpis.prev_rm_m3) * 100)})`}</td>
              <td style={R}>{signed((rm.purchased - rm.consumed) / 100000, 2, "")}</td>
            </tr></tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function Recipe({ d }) {
  const total = d.recipe.reduce((t, r) => t + (r.impact || 0), 0);
  return (
    <div style={panel("1 1 480px")}>
      <h2 style={H2}>Recipe vs actual consumption</h2>
      <div style={SUB}>Recipe = MCI370 design kg/m³ × batched m³ · Actual = load-cell batch weights</div>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ minWidth: 440 }}>
          <thead><tr><th>Material</th><th style={R}>Recipe</th><th style={R}>Actual</th><th style={R}>Variance</th><th style={R}>₹ impact</th></tr></thead>
          <tbody>
            {d.recipe.length === 0 && <tr><td colSpan={5} style={{ color: "var(--slate)" }}>No batch weights from the plant this month.</td></tr>}
            {d.recipe.map((r) => {
              const t = r.diff_pct == null ? null : Math.abs(r.diff_pct) <= 1 ? null : r.diff_pct < 0;
              const unit = r.recipe_kg >= 10000 ? "t" : "kg";
              const f = (kg) => (unit === "t" ? `${num(kg / 1000, 1)} t` : `${num(kg)} kg`);
              return (
                <tr key={r.material_id}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td style={R}>{f(r.recipe_kg)}</td>
                  <td style={R}>{f(r.actual_kg)}</td>
                  <td style={R}><Tone good={t}>{signed(r.diff_pct, 2)}</Tone></td>
                  <td style={R}>{r.impact == null ? "—" : `${r.impact >= 0 ? "+" : "−"}₹${lakh(Math.abs(r.impact))} L`}</td>
                </tr>
              );
            })}
          </tbody>
          {d.recipe.length > 0 && (
            <tfoot><tr><td colSpan={4} style={{ fontWeight: 700 }}>Net {total >= 0 ? "excess" : "saving"}</td>
              <td style={{ ...R, fontWeight: 700, color: total > 0 ? "var(--alert-red)" : "var(--signal-green)" }}>
                {`${total >= 0 ? "+" : "−"}₹${lakh(Math.abs(total))} L · ${rs(d.kpis.qty ? Math.abs(total) / d.kpis.qty : null)}/m³`}</td></tr></tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function Grades({ d }) {
  return (
    <div style={panel("1.2 1 560px")}>
      <h2 style={H2}>Grade-wise sales &amp; contribution</h2>
      <div style={SUB}>By grade and priced mix design · RM at the design’s recipe × this month’s rates · fuel at the plant average {rs(d.per_m3.fuel)}/m³</div>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ minWidth: 640 }}>
          <thead><tr><th>Grade · mix design</th><th style={R}>Qty m³</th><th style={R}>Mix</th><th style={R}>Rate ₹/m³</th><th style={R}>RM ₹/m³</th>
            <th style={R}>Fuel ₹/m³</th><th style={R}>Contrib. ₹/m³</th><th style={R}>Margin</th></tr></thead>
          <tbody>
            {d.grades.length === 0 && <tr><td colSpan={8} style={{ color: "var(--slate)" }}>No deliveries this month.</td></tr>}
            {d.grades.map((g, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 600 }}>{g.grade}<div style={{ ...MUTED, fontWeight: 400 }}>{g.design}</div></td>
                <td style={R}>{num(g.qty, 1)}</td>
                <td style={R}>{pct(g.mix)}</td>
                <td style={R}>{g.rate == null ? <span style={MUTED}>not invoiced</span> : num(g.rate)}</td>
                <td style={R}>{g.rm == null ? "—" : num(g.rm)}{g.rm_partial ? " *" : ""}</td>
                <td style={R}>{num(g.fuel)}</td>
                <td style={{ ...R, fontWeight: 700, color: g.contribution < 0 ? "var(--alert-red)" : "var(--signal-green)" }}>{num(g.contribution)}</td>
                <td style={R}>{pct(g.margin)}</td>
              </tr>
            ))}
          </tbody>
          {d.grades.length > 0 && (
            <tfoot><tr style={{ fontWeight: 700 }}>
              <td style={{ fontWeight: 700 }}>Total</td><td style={R}>{num(d.kpis.qty, 1)}</td><td style={R}>100%</td><td style={R}>{num(d.per_m3.realisation)}</td>
              <td style={R}>{num(d.per_m3.rm)}</td><td style={R}>{num(d.per_m3.fuel)}</td><td style={{ ...R, color: "var(--signal-green)" }}>{num(d.per_m3.contribution)}</td>
              <td style={R}>{pct(d.per_m3.realisation ? (d.per_m3.contribution / d.per_m3.realisation) * 100 : null)}</td>
            </tr></tfoot>
          )}
        </table>
      </div>
      {d.grades.some((g) => g.rm_partial) && <div style={{ ...MUTED, marginTop: 6 }}>* a component of that design was not consumed this month, so it has no rate here.</div>}
      <div style={{ ...MUTED, marginTop: 6 }}>Total row: material is the actual consumption, not the recipe.</div>
    </div>
  );
}

function Diesel({ d }) {
  const t = d.fuel.tank, f = d.fuel;
  const rows = [
    ["Bought / added", t.received, t.outside.litres, t.adj_in, t.purchased_total + t.adj_in],
    ["Issued", t.issued, t.outside.litres, t.adj_out, t.issued_total],
  ];
  const level = f.capacity_l ? Math.round((t.closing / f.capacity_l) * 100) : null;
  return (
    <div style={panel("1 1 380px")}>
      <h2 style={H2}>Diesel — bought, issued, in the tank</h2>
      <div style={SUB}>Fuel module{f.capacity_l ? ` · plant tank ${num(f.capacity_l)} L` : ""} · book stock, no dip readings</div>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ minWidth: 340 }}>
          <thead><tr><th>Litres</th><th style={R}>Into tank</th><th style={R}>Outside</th><th style={R}>Adj.</th><th style={R}>Total</th></tr></thead>
          <tbody>
            {rows.map(([l, a, b, c, tot]) => (
              <tr key={l}><td style={{ fontWeight: 600 }}>{l}</td><td style={R}>{num(a)}</td><td style={R}>{num(b)}</td><td style={R}>{num(c)}</td><td style={{ ...R, fontWeight: 700 }}>{num(tot)}</td></tr>
            ))}
            <tr><td style={MUTED}>Value ₹ L</td><td style={{ ...R, ...MUTED }}>{lakh(t.received_value)} · {lakh(t.issued_value)}</td>
              <td style={{ ...R, ...MUTED }}>{lakh(t.outside.value)}</td><td style={{ ...R, ...MUTED }}>{lakh(f.adj_value)}</td>
              <td style={{ ...R, ...MUTED }}>{lakh(f.bought_value)} · {lakh(f.issued_value)}</td></tr>
          </tbody>
        </table>
      </div>
      <div style={{ ...MUTED, marginTop: 8, lineHeight: 1.5 }}>Outside-station fills count as bought and issued at once and never go through the tank. An adjustment down counts as issued; one up as added.</div>
      <div style={{ ...GRID(150), marginTop: 12 }}>
        <div><div style={{ ...MUTED, textTransform: "uppercase", letterSpacing: 0.4 }}>Tank opening → closing</div>
          <div style={{ fontSize: 18, fontWeight: 700, ...NUM }}>{num(t.opening)} → {num(t.closing)} L</div>
          <div style={{ ...MUTED, ...NUM }}>{rsL(t.closing * (f.rate || 0))} in stock at {rs(f.rate)}/L</div></div>
        <div><div style={{ ...MUTED, textTransform: "uppercase", letterSpacing: 0.4 }}>Outside fills open now</div>
          <div style={{ fontSize: 18, fontWeight: 700, ...NUM, color: f.open_outside_fills ? "var(--amber)" : undefined }}>{num(f.open_outside_fills)}</div>
          <div style={MUTED}>{num(t.outside.fills)} closed this month</div></div>
      </div>
      {level != null && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", ...MUTED }}><span>Closing tank level (book)</span><span style={NUM}>{level}%</span></div>
          <div style={{ height: 10, borderRadius: 5, background: "var(--concrete)", overflow: "hidden", marginTop: 5 }}>
            <div style={{ width: `${Math.min(100, Math.max(0, level))}%`, height: "100%", background: C.fuel, borderRadius: 5 }} /></div>
        </div>
      )}
    </div>
  );
}

function FuelConsumers({ d }) {
  const f = d.fuel;
  const tl = f.consumers.reduce((t, c) => t + c.litres, 0);
  return (
    <div style={panel("1.6 1 560px")}>
      <h2 style={H2}>Fuel issue by consumer</h2>
      <div style={SUB}>Plant tank and outside-station fills together · efficiency on each consumer’s own driver — loads, pumped m³ or m³ made</div>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ minWidth: 600 }}>
          <thead><tr><th>Consumer</th><th style={R}>Litres</th><th style={R}>₹ L</th><th style={R}>₹/m³ sold</th><th style={R}>Efficiency</th><th style={R}>vs {d.prev_label} /m³</th></tr></thead>
          <tbody>
            {f.consumers.length === 0 && <tr><td colSpan={6} style={{ color: "var(--slate)" }}>No fuel issued this month.</td></tr>}
            {f.consumers.map((c) => (
              <tr key={c.kind}>
                <td style={{ fontWeight: 600 }}>{c.label}
                  <div style={{ ...MUTED, fontWeight: 400 }}>{c.note || [c.units ? `${c.units} unit${c.units === 1 ? "" : "s"}` : null, c.efficiency?.sub, c.outside_litres ? `incl. ${num(c.outside_litres)} L outside fills` : null].filter(Boolean).join(" · ")}</div></td>
                <td style={R}>{num(c.litres)}</td>
                <td style={R}>{lakh(c.value)}</td>
                <td style={{ ...R, fontWeight: 700 }}>{num(c.per_m3)}</td>
                <td style={R}>{c.efficiency ? `${num(c.efficiency.value, 2)} ${c.efficiency.unit}` : "—"}</td>
                <td style={{ ...R, fontWeight: 600, color: c.change_pct == null ? "var(--slate)" : c.change_pct > 0 ? "var(--alert-red)" : "var(--signal-green)" }}>{signed(c.change_pct)}</td>
              </tr>
            ))}
          </tbody>
          {f.consumers.length > 0 && (
            <tfoot><tr><td style={{ fontWeight: 700 }}>Total issued</td><td style={{ ...R, fontWeight: 700 }}>{num(tl)}</td><td style={{ ...R, fontWeight: 700 }}>{lakh(f.issued_value)}</td>
              <td style={{ ...R, fontWeight: 700 }}>{num(d.per_m3.fuel)}</td><td style={{ ...R, fontWeight: 700 }}>{d.kpis.qty ? `${num(tl / d.kpis.qty, 2)} L / m³` : "—"}</td>
              <td style={{ ...R, fontWeight: 700 }}>{signed(pctChange(d.per_m3.fuel, f.prev_per_m3))}</td></tr></tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function Maintenance({ d }) {
  const m = d.maintenance;
  const parts = [["parts", "Parts issued", "store, at average rate"], ["outside", "Outside repairs", "final amount, month returned"],
    ["lubricant", "Lubricants", "general-works cards"], ["tyres", "Tyres & batteries", "not bought through the store"]];
  const cards = m.vehicles.reduce((t, v) => t + v.cards, 0);
  return (
    <div style={panel("1.3 1 560px")}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <h2 style={H2}>Maintenance — from job cards</h2>
        <div style={{ fontSize: 13, fontWeight: 700, ...NUM }}>{rsL(m.totals.total)} · {rs(d.per_m3.maintenance)} / m³</div>
      </div>
      <div style={SUB}>Maintenance module: parts issued, outside repairs at final bill, lubricants on each vehicle’s general-works card, tyres &amp; batteries</div>
      <div style={{ ...GRID(130), marginTop: 12 }}>
        {parts.map(([key, l, s]) => (
          <div key={key} style={{ background: "#F7F5F0", borderRadius: 8, padding: 10 }}>
            <div style={{ ...MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 }}>{l}</div>
            <div style={{ fontSize: 18, fontWeight: 700, ...NUM }}>{rsL(m.totals[key])}</div>
            <div style={{ ...MUTED, fontSize: 11 }}>{s}</div>
          </div>
        ))}
      </div>
      <div style={{ overflowX: "auto", marginTop: 12 }}>
        <table style={{ minWidth: 520 }}>
          <thead><tr><th>Vehicle / machine</th><th style={R}>Job cards</th><th style={R}>₹ L</th><th style={R}>Per unit of work</th><th style={R}>This FY ₹ L</th></tr></thead>
          <tbody>
            {m.vehicles.length === 0 && <tr><td colSpan={5} style={{ color: "var(--slate)" }}>No maintenance cost this month.</td></tr>}
            {m.vehicles.map((v) => (
              <tr key={v.asset_id || 0}>
                <td style={{ fontWeight: 600 }}>{v.name}<div style={{ ...MUTED, fontWeight: 400 }}>{[v.model, v.group !== "—" ? v.group : null].filter(Boolean).join(" · ")}</div></td>
                <td style={R}>{num(v.cards)}</td>
                <td style={{ ...R, fontWeight: 700 }}>{lakh(v.amount)}</td>
                <td style={R}>{v.per_unit ? `${rs(v.per_unit.value)} ${v.per_unit.unit}` : "—"}</td>
                <td style={R}>{lakh(v.fy)}</td>
              </tr>
            ))}
          </tbody>
          {m.vehicles.length > 0 && (
            <tfoot><tr><td style={{ fontWeight: 700 }}>Total</td><td style={{ ...R, fontWeight: 700 }}>{num(cards)}</td><td style={{ ...R, fontWeight: 700 }}>{lakh(m.totals.total)}</td>
              <td style={{ ...R, fontWeight: 700 }}>{rs(d.per_m3.maintenance)} / m³</td><td style={{ ...R, fontWeight: 700 }}>{lakh(m.fy_total)}</td></tr></tfoot>
          )}
        </table>
      </div>
      <div style={{ ...MUTED, marginTop: 8 }}>
        Now: {num(m.open.open_cards)} repair card(s) open · {num(m.open.at_workshop)} at a workshop · {num(m.open.bills_on_hold)} outside bill(s) on hold above the estimate (not in cost until accepted).
      </div>
    </div>
  );
}

function Manpower({ d }) {
  const m = d.manpower;
  const lines = [
    ["Staff salaries & wages", `HR payroll, cost to company · ${m.staff_count} staff${m.incentive ? ` · incl. sales incentive ₹${lakh(m.incentive)} L` : ""}${m.trip ? `, trip allowance ₹${lakh(m.trip)} L` : ""}`, m.staff],
    ["Pump gangs", `contractor bills${m.gangs_active ? ` · ${m.gangs_active} gang(s)` : ""}${m.deduction_days ? ` · ${num(m.deduction_days, 1)} member-days deducted by Admin` : ""}`, m.gangs],
    ["Other contract labour", "daily and monthly-rate workers", m.contract],
  ];
  const statusNote = m.payroll_status === "locked" ? null : m.payroll_status === "draft" ? "Payroll for this month is not locked yet — figures may change." : "No payroll made for this month yet.";
  return (
    <div style={panel("1 1 380px")}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <h2 style={H2}>Manpower</h2>
        <div style={{ fontSize: 13, fontWeight: 700, ...NUM }}>{rsL(m.total)} · {rs(m.per_m3)} / m³</div>
      </div>
      <div style={SUB}>HR payroll + approved contractor bills (excl. GST)</div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 10, fontSize: 13 }}>
        {lines.map(([l, s, v]) => (
          <div key={l} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
            <div><div style={{ fontWeight: 600 }}>{l}</div><div style={{ ...MUTED, fontSize: 11 }}>{s}</div></div>
            <div style={{ textAlign: "right" }}><div style={{ fontWeight: 700, ...NUM }}>{rsL(v)}</div><div style={{ ...MUTED, fontSize: 11, ...NUM }}>{rs(d.kpis.qty ? v / d.kpis.qty : null)} / m³</div></div>
          </div>
        ))}
      </div>
      <div style={{ ...GRID(130), marginTop: 12 }}>
        <div style={{ background: "#F7F5F0", borderRadius: 8, padding: 10 }}>
          <div style={{ ...MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 }}>Pump gangs</div>
          <div style={{ fontSize: 18, fontWeight: 700, ...NUM }}>{rs(m.gangs_per_pumped_m3)}</div><div style={{ ...MUTED, fontSize: 11 }}>per pumped m³</div></div>
        <div style={{ background: "#F7F5F0", borderRadius: 8, padding: 10 }}>
          <div style={{ ...MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 }}>Overtime</div>
          <div style={{ fontSize: 18, fontWeight: 700, ...NUM }}>{rsL(m.overtime)}</div><div style={{ ...MUTED, fontSize: 11 }}>comp-off days not counted</div></div>
      </div>
      {(statusNote || m.bills_draft > 0) && (
        <div style={{ marginTop: 12 }}><Note>{statusNote} {m.bills_draft > 0 ? `${m.bills_draft} contractor bill(s) not approved — payroll / closed gang months used meanwhile.` : ""}</Note></div>
      )}
    </div>
  );
}

function Ops({ d }) {
  const o = d.ops;
  const items = [
    ["Loads dispatched", num(o.loads), `Avg load ${num(o.avg_load, 1)} m³${o.prev_avg_load ? ` (${d.prev_label} ${num(o.prev_avg_load, 1)})` : ""}`],
    ["Pumped share", pct(o.pumped_pct, 0), `${num(o.pumped_m3, 1)} of ${num(d.kpis.qty, 1)} m³`],
    ["Returned / rejected", `${num(o.rejected_m3, 1)} m³`, `${pct(o.rejected_pct)} of loaded · at ${rs(d.per_m3.rm)}/m³ material ₹${lakh(o.rejected_m3 * (d.per_m3.rm || 0))} L`],
    ["Loads omitted", `${num(o.omitted_loads)} · ${num(o.omitted_m3, 1)} m³`, "into a JCB / no vehicle · not in per m³"],
    ["Loads not invoiced", `${num(o.held_loads)} · ${num(o.held_m3, 1)} m³`, "held with no price — not in sales yet"],
    ["Cement per m³ made", o.cement_per_m3 ? `${num(o.cement_per_m3)} kg` : "—", o.cement_vs_recipe_pct != null ? `vs recipe ${signed(o.cement_vs_recipe_pct)} · ${num(o.produced_m3, 1)} m³ made` : `${num(o.produced_m3, 1)} m³ made`],
  ];
  return (
    <div style={panel("1 1 100%")}>
      <h2 style={H2}>Operations that drive cost</h2>
      <div style={{ ...GRID(180), marginTop: 12 }}>
        {items.map(([l, v, s]) => (
          <div key={l} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "var(--concrete)" }}>
            <div style={{ fontSize: 11, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 3, ...NUM }}>{v}</div>
            <div style={{ ...MUTED, marginTop: 2 }}>{s}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function exportDashboard(d) {
  const L = (v) => (v == null ? "" : Math.round(v) / 100000);
  const k = d.kpis, p = d.per_m3;
  downloadExcel(`Cost dashboard ${d.month}.xlsx`, [
    { name: "Summary", rows: [
      [`Cost dashboard — ${d.month_label}`], ["Per m³ on sales quantity, amounts ₹ lakh excl. GST"], [],
      ["", "₹ lakh", "₹ / m³"],
      ["Sales quantity (m³)", k.qty], ["Sales", L(k.sales), p.realisation], ["RM purchase", L(k.rm_purchase)], ["RM consumption", L(k.rm_consumed), p.rm],
      ["Diesel bought", L(k.fuel_bought)], ["Fuel issued", L(k.fuel_issued), p.fuel], ["Contribution (sales − RM − fuel)", L(k.contribution), p.contribution],
      ["Maintenance", L(k.maintenance), p.maintenance], ["Manpower", L(k.manpower), p.manpower],
    ] },
    { name: "Raw material", rows: [["Material", "Purchase ₹ L", "Purchase ₹/m³", "Consumed kg", "Consumption ₹ L", "Consumption ₹/m³", `${d.prev_label} ₹/m³`, "Stock Δ ₹ L"],
      ...d.raw_material.rows.map((r) => [r.name, L(r.purchase), r.purchase_m3, r.consumed_kg, L(r.consumed), r.consumed_m3, r.prev_m3, L(r.stock_change)])] },
    { name: "Recipe vs actual", rows: [["Material", "Recipe kg", "Actual kg", "Variance %", "₹ impact"], ...d.recipe.map((r) => [r.name, r.recipe_kg, r.actual_kg, r.diff_pct, r.impact])] },
    { name: "Grades", rows: [["Grade", "Mix design", "Qty m³", "Mix %", "Rate ₹/m³", "RM ₹/m³", "Fuel ₹/m³", "Contribution ₹/m³", "Margin %"],
      ...d.grades.map((g) => [g.grade, g.design, g.qty, g.mix, g.rate, g.rm, g.fuel, g.contribution, g.margin])] },
    { name: "Fuel", rows: [["Consumer", "Litres", "₹ L", "₹/m³", "Efficiency", "Unit"], ...d.fuel.consumers.map((c) => [c.label, c.litres, L(c.value), c.per_m3, c.efficiency?.value ?? "", c.efficiency?.unit ?? ""])] },
    { name: "Maintenance", rows: [["Vehicle / machine", "Model", "Job cards", "Parts", "Outside", "Lubricants", "Tyres & batteries", "Total ₹", "This FY ₹"],
      ...d.maintenance.vehicles.map((v) => [v.name, v.model || v.group, v.cards, v.parts, v.outside, v.lubricant, v.tyres, v.amount, v.fy])] },
  ]);
}
