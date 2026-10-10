import { useEffect, useRef, useState, Fragment } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { todayStr } from "../lib/istDate.js";

// Round 157 — what the batching plant actually made, and what it actually ate.
//
// Fed by the MCI370 agent on the plant control PC (tools/mci370-agent), which
// reads Schwing Stetter's own Access database read-only. Three tabs:
//
//   Production  — m³ by day and by recipe, and the recent loads.
//   Consumption — kilograms per silo, and the figure that matters most to a
//                 ready-mix plant: kg per m³, against what the recipe asked for.
//   Silos       — Administrator only. Which of our materials each hopper holds.
//
// WHY CONSUMPTION IS REPORTED BY SILO, not by material. A hopper nobody has
// mapped yet still shows its real weights rather than disappearing, because the
// plant genuinely weighed it — the numbers are true before the mapping work is
// done. That is the opposite of the weighbridge, where an unresolved name means
// we do not know what arrived and showing a total would be a lie.

function fmtKg(kg) {
  if (kg == null) return "—";
  const n = Number(kg);
  if (n >= 1000) return `${(n / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} t`;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg`;
}
function fmtM3(v) {
  return v == null ? "—" : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })} m³`;
}
function fmtWhen(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString([], { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(d) {
  // The backend sends this as a plain 'YYYY-MM-DD' string, so read it as one.
  // Parsing it into a Date only to format it back is how a batch made at 9am
  // on the 25th ends up labelled the 24th on somebody's phone.
  if (!d) return "—";
  const [, m, day] = String(d).slice(0, 10).split("-");
  return m && day ? `${day} ${MONTHS[Number(m) - 1] || m}` : String(d);
}
function ago(ts) {
  if (!ts) return { text: "never", stale: true };
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return { text: "just now", stale: false };
  if (mins < 60) return { text: `${mins} min ago`, stale: mins > 10 };
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return { text: `${hrs} hr ago`, stale: true };
  return { text: `${Math.floor(hrs / 24)} d ago`, stale: true };
}

const TH = { padding: "9px 12px", textAlign: "left" };
const TD = { padding: "9px 12px" };

// Round 168 — the silo level cards. Each material type has its own colour, as
// the plant asked: cement/powder blue, admixture/water violet, aggregate tan.
const SILO_STYLE = {
  powder:    { bar: "#4E6E8E", bg: "#EEF2F6", border: "#4E6E8E", label: "Cement" },
  liquid:    { bar: "#7A4BA8", bg: "#F1ECF6", border: "#7A4BA8", label: "Admixture / water" },
  aggregate: { bar: "#B58A55", bg: "#F6F0E7", border: "#B58A55", label: "Aggregate" },
};
function siloStyle(kind) { return SILO_STYLE[kind] || SILO_STYLE.powder; }
// Cement, fly-ash and aggregate are weighed in tonnes (MT); water and admixture
// in LITRES (≈ kg at ~unit density, which is all the yard view needs). Round 184
// (#2): liquid was shown in kilolitres, which read oddly for admixture — the
// plant thinks in litres — so liquid now shows L (1 L ≈ 1 kg). The stored figure
// is always kg; this is display only, and the capacity input uses the same
// convention so what is typed matches what is shown.
function siloUnit(kind) { return kind === "liquid" ? "L" : "MT"; }
// kg per one display unit: litre ≈ 1 kg, tonne = 1000 kg.
function siloDivisor(kind) { return kind === "liquid" ? 1 : 1000; }
function toSiloUnit(kg, kind) { return kg == null ? null : Number(kg) / siloDivisor(kind); }
function fromSiloUnit(v, kind) { return v === "" || v == null ? null : Number(v) * siloDivisor(kind); }
// Round 188 (v10.17 #6) — a silo level is shown in the unit its material is
// BOUGHT in (aggregate in CFT, cement in MT, admixture in L…), using the
// material's own kg-per-unit from the Material Module. A silo whose material
// has no purchase unit set falls back to MT / L as before.
function purchaseQty(kg, l) {
  if (kg == null) return "—";
  const v = Number(kg) / Number(l.kg_per_purchase_unit);
  return v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 1 });
}
function levelQty(kg, l) { return l.purchase_unit && l.kg_per_purchase_unit ? purchaseQty(kg, l) : fmtSiloQty(kg, l.kind); }
function levelUnit(l) { return l.purchase_unit && l.kg_per_purchase_unit ? l.purchase_unit : siloUnit(l.kind); }
function fmtSiloQty(kg, kind) {
  if (kg == null) return "—";
  const v = Number(kg) / siloDivisor(kind);
  const maxFrac = kind === "liquid" ? 0 : (v >= 10 ? 0 : 1);
  return v.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

// ---------------------------------------------------------------------------

// Round 179 (#4) — plant vs billed production over the selected period.
function PlantVsBilled({ qs }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setData(null); setError("");
    apiRequest(`/plant/production-vs-billed?${qs}`)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [qs]);
  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!data) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;
  const t = data.totals;
  const diff = Number(t.difference_m3);
  const diffColour = diff > 0 ? "#B58A55" : diff < 0 ? "var(--alert-red)" : "var(--signal-green)";
  return (
    <>
      <div className="card" style={{ marginBottom: 14, display: "flex", gap: 28, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <div className="kpi-label">Plant produced</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtM3(t.plant_m3)}</div>
          <div style={{ fontSize: 11, color: "var(--slate)" }}>batched + manual, from MCI370</div>
        </div>
        <div>
          <div className="kpi-label">Billed / delivered</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtM3(t.billed_m3)}</div>
          <div style={{ fontSize: 11, color: "var(--slate)" }}>{t.tickets} delivery challan{t.tickets === 1 ? "" : "s"}</div>
        </div>
        <div>
          <div className="kpi-label">Difference (plant − billed)</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: diffColour }}>
            {diff > 0 ? "+" : ""}{fmtM3(t.difference_m3)}{t.difference_pct != null ? ` (${diff > 0 ? "+" : ""}${t.difference_pct}%)` : ""}
          </div>
          <div style={{ fontSize: 11, color: "var(--slate)" }}>over-batching / wash-out / returns / unbilled</div>
        </div>
      </div>

      <div className="card" style={{ fontSize: 12, color: "var(--slate)", lineHeight: 1.55, marginBottom: 14 }}>
        <b style={{ color: "var(--charcoal)" }}>Plant produced</b> is what the batching plant actually made (every batch in
        MCI370 plus any manual production entry). <b style={{ color: "var(--charcoal)" }}>Billed</b> is what left on customer
        delivery challans. A positive difference means more was made than billed — the normal home of wash-out, returned
        concrete and over-batching; a negative difference means challans exceed recorded production, which is worth a look
        (a day the plant feed was down, or manual production not yet entered).
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Day</th>
              <th style={{ ...TH, textAlign: "right" }}>Plant m³</th>
              <th style={{ ...TH, textAlign: "right" }}>Billed m³</th>
              <th style={{ ...TH, textAlign: "right" }}>Difference</th>
              <th style={{ ...TH, textAlign: "right" }}>Challans</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const d = Number(r.difference_m3);
              return (
                <tr key={r.day} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={TD}>{r.day}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{fmtM3(r.plant_m3)}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{fmtM3(r.billed_m3)}</td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600, color: d > 0 ? "#B58A55" : d < 0 ? "var(--alert-red)" : "var(--slate)" }}>{d > 0 ? "+" : ""}{fmtM3(r.difference_m3)}</td>
                  <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>{r.tickets}</td>
                </tr>
              );
            })}
            {data.rows.length === 0 && <tr><td colSpan={5} style={{ ...TD, color: "var(--slate)" }}>Nothing in this period.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Production({ qs }) {
  const [data, setData] = useState(null);
  const [loads, setLoads] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.all([
      apiRequest(`/plant/production?${qs}`),
      apiRequest(`/plant/loads?${qs}`),
    ])
      .then(([p, l]) => { if (alive) { setData(p); setLoads(l); } })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [qs]);

  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  // Round 166b — surface a load error instead of a frozen "Loading…": when the
  // fetch throws, `data` stays null, so without this the screen never leaves the
  // loading state and the real reason is invisible (exactly the Silos 42703 bug).
  if (!data) return <div className="card" style={{ fontSize: 13, color: error ? "var(--alert-red)" : "var(--slate)" }}>{error || "Loading…"}</div>;

  const maxDay = Math.max(...data.by_day.map((d) => Number(d.m3)), 1);
  const num = (v) => (v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  const t = data.totals || {};

  return (
    <>
      {/* Round 188 (v10.17 #3) — the total for the selected range. */}
      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 28, flexWrap: "wrap", alignItems: "baseline" }}>
        <div>
          <div className="kpi-label">Total production — selected range</div>
          <div style={{ fontSize: 26, fontWeight: 800 }}>{num(t.total_m3)} <span style={{ fontSize: 14, color: "var(--slate)" }}>m³</span></div>
        </div>
        <div style={{ fontSize: 13 }}>
          <div><b>{num(t.auto_m3)}</b> m³ from the plant <span style={{ color: "var(--slate)" }}>· {t.loads ?? 0} loads · {t.batches ?? 0} batches</span></div>
          <div><b>{num(t.manual_m3)}</b> m³ manual entry</div>
        </div>
        <div style={{ fontSize: 12, color: "var(--slate)", marginLeft: "auto" }}>{t.days ?? 0} day{t.days === 1 ? "" : "s"} with production</div>
      </div>

      <div className="pp-two" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.7fr) minmax(0, 1fr)", gap: 16, marginBottom: 16 }}>
        <div className="card">
          <h3 style={{ fontSize: 14, margin: "0 0 12px" }}>By Day in m³</h3>
          {!data.by_day.length && <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing batched in this period.</div>}
          {data.by_day.length > 0 && (
            <div className="pp-day-head" style={{ display: "flex", gap: 10, fontSize: 10.5, color: "var(--slate)", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".04em" }}>
              <span style={{ width: 62 }}>Day</span><span style={{ flexGrow: 1 }} />
              <span style={{ width: 64, textAlign: "right" }}>Plant</span>
              <span style={{ width: 64, textAlign: "right" }}>Manual</span>
              <span style={{ width: 70, textAlign: "right" }}>Total</span>
              <span style={{ width: 58, textAlign: "right" }}>Loads</span>
            </div>
          )}
          {data.by_day.map((d) => (
            <div key={d.batch_date} className="pp-day-row" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 7 }}>
              <span style={{ fontSize: 12.5, width: 62, color: "var(--slate)" }}>{fmtDay(d.batch_date)}</span>
              {/* A plain proportional bar rather than a chart library: plant
                  part solid, manual part lighter on the end of it. */}
              <span className="pp-bar" style={{ flexGrow: 1, height: 16, background: "var(--concrete)", borderRadius: 3, overflow: "hidden", display: "flex" }}>
                <span style={{ display: "block", height: "100%", width: `${(Number(d.auto_m3) / maxDay) * 100}%`, background: "var(--rebar)" }} />
                <span style={{ display: "block", height: "100%", width: `${(Number(d.manual_m3) / maxDay) * 100}%`, background: "var(--amber)", opacity: 0.75 }} />
              </span>
              <span style={{ fontSize: 12.5, width: 64, textAlign: "right" }}>{num(d.auto_m3)}</span>
              <span style={{ fontSize: 12.5, width: 64, textAlign: "right", color: Number(d.manual_m3) > 0 ? "var(--amber)" : "var(--slate)" }}>{Number(d.manual_m3) > 0 ? num(d.manual_m3) : "—"}</span>
              <span style={{ fontSize: 12.5, width: 70, textAlign: "right", fontWeight: 700 }}>{num(d.m3)}</span>
              <span style={{ fontSize: 11.5, width: 58, textAlign: "right", color: "var(--slate)" }}>{d.loads}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <h3 style={{ fontSize: 14, margin: "0 0 12px" }}>By recipe in m³</h3>
          {!data.by_recipe.length && <div style={{ fontSize: 13, color: "var(--slate)" }}>—</div>}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {data.by_recipe.map((r) => (
                <tr key={r.recipe_code} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 8px", fontWeight: 600 }} title={r.recipe_name || ""}>{r.recipe_code}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>
                    {num(r.m3)}
                    {Number(r.manual_m3) > 0 && <div style={{ fontSize: 10.5, fontWeight: 400, color: "var(--amber)" }}>incl. {num(r.manual_m3)} man.</div>}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--slate)", fontSize: 12 }}>{r.loads ? `${r.loads} load${r.loads === 1 ? "" : "s"}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h3 style={{ fontSize: 15, margin: "0 0 10px" }}>Recent loads</h3>
      {/* Round 189 — on a phone each load is a small card instead of an 8-column table. */}
      <div className="pp-only-narrow">
        {loads.map((l) => (
          <div key={`n-${l.batch_year}-${l.batch_no}-${l.plant_no}`} className="card" style={{ marginBottom: 8, padding: "10px 12px", fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <b>#{l.batch_no} · {l.recipe_code}</b><b>{fmtM3(l.m3)}</b>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "var(--slate)", fontSize: 12 }}>
              <span>{fmtWhen(l.started_at)} · {l.batches} batches</span><span>{l.truck_no || "—"}</span>
            </div>
            {l.site_name && <div style={{ color: "var(--slate)", fontSize: 12 }}>{l.site_name}</div>}
          </div>
        ))}
        {!loads.length && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>No loads in this period.</div>}
      </div>
      <div className="card pp-only-wide" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Batch</th><th style={TH}>Started</th><th style={TH}>Recipe</th>
              <th style={{ ...TH, textAlign: "right" }}>Made</th><th style={{ ...TH, textAlign: "right" }}>Batches</th>
              <th style={TH}>Truck</th><th style={TH}>Site</th><th style={TH}>Batcher</th>
            </tr>
          </thead>
          <tbody>
            {loads.map((l) => (
              <tr key={`${l.batch_year}-${l.batch_no}-${l.plant_no}`} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ ...TD, fontWeight: 600 }}>#{l.batch_no}</td>
                <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmtWhen(l.started_at)}</td>
                <td style={TD}>{l.recipe_code}</td>
                <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{fmtM3(l.m3)}</td>
                {/* The mix count is the thing people get wrong about this data:
                    one load is several batches, and consumption sums across them. */}
                <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>{l.batches}</td>
                <td style={TD}>{l.truck_no || "—"}</td>
                <td style={TD}>{l.site_name || "—"}</td>
                <td style={{ ...TD, color: "var(--slate)" }}>{l.batcher_name || "—"}</td>
              </tr>
            ))}
            {!loads.length && (
              <tr><td colSpan={8} style={{ ...TD, color: "var(--slate)" }}>No loads in this period.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function Consumption({ qs }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    apiRequest(`/plant/consumption?${qs}`)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [qs]);

  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  // Round 166b — surface a load error instead of a frozen "Loading…": when the
  // fetch throws, `data` stays null, so without this the screen never leaves the
  // loading state and the real reason is invisible (exactly the Silos 42703 bug).
  if (!data) return <div className="card" style={{ fontSize: 13, color: error ? "var(--alert-red)" : "var(--slate)" }}>{error || "Loading…"}</div>;

  const m3 = Number(data.total_m3) || 0;
  const manual = data.manual || [];
  const manualKg = manual.reduce((a, mm) => a + Number(mm.actual_kg || 0), 0);
  const totalKg = data.silos.reduce((a, s) => a + Number(s.actual_kg || 0), 0) + manualKg;

  return (
    <>
      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 26, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <div className="kpi-label">Produced</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtM3(m3)}</div>
        </div>
        <div>
          <div className="kpi-label">Materials used</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtKg(totalKg)}</div>
        </div>
        <div>
          <div className="kpi-label">Overall density</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            {m3 ? `${Math.round(totalKg / m3).toLocaleString()} kg/m³` : "—"}
          </div>
        </div>
        <p style={{ margin: 0, marginLeft: "auto", maxWidth: 380, fontSize: 11.5, color: "var(--slate)", lineHeight: 1.5 }}>
          Silo figures are what the plant's own load cells weighed, summed across the batches in each load;
          any operator-entered manual consumption is listed separately below and included in the totals.
          Nothing here is derived from a mix design.
        </p>
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Silo</th>
              <th style={TH}>Material</th>
              <th style={{ ...TH, textAlign: "right" }}>Weighed</th>
              <th style={{ ...TH, textAlign: "right" }}>Recipe asked for</th>
              <th style={{ ...TH, textAlign: "right" }}>Difference</th>
              <th style={{ ...TH, textAlign: "right" }}>Per m³</th>
              <th style={{ ...TH, textAlign: "right" }}>Moisture</th>
            </tr>
          </thead>
          <tbody>
            {data.silos.map((s) => {
              const actual = Number(s.actual_kg || 0);
              const target = Number(s.target_kg || 0);
              const diff = target ? actual - target : null;
              const diffPct = target ? (diff / target) * 100 : null;
              // 2% is the band where a batching plant's own tolerance normally
              // sits. Beyond it on a whole period's total is worth a look —
              // a single mix drifting is normal, a month drifting is not.
              const off = diffPct != null && Math.abs(diffPct) > 2;
              return (
                <tr key={`${s.slot}-${s.material_id ?? "x"}`} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={TD}>
                    <div style={{ fontWeight: 600 }}>{s.slot_name || s.slot}</div>
                    <div style={{ fontSize: 11, color: "var(--slate)" }}>{s.slot} · {s.mixes} batches</div>
                  </td>
                  <td style={TD}>
                    {/* Three states, not two. A hopper somebody has decided is
                        not stock — mains water, a spare — is settled work, and
                        colouring it amber alongside genuinely unmapped silos
                        would nag forever about a decision already taken. */}
                    {s.material_name
                      ? s.material_name
                      : s.ignored
                        ? <span style={{ color: "var(--slate)", fontStyle: "italic" }}>not a stock material</span>
                        : <span style={{ color: "var(--amber)" }}>not mapped yet</span>}
                  </td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmtKg(actual)}</td>
                  <td style={{ ...TD, textAlign: "right", color: "var(--slate)", whiteSpace: "nowrap" }}>{target ? fmtKg(target) : "—"}</td>
                  <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap", color: off ? "var(--alert-red)" : "var(--slate)" }}>
                    {diff == null ? "—" : `${diff > 0 ? "+" : ""}${diff.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg (${diffPct > 0 ? "+" : ""}${diffPct.toFixed(1)}%)`}
                  </td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>
                    {m3 ? `${Math.round(actual / m3).toLocaleString()} kg` : "—"}
                  </td>
                  <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>
                    {s.avg_moisture_pct == null ? "—" : `${Number(s.avg_moisture_pct).toFixed(1)}%`}
                  </td>
                </tr>
              );
            })}
            {!data.silos.length && (
              <tr><td colSpan={7} style={{ ...TD, color: "var(--slate)" }}>Nothing weighed in this period.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {manual.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, margin: "18px 0 6px" }}>Manual consumption (operator-entered)</h3>
          <p style={{ fontSize: 11.5, color: "var(--slate)", margin: "0 0 10px", maxWidth: 820, lineHeight: 1.5 }}>
            Entered on the Manual entry tab for periods the batching system did not record — counted in the
            totals above and drawn from material stock, exactly like the load-cell figures.
          </p>
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--concrete)" }}>
                  <th style={TH}>Material</th>
                  <th style={{ ...TH, textAlign: "right" }}>Weighed (manual)</th>
                  <th style={{ ...TH, textAlign: "right" }}>Per m³</th>
                </tr>
              </thead>
              <tbody>
                {manual.map((mm) => (
                  <tr key={mm.material_id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={TD}>{mm.material_name}</td>
                    <td style={{ ...TD, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmtKg(mm.actual_kg)}</td>
                    <td style={{ ...TD, textAlign: "right", color: "var(--slate)", whiteSpace: "nowrap" }}>{m3 ? `${Math.round(Number(mm.actual_kg) / m3).toLocaleString()} kg` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {(data.transfers || []).length > 0 && (
        <>
          <h3 style={{ fontSize: 15, margin: "18px 0 6px" }}>Consumption transfers (Administrator)</h3>
          <p style={{ fontSize: 11.5, color: "var(--slate)", margin: "0 0 10px", maxWidth: 820, lineHeight: 1.5 }}>
            Quantities moved from the material the plant booked to the one really used (several materials through one bin).
            The plant's weights above are unchanged; book stock and cost use the figures after these transfers.
          </p>
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 560 }}>
              <thead>
                <tr style={{ background: "var(--concrete)" }}>
                  <th style={TH}>Month</th><th style={TH}>Transferred out of</th><th style={TH}>Into</th>
                  <th style={{ ...TH, textAlign: "right" }}>Quantity</th><th style={TH}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.transfers.map((t) => (
                  <tr key={t.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmtDay(t.transfer_date)}</td>
                    <td style={TD}>{t.from_name}</td>
                    <td style={TD}>{t.to_name}</td>
                    <td style={{ ...TD, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmtKg(t.qty_kg)}</td>
                    <td style={{ ...TD, color: "var(--slate)" }}>{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p style={{ fontSize: 12, color: "var(--slate)", marginTop: 14, lineHeight: 1.6 }}>
        Moisture is the plant's own aggregate reading, and it is the only trustworthy moisture figure
        in this app's data — the weighbridge stores its moisture as free text and has never once held
        a real number. A silo showing no moisture is a powder or a liquid, which the plant does not
        measure that way.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
function fmtINR(n) {
  if (n == null) return "—";
  return "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

// ---------------------------------------------------------------------------
// Round 167 — Cost/m³ (material). Raw-material cost per m³ from the plant's
// ACTUAL consumption (load-cell auto + operator manual) × each material's
// weighted-average landed rate. Rates are money, so this tab is Administrator
// only (gated on material.stock-valuation), like the material module.
function CostPerM3({ qs }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    apiRequest(`/plant/cost-per-m3?${qs}`).then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [qs]);
  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!data) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;
  const anyMissing = data.rows.some((r) => !r.has_rate);
  return (
    <>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 14 }}>
        <div><div className="kpi-label">Produced</div><div style={{ fontSize: 22, fontWeight: 700 }}>{fmtM3(data.produced_m3)}</div></div>
        <div><div className="kpi-label">Material cost</div><div style={{ fontSize: 22, fontWeight: 700 }}>{fmtINR(data.total_material_cost)}</div></div>
        <div><div className="kpi-label">Cost/m³ – Material</div><div style={{ fontSize: 22, fontWeight: 700 }}>{fmtINR(data.total_cost_per_m3)}</div></div>
      </div>
      {data.produced_m3 <= 0 && (
        <div className="card" style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 12 }}>
          No production in this period, so a per-m³ cost cannot be computed.
        </div>
      )}
      <div className="card" style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: "var(--concrete)" }}>
            <th style={TH}>Material</th>
            <th style={{ ...TH, textAlign: "right" }}>Consumed</th>
            <th style={{ ...TH, textAlign: "right" }}>Rate ₹/kg</th>
            <th style={{ ...TH, textAlign: "right" }}>₹ / m³</th>
            <th style={{ ...TH, textAlign: "right" }}>Share</th>
          </tr></thead>
          <tbody>
            {/* Round 193 — grouped: Cement, Aggregate, Admixture (then Water,
                Other), each group's subtotal on its heading row. */}
            {(data.groups || [{ group: null, rows: data.rows }]).map((g) => (
              <Fragment key={g.group || "all"}>
                {g.group && (
                  <tr style={{ borderTop: "1px solid var(--border-strong)", background: "#F7F5F0" }}>
                    <td style={{ ...TD, fontWeight: 700 }}>{g.group} <span style={{ fontWeight: 400, color: "var(--slate)", fontSize: 11.5 }}>· {g.rows.length} material{g.rows.length === 1 ? "" : "s"}</span></td>
                    <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap", fontWeight: 600 }}>{fmtKg(g.consumed_kg)}</td>
                    <td style={TD}></td>
                    <td style={{ ...TD, textAlign: "right", fontWeight: 700, whiteSpace: "nowrap" }}>{fmtINR(g.cost_per_m3)}</td>
                    <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{g.share_pct == null ? "—" : `${g.share_pct}%`}</td>
                  </tr>
                )}
                {g.rows.map((r) => (
                  <tr key={r.material_id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ ...TD, paddingLeft: g.group ? 22 : undefined }}>{r.material_name}</td>
                    <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap" }}>{fmtKg(r.consumed_kg)}</td>
                    <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap", color: r.has_rate ? "inherit" : "var(--amber)" }}>{r.has_rate ? Number(r.rate_per_kg).toFixed(2) : "no rate"}</td>
                    <td style={{ ...TD, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{r.cost_per_m3 == null ? "—" : fmtINR(r.cost_per_m3)}</td>
                    <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>{r.share_pct == null ? "—" : `${r.share_pct}%`}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
            {data.rows.length > 0 && (
              <tr style={{ borderTop: "2px solid var(--border-strong)" }}>
                <td style={{ ...TD, fontWeight: 700 }}>Total</td>
                <td style={TD}></td><td style={TD}></td>
                <td style={{ ...TD, textAlign: "right", fontWeight: 700, whiteSpace: "nowrap" }}>{fmtINR(data.total_cost_per_m3)}</td>
                <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>100%</td>
              </tr>
            )}
            {!data.rows.length && <tr><td style={TD} colSpan={5}><span style={{ color: "var(--slate)" }}>No consumption in this period.</span></td></tr>}
          </tbody>
        </table>
        <div style={{ fontSize: 10.5, color: "var(--slate)", lineHeight: 1.55, padding: "10px 12px" }}>
          <b>Consumed</b> is the plant's load-cell figure <b>plus</b> the operator's manual entries — never the auto
          figure alone. Groups follow each material's mix component (Materials master), else its category or name.
          <b> Rate</b> is the weighted-average landed cost per material from the Material Module{anyMissing
          ? "; a material shown “no rate” has no priced receipt yet, so it is left out of the total." : "."}
        </div>
      </div>
    </>
  );
}

function Silos() {
  const [data, setData] = useState(null);
  const [fills, setFills] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState({});
  const [capDraft, setCapDraft] = useState({}); // Round 168 — capacity edits, keyed by slot, in MT/kL
  const [fillDraft, setFillDraft] = useState({ slot: "", material_id: "", qty_kg: "", filled_at: "" });
  const [busy, setBusy] = useState(false);

  async function load() {
    setError("");
    try {
      const [d, f] = await Promise.all([
        apiRequest("/plant/silos"),
        apiRequest("/plant/silo-fills"),
      ]);
      setData(d); setFills(f);
    } catch (err) { setError(err.message || "Could not load the silos."); }
  }
  useEffect(() => { load(); }, []);

  async function save(slot, slotName) {
    const choice = draft[slot];
    const capTouched = Object.prototype.hasOwnProperty.call(capDraft, slot);
    if (!choice && !capTouched) return;
    setError(""); setNotice("");
    // The mapping this row already has, so a capacity-only edit still sends a
    // valid "holds" (the endpoint requires one of material/refillable/ignore).
    const a = data?.aliases.find((x) => x.slot === slot);
    const holds = choice || (a?.is_refillable ? "refill" : a?.is_ignored ? "ignore" : a?.material_id ? String(a.material_id) : "");
    if (!holds) { setError("Choose what this silo holds before setting its capacity."); return; }
    const body = { slot, slot_name: slotName };
    if (holds === "ignore") body.is_ignored = true;
    else if (holds === "refill") body.is_refillable = true;
    else body.material_id = Number(holds);
    // Capacity is sent only when its box was touched, so saving one row's
    // mapping never wipes another silo's capacity. Blank clears it. Typed in
    // MT (solids) or L (liquids), stored in kg.
    if (capTouched) body.capacity_kg = capDraft[slot] === "" ? "" : fromSiloUnit(capDraft[slot], kindBySlot.get(slot));
    try {
      const r = await apiRequest("/plant/silos", { method: "POST", body });
      setNotice(`Saved. ${r.rows_updated} batch row${r.rows_updated === 1 ? "" : "s"} re-attributed.`);
      setDraft({ ...draft, [slot]: "" });
      setCapDraft((c) => { const n = { ...c }; delete n[slot]; return n; });
      await load();
    } catch (err) { setError(err.message); }
  }

  async function addFill(e) {
    e.preventDefault();
    setError(""); setNotice(""); setBusy(true);
    try {
      const r = await apiRequest("/plant/silo-fills", {
        method: "POST",
        body: {
          slot: fillDraft.slot,
          material_id: Number(fillDraft.material_id),
          qty_kg: Number(fillDraft.qty_kg),
          filled_at: fillDraft.filled_at,
        },
      });
      setNotice(`Fill recorded. ${r.rows_updated} batch row${r.rows_updated === 1 ? "" : "s"} now costed against it.`);
      setFillDraft({ slot: "", material_id: "", qty_kg: "", filled_at: "" });
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function removeFill(id) {
    setError(""); setNotice("");
    try { await apiRequest(`/plant/silo-fills/${id}`, { method: "DELETE" }); await load(); }
    catch (err) { setError(err.message); }
  }

  async function recheck() {
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await apiRequest("/plant/recheck", { method: "POST" });
      setNotice(`Re-checked. ${r.rows_updated} batch row${r.rows_updated === 1 ? "" : "s"} changed.`);
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  // Round 166b — surface a load error instead of a frozen "Loading…": when the
  // fetch throws, `data` stays null, so without this the screen never leaves the
  // loading state and the real reason is invisible (exactly the Silos 42703 bug).
  if (!data) return <div className="card" style={{ fontSize: 13, color: error ? "var(--alert-red)" : "var(--slate)" }}>{error || "Loading…"}</div>;

  const aliasBySlot = new Map(data.aliases.map((a) => [a.slot, a]));
  const kindBySlot = new Map((data.slots || []).map((s) => [s.key, s.kind]));
  const levels = data.levels || [];
  const levelsPowderLiquid = levels.filter((l) => l.kind === "powder" || l.kind === "liquid");
  const levelsAggregate = levels.filter((l) => l.kind === "aggregate");
  const notInSilo = data.not_in_silo || [];

  function levelCard(l) {
    const st = siloStyle(l.kind);
    const hasLevel = l.level_kg != null;
    const neg = hasLevel && Number(l.level_kg) < 0;
    const pct = l.pct; // 0..100, or null when capacity unset
    const low = pct != null && pct < 25 && !neg;
    const pctColor = neg ? "var(--alert-red)" : low ? "#9C6B12" : "#1D7A55";
    const gaugeH = neg ? 0 : (pct != null ? pct : 0);
    return (
      <div key={l.slot} style={{ display: "flex", gap: 13, background: st.bg, border: "1px solid var(--border)", borderLeft: `5px solid ${st.border}`, borderRadius: 12, padding: "12px 14px" }}>
        <div style={{ width: 34, minWidth: 34, height: 104, background: "var(--concrete)", border: "1px solid var(--border)", borderRadius: 9, position: "relative", overflow: "hidden" }}>
          {l.capacity_kg != null && <div style={{ position: "absolute", left: 0, right: 0, top: 0, borderBottom: "2px dashed rgba(0,0,0,.18)" }} />}
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: `${Math.max(0, Math.min(100, gaugeH))}%`, background: st.bar }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0 }}>
          <div style={{ fontSize: 10, color: "var(--slate)", textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 700 }}>{l.slot_name || l.label}</div>
          <div style={{ fontSize: 11.5, color: "var(--slate)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.material_name || "—"}</div>
          <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.05, marginTop: 3, color: neg ? "var(--alert-red)" : "inherit" }}>
            {hasLevel
              ? <>{levelQty(l.level_kg, l)} <span style={{ fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>{levelUnit(l)}</span></>
              : <span style={{ fontSize: 13.5, color: "var(--amber)", fontWeight: 600 }}>no fills yet</span>}
          </div>
          <div style={{ fontSize: 11, color: "var(--slate)" }}>
            {l.capacity_kg != null ? `of ${levelQty(l.capacity_kg, l)} ${levelUnit(l)}` : "capacity not set"}
          </div>
          {hasLevel && (
            <div style={{ fontSize: 11, fontWeight: 700, marginTop: 5, color: pctColor }}>
              {neg ? "over-drawn — fills missing" : pct != null ? `${Math.round(pct)}% full${low ? " · low" : ""}` : "set capacity for %"}
            </div>
          )}
        </div>
      </div>
    );
  }
  const LVLGRID = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 };

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 14, color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 14, color: "var(--signal-green)", fontSize: 13 }}>{notice}</div>}

      <h3 style={{ fontSize: 15, margin: "0 0 4px" }}>Silo storage levels</h3>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--slate)", lineHeight: 1.55, maxWidth: 860 }}>
        What each hopper holds right now — receipts assigned to a silo raise its level, the plant's load-cell
        draw lowers it. The highlighted figure is the quantity; capacity, set on the mapping row below, gives
        the percentage and the low warning. A level appears once a silo has had its first fill (a receipt or an
        opening declaration below). <b style={{ color: "#4E6E8E" }}>Cement</b>, <b style={{ color: "#7A4BA8" }}>admixture/water</b>{" "}
        and <b style={{ color: "#B58A55" }}>aggregate</b> each carry their own colour.
      </p>

      {(levelsPowderLiquid.length > 0 || levelsAggregate.length > 0) ? (
        <div style={{ marginBottom: 20 }}>
          {levelsPowderLiquid.length > 0 && (
            <>
              <h4 style={{ fontSize: 12.5, margin: "0 0 8px", color: "#4E6E8E" }}>Cement &amp; admixture</h4>
              <div style={{ ...LVLGRID, marginBottom: levelsAggregate.length ? 16 : 0 }}>{levelsPowderLiquid.map(levelCard)}</div>
            </>
          )}
          {levelsAggregate.length > 0 && (
            <>
              <h4 style={{ fontSize: 12.5, margin: "0 0 8px", color: "#B58A55" }}>Aggregate</h4>
              <div style={LVLGRID}>{levelsAggregate.map(levelCard)}</div>
            </>
          )}
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 20, fontSize: 13, color: "var(--slate)" }}>
          No silo is mapped to a material yet. Map the hoppers below and set their capacities, then assign
          receipts to them (or record an opening declaration below) to see levels here.
        </div>
      )}

      {notInSilo.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 15, margin: "0 0 4px" }}>Received but not in a silo</h3>
          <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--slate)", lineHeight: 1.55, maxWidth: 860 }}>
            Loads recorded as going to the laboratory, the store, or a drummed admixture not tied to a tank.
            They count as stock bought, but raise no silo's level.
          </p>
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--concrete)" }}>
                  <th style={TH}>Material</th>
                  <th style={{ ...TH, textAlign: "right" }}>Quantity</th>
                  <th style={{ ...TH, textAlign: "right" }}>Receipts</th>
                  <th style={TH}>Last received</th>
                </tr>
              </thead>
              <tbody>
                {notInSilo.map((n) => (
                  <tr key={n.material_id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={TD}>{n.material_name}</td>
                    <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{n.purchase_unit && n.kg_per_purchase_unit ? `${purchaseQty(n.qty_kg, n)} ${n.purchase_unit}` : fmtKg(n.qty_kg)}</td>
                    <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>{n.receipts}</td>
                    <td style={{ ...TD, color: "var(--slate)" }}>{fmtDay(n.last_received)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 15, margin: "0 0 4px" }}>Opening stock &amp; unrecorded fills</h3>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--slate)", lineHeight: 1.55, maxWidth: 860 }}>
        A receipt assigned to a silo records its own fill automatically. Use this only for the opening
        declaration — what is in the silos right now — or a fill nobody entered as a receipt. A fill takes
        effect from its own moment onward: a batch made on the 3rd is costed against whatever the silo held on
        the 3rd, and a fill on the 10th changes nothing behind it.
      </p>

      <form onSubmit={addFill} className="card" style={{ marginBottom: 18, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ fontSize: 11.5, color: "var(--slate)", display: "flex", flexDirection: "column", gap: 3 }}>Silo
          <select required value={fillDraft.slot} onChange={(e) => setFillDraft({ ...fillDraft, slot: e.target.value })} style={{ fontSize: 13 }}>
            <option value="">Choose…</option>
            {levels.map((l) => <option key={l.slot} value={l.slot}>{l.slot_name || l.label} ({l.slot})</option>)}
          </select>
        </label>
        <label style={{ fontSize: 11.5, color: "var(--slate)", display: "flex", flexDirection: "column", gap: 3 }}>Material
          <select required value={fillDraft.material_id} onChange={(e) => setFillDraft({ ...fillDraft, material_id: e.target.value })} style={{ fontSize: 13, minWidth: 186 }}>
            <option value="">Choose…</option>
            {data.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 11.5, color: "var(--slate)", display: "flex", flexDirection: "column", gap: 3 }}>Quantity (kg)
          <input required type="number" step="1" min="1" value={fillDraft.qty_kg}
                 onChange={(e) => setFillDraft({ ...fillDraft, qty_kg: e.target.value })} style={{ fontSize: 13, width: 118 }} />
        </label>
        <label style={{ fontSize: 11.5, color: "var(--slate)", display: "flex", flexDirection: "column", gap: 3 }}>Filled at
          <input required type="datetime-local" value={fillDraft.filled_at}
                 onChange={(e) => setFillDraft({ ...fillDraft, filled_at: e.target.value })} style={{ fontSize: 13 }} />
        </label>
        <button type="submit" className="btn-primary" style={{ fontSize: 13 }} disabled={busy}>Record fill</button>
        <span style={{ fontSize: 11.5, color: "var(--slate)", maxWidth: 300, lineHeight: 1.45 }}>
          Normally this comes from the receipt itself. Use this for the opening declaration, or a fill nobody recorded.
        </span>
      </form>

      <h3 style={{ fontSize: 15, margin: "0 0 10px" }}>Fill history</h3>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Silo</th><th style={TH}>Material</th><th style={TH}>Supplier</th>
              <th style={TH}>Filled</th><th style={{ ...TH, textAlign: "right" }}>Qty</th>
              <th style={TH}>Until</th><th style={TH}>On top of</th><th style={TH} />
            </tr>
          </thead>
          <tbody>
            {fills.map((f) => (
              <tr key={f.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ ...TD, fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{f.slot}</td>
                <td style={TD}>{f.material_name}</td>
                <td style={{ ...TD, color: "var(--slate)" }}>{f.supplier_name || "—"}{f.challan_number ? ` · ${f.challan_number}` : ""}</td>
                <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmtWhen(f.filled_at)}</td>
                <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{fmtKg(f.qty_kg)}</td>
                <td style={{ ...TD, whiteSpace: "nowrap", color: "var(--slate)" }}>
                  {f.until ? fmtWhen(f.until) : <span style={{ color: "var(--signal-green)", fontWeight: 600 }}>still in</span>}
                </td>
                <td style={{ ...TD, fontSize: 11.5, color: "var(--slate)" }}>
                  {f.was_empty ? "empty silo" : `${fmtKg(f.balance_before_kg)} remaining`}
                </td>
                <td style={{ ...TD, textAlign: "right" }}>
                  <button type="button" style={{ fontSize: 12 }} onClick={() => removeFill(f.id)}>Remove</button>
                </td>
              </tr>
            ))}
            {!fills.length && <tr><td colSpan={8} style={{ ...TD, color: "var(--slate)" }}>No fills recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
        <strong>Each hopper is one of three things.</strong> One of your materials, permanently — a sand
        or aggregate gate. <em>Refillable storage</em>, which holds whatever was last put in it: the cement
        and fly-ash silos. Or <em>not stock at all</em> — mains water, a spare. Its weights still show in
        consumption; they simply do not come off anybody's stock.
        <br />
        Mappings are held against the <strong>hopper</strong>, not its name, because your plant calls both
        Gate 1 and Gate 2 "M SAND" — keyed on the name the two could never be told apart.
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>Hoppers the plant has used</h3>
        <button type="button" style={{ marginLeft: "auto", fontSize: 13 }} disabled={busy} onClick={recheck}>
          {busy ? "Re-checking…" : "Re-check all"}
        </button>
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto", marginBottom: 24 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Hopper</th><th style={TH}>Panel calls it</th>
              <th style={{ ...TH, textAlign: "right" }}>Weighed</th>
              <th style={TH}>Holds</th><th style={TH}>Capacity</th><th style={TH} />
            </tr>
          </thead>
          <tbody>
            {data.seen.map((s) => {
              const a = aliasBySlot.get(s.slot);
              const current = a?.is_refillable ? "— refillable storage —"
                : a?.is_ignored ? "— not a stock material —"
                : a?.target ? a.target : null;
              return (
                <tr key={s.slot} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ ...TD, color: "var(--slate)", fontFamily: "ui-monospace, monospace" }}>{s.slot}</td>
                  <td style={{ ...TD, fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                    {s.slot_name}
                    {s.name_count > 1 && (
                      <div style={{ fontSize: 10.5, color: "var(--amber)", fontFamily: "inherit" }}>
                        renamed on the panel {s.name_count} times
                      </div>
                    )}
                  </td>
                  <td style={{ ...TD, textAlign: "right" }}>{fmtKg(s.actual_kg)}<div style={{ fontSize: 10.5, color: "var(--slate)" }}>{s.batches} batches</div></td>
                  <td style={TD}>
                    <select aria-label={`What ${s.slot_name} holds`}
                            value={draft[s.slot] || ""}
                            onChange={(e) => setDraft({ ...draft, [s.slot]: e.target.value })}
                            style={{ fontSize: 13, minWidth: 214 }}>
                      <option value="">{current || "Choose…"}</option>
                      <option value="refill">— refillable storage —</option>
                      {data.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      <option value="ignore">— not a stock material —</option>
                    </select>
                  </td>
                  <td style={TD}>
                    {a?.is_ignored ? (
                      <span style={{ fontSize: 11.5, color: "var(--slate)" }}>—</span>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <input type="number" min="0" step="0.1" style={{ fontSize: 13, width: 74 }}
                               value={capDraft[s.slot] ?? (a?.capacity_kg != null ? String(toSiloUnit(a.capacity_kg, kindBySlot.get(s.slot))) : "")}
                               onChange={(e) => setCapDraft({ ...capDraft, [s.slot]: e.target.value })} />
                        <span style={{ fontSize: 11, color: "var(--slate)" }}>{siloUnit(kindBySlot.get(s.slot))}</span>
                      </div>
                    )}
                  </td>
                  <td style={TD}>
                    <button type="button" className="btn-primary" style={{ fontSize: 12 }}
                            disabled={!draft[s.slot] && !Object.prototype.hasOwnProperty.call(capDraft, s.slot)}
                            onClick={() => save(s.slot, s.slot_name)}>
                      Save
                    </button>
                  </td>
                </tr>
              );
            })}
            {!data.seen.length && (
              <tr><td colSpan={6} style={{ ...TD, color: "var(--slate)" }}>
                Nothing synced yet — the plant agent has not sent anything.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

// ROUND 187 (v10.16) — rebuilt. The old screen saved each box on blur, and its
// boxes were uncontrolled (defaultValue), so when the day changed they kept the
// figures typed for the previous day and the next blur saved them against the
// new day. Now: the screen holds a DRAFT for the chosen day, built fresh from the
// server every time the day changes; nothing is stored until Save is pressed;
// Save sends the whole day at once (POST /plant/manual/day) so the stored day is
// exactly what is on screen; Discard throws the draft away. Saved days are listed
// underneath with an Edit button. Consumption can be typed in tonnes or kg — the
// table shows tonnes, and typing kg into a tonnes-looking table was how 0.71 kg
// got saved where 0.71 t was meant.
function fmtQty(kg, unit) {
  if (kg == null || kg === "" || Number(kg) === 0) return "";
  const v = unit === "t" ? Number(kg) / 1000 : Number(kg);
  return String(Math.round(v * 1000) / 1000);
}
function toKg(v, unit) {
  if (v === "" || v == null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return unit === "t" ? n * 1000 : n;
}

function Manual({ canEdit }) {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unit, setUnit] = useState("t");           // consumption entry unit
  const [draft, setDraft] = useState(null);        // { m3, reason, qty: { [materialId]: string in `unit` } }
  const [saving, setSaving] = useState(false);
  const [days, setDays] = useState([]);
  const [addId, setAddId] = useState("");
  const [extra, setExtra] = useState([]);          // material ids added by hand for this day
  // Round 188 (v10.17 #8) — manual production by recipe; consumption is worked
  // out from each recipe's targets. calcIds = materials the last calculation
  // filled, so removing a recipe line also removes what it contributed.
  const [calcIds, setCalcIds] = useState([]);
  const [calcNote, setCalcNote] = useState("");
  const calcTimer = useRef(null);

  function linesFrom(d) {
    const prod = d.entries.find((e) => e.material_id == null);
    const ls = Array.isArray(prod?.recipe_lines) ? prod.recipe_lines : [];
    return ls.map((l) => ({ recipe_code: l.recipe_code, m3: String(Number(l.m3)) }));
  }
  function draftFrom(d, u) {
    const qty = {};
    for (const e of d.entries) if (e.material_id != null) qty[e.material_id] = fmtQty(e.qty_kg, u);
    const prod = d.entries.find((e) => e.material_id == null);
    return { m3: prod ? String(Number(prod.qty_m3)) : "", reason: (d.entries.find((e) => e.reason)?.reason) || "", qty, lines: linesFrom(d) };
  }

  async function recalc(lines) {
    const clean = lines.filter((l) => l.recipe_code && Number(l.m3) > 0).map((l) => ({ recipe_code: l.recipe_code, m3: Number(l.m3) }));
    setCalcNote("");
    try {
      const r = await apiRequest("/plant/manual/calc", { method: "POST", body: { recipe_lines: clean } });
      setDraft((dr) => {
        if (!dr) return dr;
        const qty = { ...dr.qty };
        for (const id of calcIds) qty[id] = "";
        for (const m of r.materials) qty[m.material_id] = fmtQty(m.kg, unit);
        return { ...dr, qty };
      });
      setExtra((ex) => [...new Set([...ex, ...r.materials.map((m) => m.material_id)])]);
      setCalcIds(r.materials.map((m) => m.material_id));
      const warn = [];
      if (r.unknown_recipes.length) warn.push(`no targets for ${r.unknown_recipes.join(", ")}`);
      if (r.unmapped_slots.length) warn.push(`hopper${r.unmapped_slots.length === 1 ? "" : "s"} ${r.unmapped_slots.join(", ")} not mapped to a material (Silos tab)`);
      setCalcNote(clean.length
        ? `Consumption worked out from ${clean.length} recipe line${clean.length === 1 ? "" : "s"}${warn.length ? ` — ${warn.join("; ")}` : ""}. You can still correct any figure.`
        : "");
    } catch (err) { setCalcNote(err.message); }
  }
  function setLines(lines) {
    setDraft({ ...draft, lines });
    setNotice("");
    clearTimeout(calcTimer.current);
    calcTimer.current = setTimeout(() => recalc(lines), 450);
  }

  async function load(d) {
    setError(""); setData(null); setDraft(null); setExtra([]); setAddId(""); setCalcIds([]); setCalcNote("");
    try {
      const res = await apiRequest(`/plant/manual?date=${d}`);
      setData(res);
      setDraft(draftFrom(res, unit));
    } catch (err) { setError(err.message || "Could not load the day."); }
  }
  async function loadDays() {
    try { setDays(await apiRequest("/plant/manual/days?days=180")); } catch { /* list is a convenience */ }
  }
  useEffect(() => { load(date); }, [date]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadDays(); }, []);

  // Switching the entry unit converts what is already typed, so a figure never
  // silently changes meaning.
  function switchUnit(u) {
    if (u === unit || !draft) return;
    const qty = {};
    for (const [k, v] of Object.entries(draft.qty)) qty[k] = v === "" ? "" : fmtQty(toKg(v, unit), u);
    setDraft({ ...draft, qty });
    setUnit(u);
  }

  if (!data || !draft) return <div className="card" style={{ fontSize: 13, color: error ? "var(--alert-red)" : "var(--slate)" }}>{error || "Loading…"}</div>;

  const savedQty = {};
  for (const e of data.entries) if (e.material_id != null) savedQty[e.material_id] = Number(e.qty_kg);
  const savedProd = data.entries.find((e) => e.material_id == null);
  const savedM3 = savedProd ? Number(savedProd.qty_m3) : 0;
  const savedReason = (data.entries.find((e) => e.reason)?.reason) || "";

  // Rows: what the plant weighed that day, plus any material with a saved
  // manual figure, plus any the operator added for this day. Unmapped hoppers
  // are shown (their weight is real) but cannot take a manual figure.
  const nameById = new Map((data.materials || []).map((m) => [m.id, m.name]));
  const rows = data.consumption.map((c) => ({ key: c.material_id ?? `x-${c.slot}`, material_id: c.material_id, name: c.material_name, slot: c.slot, auto: Number(c.auto_kg || 0) }));
  const inRows = new Set(rows.filter((r) => r.material_id != null).map((r) => r.material_id));
  for (const id of [...Object.keys(savedQty).map(Number), ...extra]) {
    if (!inRows.has(id)) { rows.push({ key: id, material_id: id, name: nameById.get(id) || `Material #${id}`, slot: null, auto: 0 }); inRows.add(id); }
  }
  const addable = (data.materials || []).filter((m) => !inRows.has(m.id));

  const lineTotal = (draft.lines || []).reduce((t, l) => t + (Number(l.m3) > 0 ? Number(l.m3) : 0), 0);
  const byRecipe = (draft.lines || []).length > 0;
  const draftM3 = byRecipe ? Math.round(lineTotal * 1000) / 1000 : (draft.m3 === "" ? 0 : Number(draft.m3));
  const linesKey = (ls) => JSON.stringify((ls || []).map((l) => [l.recipe_code, Number(l.m3) || 0]));
  const autoM3 = Number(data.production?.auto_m3 || 0);
  let invalid = !Number.isFinite(draftM3) || draftM3 < 0;
  const draftKg = {};
  for (const r of rows) {
    if (r.material_id == null) continue;
    const kg = toKg(draft.qty[r.material_id] ?? "", unit);
    if (!Number.isFinite(kg) || kg < 0) invalid = true;
    draftKg[r.material_id] = Number.isFinite(kg) ? kg : 0;
  }
  const close = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.005;
  const dirty = !close(draftM3, savedM3)
    || linesKey(draft.lines) !== linesKey(linesFrom(data))
    || (draft.reason || "") !== savedReason
    || rows.some((r) => r.material_id != null && !close(draftKg[r.material_id], savedQty[r.material_id] || 0));

  function setQty(id, v) { setDraft({ ...draft, qty: { ...draft.qty, [id]: v } }); setNotice(""); }

  async function saveDay() {
    if (invalid) { setError("Every figure must be a number of zero or more."); return; }
    if ((draft.lines || []).some((l) => (l.recipe_code && !(Number(l.m3) > 0)) || (!l.recipe_code && Number(l.m3) > 0))) {
      setError("Every recipe line needs a recipe and its m³."); return;
    }
    setSaving(true); setError(""); setNotice("");
    try {
      const materials = rows.filter((r) => r.material_id != null).map((r) => ({ material_id: r.material_id, qty_kg: draftKg[r.material_id] || 0 }));
      const r = await apiRequest("/plant/manual/day", {
        method: "POST",
        body: {
          entry_date: date, production_m3: draftM3 || 0, reason: draft.reason || null, materials,
          recipe_lines: (draft.lines || []).filter((l) => l.recipe_code && Number(l.m3) > 0).map((l) => ({ recipe_code: l.recipe_code, m3: Number(l.m3) })),
        },
      });
      setNotice(r.cleared
        ? `Manual entry for ${fmtDay(date)} cleared — only the plant's own figures remain.`
        : `Saved for ${fmtDay(date)}. The plant's own figures are untouched — this is added to them.`);
      await load(date);
      await loadDays();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  function changeDate(d) {
    if (!d || d === date) return;
    setNotice("");
    setDate(d);   // the draft is rebuilt from the server for the new day; nothing carries over
  }

  const inputStyle = { width: 110, textAlign: "right", fontSize: 13 };

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 14, color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 14, color: "var(--signal-green)", fontSize: 13 }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ fontSize: 11.5, color: "var(--slate)", display: "flex", flexDirection: "column", gap: 3 }}>Day
          <input type="date" value={date} max={todayStr()} onChange={(e) => changeDate(e.target.value)} style={{ fontSize: 13 }} />
        </label>
        <p style={{ margin: 0, fontSize: 12, color: "var(--slate)", lineHeight: 1.55, maxWidth: 720 }}>
          The plant's column cannot be edited — it is what the load cells weighed. Enter <strong style={{ color: "var(--charcoal)" }}>only
          what the plant did not record</strong> (a hand mix, a load batched while the agent was offline), then press
          <strong style={{ color: "var(--charcoal)" }}> Save</strong>. Nothing is stored until you do, and changing the day
          discards anything not saved.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 20 }}>
        <div className="card">
          <div className="kpi-label">Production — from the plant</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{autoM3.toFixed(1)} <span style={{ fontSize: 15, color: "var(--slate)" }}>m³</span></div>
          <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{data.production?.loads ?? 0} loads · {data.production?.batches ?? 0} batches</div>
        </div>
        <div className="card" style={{ background: "var(--amber-bg)" }}>
          <label htmlFor="manm3" className="kpi-label">Production — manual (m³)</label>
          <input id="manm3" type="number" step="0.5" min="0" disabled={!canEdit || byRecipe}
                 value={byRecipe ? String(draftM3) : draft.m3} placeholder="0"
                 onChange={(e) => { setDraft({ ...draft, m3: e.target.value }); setNotice(""); }}
                 style={{ width: "100%", fontSize: 22, fontWeight: 700, padding: "2px 6px" }} />
          <div style={{ fontSize: 11, color: "var(--amber)", marginTop: 3 }}>
            {byRecipe ? "total of the recipe lines below" : "m³ the plant did not record — or enter it by recipe below"}{savedProd ? ` · saved: ${savedM3} m³` : ""}
          </div>
        </div>
        <div className="card" style={{ background: "var(--signal-green-bg)" }}>
          <div className="kpi-label">Total for the day</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{(autoM3 + (Number.isFinite(draftM3) ? draftM3 : 0)).toFixed(1)} <span style={{ fontSize: 15, color: "var(--slate)" }}>m³</span></div>
          <div style={{ fontSize: 11.5, color: "var(--signal-green)" }}>{dirty ? "includes unsaved changes" : "this is what cost per m³ divides by"}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>Manual production by recipe</h3>
          <span style={{ fontSize: 12, color: "var(--slate)" }}>
            Each line's consumption is worked out from that recipe's targets (MCI370 Recipe Master) and filled into the
            Manual column below — correct any figure before saving if what was really used differed.
          </span>
        </div>
        <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {(draft.lines || []).map((l, i) => (
              <tr key={i}>
                <td style={{ padding: "3px 8px 3px 0" }}>
                  <select value={l.recipe_code} disabled={!canEdit} aria-label="Recipe"
                          onChange={(e) => setLines(draft.lines.map((x, j) => (j === i ? { ...x, recipe_code: e.target.value } : x)))}
                          style={{ fontSize: 13, minWidth: 150 }}>
                    <option value="">Recipe…</option>
                    {(data.recipes || []).map((r) => <option key={r.recipe_code} value={r.recipe_code}>{r.recipe_code}{r.recipe_name && r.recipe_name !== r.recipe_code ? ` — ${r.recipe_name}` : ""}</option>)}
                    {l.recipe_code && !(data.recipes || []).some((r) => r.recipe_code === l.recipe_code) && <option value={l.recipe_code}>{l.recipe_code}</option>}
                  </select>
                </td>
                <td style={{ padding: "3px 8px" }}>
                  <input type="number" step="0.5" min="0" disabled={!canEdit} value={l.m3} placeholder="m³" aria-label="m³"
                         onChange={(e) => setLines(draft.lines.map((x, j) => (j === i ? { ...x, m3: e.target.value } : x)))}
                         style={{ width: 90, textAlign: "right", fontSize: 13 }} /> m³
                </td>
                <td>
                  {canEdit && <button type="button" style={{ fontSize: 12 }} onClick={() => setLines(draft.lines.filter((_, j) => j !== i))}>Remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {canEdit && (
          <button type="button" style={{ fontSize: 12, marginTop: 6 }}
                  onClick={() => setDraft({ ...draft, lines: [...(draft.lines || []), { recipe_code: "", m3: "" }] })}>
            ＋ Add recipe line
          </button>
        )}
        {calcNote && <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 8 }}>{calcNote}</div>}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "0 0 10px", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>Consumption</h3>
        <label style={{ fontSize: 12, color: "var(--slate)", marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          Enter manual figures in
          <select value={unit} onChange={(e) => switchUnit(e.target.value)} style={{ fontSize: 12.5 }}>
            <option value="t">tonnes (t)</option>
            <option value="kg">kilograms (kg)</option>
          </select>
        </label>
      </div>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Material</th>
              <th style={{ ...TH, textAlign: "right" }}>From the plant</th>
              <th style={{ ...TH, textAlign: "right" }}>Manual ({unit})</th>
              <th style={{ ...TH, textAlign: "right" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const man = r.material_id != null ? (draftKg[r.material_id] || 0) : 0;
              const changed = r.material_id != null && !close(man, savedQty[r.material_id] || 0);
              return (
                <tr key={r.key} style={{ borderTop: "1px solid var(--border)", background: changed ? "#FFFCF2" : undefined }}>
                  <td style={TD}>
                    {r.name || <span style={{ color: "var(--amber)" }}>not mapped yet</span>}
                    {r.slot && <div style={{ fontSize: 10.5, color: "var(--slate)", fontFamily: "ui-monospace, monospace" }}>{r.slot}</div>}
                  </td>
                  <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>{r.auto ? fmtKg(r.auto) : "—"}</td>
                  <td style={{ ...TD, textAlign: "right" }}>
                    {r.material_id != null ? (
                      <input type="number" step={unit === "t" ? "0.01" : "1"} min="0" disabled={!canEdit}
                             value={draft.qty[r.material_id] ?? ""} placeholder="0"
                             aria-label={`Manual consumption of ${r.name} in ${unit}`}
                             onChange={(e) => setQty(r.material_id, e.target.value)}
                             style={inputStyle} />
                    ) : <span style={{ color: "var(--slate)" }} title="Map this hopper on the Silos tab first">—</span>}
                    {changed && <div style={{ fontSize: 10, color: "var(--amber)" }}>unsaved</div>}
                  </td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 700 }}>{fmtKg(r.auto + man)}</td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr><td colSpan={4} style={{ ...TD, color: "var(--slate)" }}>The plant batched nothing on this day. Add a material below to enter what was used.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <>
          {addable.length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
              <select value={addId} onChange={(e) => setAddId(e.target.value)} style={{ fontSize: 12.5 }}>
                <option value="">Add a material the plant did not weigh…</option>
                {addable.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <button type="button" style={{ fontSize: 12 }} disabled={!addId}
                      onClick={() => { setExtra([...extra, Number(addId)]); setAddId(""); }}>Add row</button>
            </div>
          )}

          <div className="card" style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label style={{ fontSize: 11.5, color: "var(--slate)", display: "flex", flexDirection: "column", gap: 3, flex: "1 1 280px" }}>
              Reason (why the plant did not record this)
              <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                     placeholder="e.g. agent offline 10:00–12:30, hand mix for site repair" style={{ fontSize: 13 }} />
            </label>
            <button type="button" className="btn-primary" disabled={!dirty || saving || invalid} onClick={saveDay} style={{ fontSize: 13 }}>
              {saving ? "Saving…" : `Save ${fmtDay(date)}`}
            </button>
            <button type="button" disabled={!dirty || saving} onClick={() => { setDraft(draftFrom(data, unit)); setExtra([]); setCalcIds([]); setCalcNote(""); setError(""); }} style={{ fontSize: 13 }}>
              Discard changes
            </button>
            <span style={{ fontSize: 11.5, color: dirty ? "var(--amber)" : "var(--slate)", flexBasis: "100%" }}>
              {dirty ? "You have unsaved changes for this day." : "Saved figures are shown. Change any box and press Save to edit; clear a box (or 0) to remove it."}
            </span>
          </div>
        </>
      )}

      {!canEdit && (
        <p style={{ fontSize: 12, color: "var(--slate)", marginTop: 12 }}>
          You can see these figures but not add to them. That is the Plant Operator's entry.
        </p>
      )}

      <h3 style={{ fontSize: 15, margin: "22px 0 8px" }}>Saved manual entries</h3>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Day</th>
              <th style={{ ...TH, textAlign: "right" }}>Production</th>
              <th style={{ ...TH, textAlign: "right" }}>Consumption</th>
              <th style={TH}>Reason</th>
              <th style={TH}>Entered by</th>
              <th style={TH} />
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.entry_date} style={{ borderTop: "1px solid var(--border)", background: d.entry_date === date ? "var(--concrete)" : undefined }}>
                <td style={{ ...TD, fontWeight: 600, whiteSpace: "nowrap" }}>{fmtDay(d.entry_date)} {d.entry_date.slice(0, 4)}</td>
                <td style={{ ...TD, textAlign: "right" }}>{Number(d.production_m3) > 0 ? fmtM3(d.production_m3) : "—"}</td>
                <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap" }}>{d.materials ? `${fmtKg(d.consumption_kg)} · ${d.materials} material${d.materials === 1 ? "" : "s"}` : "—"}</td>
                <td style={{ ...TD, color: "var(--slate)", fontSize: 12 }}>{d.reason || "—"}</td>
                <td style={{ ...TD, color: "var(--slate)", fontSize: 12, whiteSpace: "nowrap" }}>{d.entered_by_name || "—"} · {fmtWhen(d.entered_at)}</td>
                <td style={{ ...TD, textAlign: "right" }}>
                  <button type="button" style={{ fontSize: 12 }} disabled={d.entry_date === date}
                          onClick={() => { changeDate(d.entry_date); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                    {canEdit ? "Edit" : "View"}
                  </button>
                </td>
              </tr>
            ))}
            {!days.length && <tr><td colSpan={6} style={{ ...TD, color: "var(--slate)" }}>No manual entries in the last 180 days.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// ROUND 160 — the QC delay allowance behind the ticket's finish time.
//
// BPR107a.xlsm used to compute its own finish time. That formula is gone, so
// MixTrack writes cell K21, and what it writes is the plant's end time plus
// this allowance — because plant QC procedure runs on past the mixer
// finishing, and the ticket should say when the load was released.
//
// Site beats customer. The delay belongs to the pour, not to who is paying.
function QcDelays({ canEdit }) {
  const [rows, setRows] = useState([]);
  // Round 188 (v10.17 #5) — the plant's own customer and site names (what a
  // MixTrack docket carries), not the app's customer master. The old screen
  // asked "/customers" and "/sites", which do not exist, so its lists were empty.
  const [targets, setTargets] = useState({ customers: [], sites: [] });
  const [scope, setScope] = useState("site");
  const [target, setTarget] = useState("");
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");

  const load = () => apiRequest("/plant/qc-delays").then(setRows).catch((e) => setMsg(e.message));
  useEffect(() => {
    load();
    apiRequest("/plant/qc-delays/targets").then((t) => setTargets(t || { customers: [], sites: [] })).catch((e) => setMsg(e.message));
  }, []);

  async function save(e) {
    e.preventDefault();
    setMsg("");
    const body = { delay_minutes: Number(minutes), note: note || null };
    if (scope === "site") body.site_text = target;
    else if (scope === "customer") body.customer_text = target;
    try {
      await apiRequest("/plant/qc-delays", { method: "POST", body });
      setMinutes(""); setNote(""); setTarget("");
      load();
    } catch (err) { setMsg(err.message); }
  }

  const list = scope === "site" ? targets.sites : scope === "customer" ? targets.customers : [];

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>QC delay allowance</h3>
      <p style={{ fontSize: 13, color: "var(--muted)", maxWidth: 720 }}>
        Added to the plant's own finish time before it is printed on the MixTrack ticket, so the time shown is
        when the load was released rather than when the last batch dropped. Customers and sites are listed exactly as
        the plant (MCI370) records them — that is what a ticket carries. A rule for a site beats a rule for a customer;
        a rule with neither applies to every load that has no more specific rule.
      </p>

      {canEdit && (
        <form onSubmit={save} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
          <label style={{ fontSize: 13 }}>Applies to<br />
            <select value={scope} onChange={(e) => { setScope(e.target.value); setTarget(""); }}>
              <option value="site">A site</option>
              <option value="customer">A customer</option>
              <option value="default">Every load (default)</option>
            </select>
          </label>
          {scope !== "default" && (
            <label style={{ fontSize: 13 }}>{scope === "site" ? "Site (as the plant records it)" : "Customer (as the plant records it)"}<br />
              <select value={target} onChange={(e) => setTarget(e.target.value)} required style={{ maxWidth: 360 }}>
                <option value="">Choose… ({list.length})</option>
                {list.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}{scope === "site" && t.customer ? ` — ${t.customer}` : ""} · {t.loads} load{t.loads === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label style={{ fontSize: 13 }}>Minutes<br />
            <input type="number" min="0" max="240" value={minutes} required
                   onChange={(e) => setMinutes(e.target.value)} style={{ width: 90 }} />
          </label>
          <label style={{ fontSize: 13, flex: "1 1 200px" }}>Why<br />
            <input value={note} onChange={(e) => setNote(e.target.value)}
                   placeholder="slump check before release" style={{ width: "100%" }} />
          </label>
          <button type="submit" className="btn-primary">Save</button>
        </form>
      )}
      {msg && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{msg}</div>}

      <table className="table">
        <thead><tr><th>Applies to</th><th style={{ textAlign: "right" }}>Minutes</th><th>Why</th><th>Changed</th>{canEdit && <th />}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.site_name ? `Site — ${r.site_name}` : r.customer_name ? `Customer — ${r.customer_name}` : "Every load"}
                {(r.site_id || r.customer_id) && !r.site_text && !r.customer_text && (
                  <div style={{ fontSize: 11, color: "var(--amber)" }}>older rule set against the app customer list — new MixTrack tickets carry the plant’s names, so re-create it above with the plant’s name</div>
                )}
              </td>
              <td style={{ textAlign: "right" }}>{r.delay_minutes}</td>
              <td style={{ color: "var(--muted)" }}>{r.note || "—"}</td>
              <td style={{ color: "var(--muted)", fontSize: 12 }}>{r.updated_at}{r.updated_by_name ? ` · ${r.updated_by_name}` : ""}</td>
              {canEdit && (
                <td><button type="button" className="btn-link"
                        onClick={() => apiRequest(`/plant/qc-delays/${r.id}`, { method: "DELETE" }).then(load)}>Remove</button></td>
              )}
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={canEdit ? 5 : 4} style={{ textAlign: "center", color: "var(--muted)" }}>
            No allowance set — tickets show the plant's own finish time.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default function PlantProduction() {
  const { can, ready } = usePermissions();
  // Round 192 — every tab is its own function now, switched per role on the
  // Super Admin's Access Control page (Plant Production module). Round 187's
  // "not for the Plant Operator" on Plant vs billed is that key's default.
  const [tab, setTab] = useState("");
  const [days, setDays] = useState(30);          // a number, or "custom"
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [summary, setSummary] = useState(null);

  const canView = ready && can("module.plant-production", "view");
  const canProd = ready && can("plant.production", "view");
  const canCons = ready && can("plant.consumption", "view");
  const canKpi = ready && can("plant.kpi", "view");
  const canPvb = ready && can("plant.vs-billed", "view");
  const canCost = ready && can("plant.cost", "view");
  const canMap = ready && can("production.plant-mapping", "view");
  const canManualView = ready && can("production.plant-manual", "view");
  const canManualEdit = ready && can("production.plant-manual", "create");
  // Round 160 — Administrator changes it, Manager may look. Deliberately not
  // the Plant Operator's: this moves a time printed on a customer's document.
  const canQcDelayView = ready && can("production.mixtrack-qc-delay", "view");
  const canQcDelayEdit = ready && can("production.mixtrack-qc-delay", "create");

  // The first tab this person may open, in screen order.
  const firstTab = [["production", canProd], ["pvb", canPvb], ["consumption", canCons], ["silos", canMap],
    ["manual", canManualView], ["cost", canCost], ["qc-delay", canQcDelayView]].find((t) => t[1])?.[0] || "";
  useEffect(() => {
    if (ready && !tab && firstTab) setTab(firstTab);
  }, [ready, firstTab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!canKpi) return;
    let alive = true;
    const pull = () => apiRequest("/plant/summary").then((s) => { if (alive) setSummary(s); }).catch(() => {});
    pull();
    const id = setInterval(pull, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [canKpi]);

  if (!ready) return null;
  if (!canView) {
    return (
      <>
        <TopBar title="Plant Production" />
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 32px" }}>
          <div className="card" style={{ fontSize: 13 }}>
            You do not have access to the plant data. A Super Admin can grant it on the Access
            Control page.
          </div>
        </div>
      </>
    );
  }

  const heartbeat = ago(summary?.last_sync_at);

  // The period selector (and custom range) applies to the reporting tabs only.
  const periodTab = tab === "production" || tab === "consumption" || tab === "cost" || tab === "pvb";
  // A valid custom range wins; otherwise fall back to the days preset (and to
  // 30 while a custom range is half-filled).
  const qs = (days === "custom" && from && to)
    ? `from_date=${from}&to_date=${to}`
    : `days=${days === "custom" ? 30 : days}`;

  // Round 189 — one picker, placed beside the tabs on a desk and on its own
  // full-width row on a phone (pp-only-wide / pp-only-narrow in index.css).
  const periodPicker = (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <select aria-label="Period" value={days}
              onChange={(e) => setDays(e.target.value === "custom" ? "custom" : Number(e.target.value))}
              style={{ fontSize: 13 }}>
        <option value={1}>Today</option>
        <option value={7}>Last 7 days</option>
        <option value={30}>Last 30 days</option>
        <option value={90}>Last 90 days</option>
        <option value="custom">Custom range…</option>
      </select>
      {days === "custom" && (
        <>
          <input type="date" aria-label="From" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} style={{ fontSize: 12.5 }} />
          <span style={{ fontSize: 12, color: "var(--slate)" }}>to</span>
          <input type="date" aria-label="To" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} style={{ fontSize: 12.5 }} />
        </>
      )}
    </div>
  );

  return (
    <>
      <TopBar title="Plant Production" />
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 32px" }}>

        {canKpi && (
        <div className="card pp-kpis" style={{ marginBottom: 16, display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div className="kpi-label">Made today</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{summary ? fmtM3(summary.today_m3) : "—"}</div>
            {Number(summary?.today_manual_m3) > 0 && (
              <div style={{ fontSize: 11, color: "var(--slate)" }}>incl. {fmtM3(summary.today_manual_m3)} manual</div>
            )}
          </div>
          <div>
            <div className="kpi-label">Loads today</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{summary?.today_loads ?? "—"}</div>
            <div style={{ fontSize: 11, color: "var(--slate)" }}>{summary?.today_batches ?? "—"} batches</div>
          </div>
          <div>
            <div className="kpi-label">Grades run</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{summary?.today_recipes ?? "—"}</div>
          </div>
          {!!summary?.unmapped_silos && (
            <div>
              <div className="kpi-label">Silos to map</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--amber)" }}>{summary.unmapped_silos}</div>
            </div>
          )}
          <div className="pp-agent" style={{ marginLeft: "auto", textAlign: "right" }}>
            <div className="kpi-label">Plant agent</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: heartbeat.stale ? "var(--alert-red)" : "var(--signal-green)" }}>
              {heartbeat.stale ? "Last seen " : "Live · "}{heartbeat.text}
            </div>
            {summary?.last_sync_error && (
              <div style={{ fontSize: 11, color: "var(--alert-red)", maxWidth: 320 }}>{summary.last_sync_error}</div>
            )}
          </div>
        </div>
        )}

        {canKpi && heartbeat.stale && summary && (
          <div className="card" style={{ marginBottom: 16, background: "var(--alert-red-bg)", borderColor: "var(--alert-red)", fontSize: 13 }}>
            The plant PC has not sent anything recently. Nothing is lost — every batch is still in
            MCI370 and arrives once the agent is back — but nothing here is current until then.
          </div>
        )}

        <div className="pp-tabs" style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
          {canProd && (
            <button type="button" className={`btn-tab ${tab === "production" ? "active" : ""}`} onClick={() => setTab("production")}>Production</button>
          )}
          {canPvb && (
            <button type="button" className={`btn-tab ${tab === "pvb" ? "active" : ""}`} onClick={() => setTab("pvb")}>Plant vs billed</button>
          )}
          {canCons && (
            <button type="button" className={`btn-tab ${tab === "consumption" ? "active" : ""}`} onClick={() => setTab("consumption")}>Consumption</button>
          )}
          {canMap && (
            <button type="button" className={`btn-tab ${tab === "silos" ? "active" : ""}`} onClick={() => setTab("silos")}>Silos</button>
          )}
          {/* Round 159 — what the plant did not record. Shown to anyone who can
              read the plant data; only the Plant Operator can type into it. */}
          {canManualView && (
            <button type="button" className={`btn-tab ${tab === "manual" ? "active" : ""}`} onClick={() => setTab("manual")}>Manual entry</button>
          )}
          {canCost && (
            <button type="button" className={`btn-tab ${tab === "cost" ? "active" : ""}`} onClick={() => setTab("cost")}>Cost/m³ – Material</button>
          )}
          {canQcDelayView && (
            <button type="button" className={`btn-tab ${tab === "qc-delay" ? "active" : ""}`} onClick={() => setTab("qc-delay")}>QC delay</button>
          )}
          {periodTab && (
            <div className="pp-only-wide" style={{ marginLeft: "auto" }}>{periodPicker}</div>
          )}
        </div>
        {periodTab && <div className="pp-only-narrow pp-period">{periodPicker}</div>}

        {days === "custom" && periodTab && !(from && to) && (
          <div className="card" style={{ marginBottom: 16, fontSize: 12.5, color: "var(--slate)" }}>
            Pick both a From and a To date; showing the last 30 days until then.
          </div>
        )}

        {tab === "silos" && canMap ? <Silos />
          : tab === "qc-delay" && canQcDelayView ? <QcDelays canEdit={canQcDelayEdit} />
          : tab === "manual" && canManualView ? <Manual canEdit={canManualEdit} />
          : tab === "cost" && canCost ? <CostPerM3 qs={qs} />
          : tab === "consumption" && canCons ? <Consumption qs={qs} />
          : tab === "pvb" && canPvb ? <PlantVsBilled qs={qs} />
          : tab === "production" && canProd ? <Production qs={qs} />
          : !firstTab ? (
            <div className="card" style={{ fontSize: 13 }}>
              No Plant Production screens are switched on for you. A Super Admin can grant them on the Access Control page.
            </div>
          ) : null}
      </div>
    </>
  );
}
