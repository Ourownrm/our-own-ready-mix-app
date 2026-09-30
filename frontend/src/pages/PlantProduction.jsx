import { useEffect, useState } from "react";
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
// Cement, fly-ash and aggregate are weighed in tonnes; water and admixture in
// kilolitres (≈ kg at ~unit density, which is all the yard view needs). The
// stored figure is always kg — this is display only, and the same convention
// is used for the capacity input so what is typed matches what is shown.
function siloUnit(kind) { return kind === "liquid" ? "kL" : "MT"; }
function toSiloUnit(kg) { return kg == null ? null : Number(kg) / 1000; }
function fromSiloUnit(v) { return v === "" || v == null ? null : Number(v) * 1000; }
function fmtSiloQty(kg) {
  if (kg == null) return "—";
  const v = Number(kg) / 1000;
  return v.toLocaleString(undefined, { maximumFractionDigits: v >= 10 ? 0 : 1 });
}

// ---------------------------------------------------------------------------

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

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div className="card">
          <h3 style={{ fontSize: 14, margin: "0 0 12px" }}>By day</h3>
          {!data.by_day.length && <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing batched in this period.</div>}
          {data.by_day.map((d) => (
            <div key={d.batch_date} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 7 }}>
              <span style={{ fontSize: 12.5, width: 62, color: "var(--slate)" }}>{fmtDay(d.batch_date)}</span>
              {/* A plain proportional bar rather than a chart library — one
                  series, one dimension, and it has to be readable on the plant
                  office screen at a glance. */}
              <span style={{ flexGrow: 1, height: 16, background: "var(--concrete)", borderRadius: 3, overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${(Number(d.m3) / maxDay) * 100}%`, background: "var(--rebar)" }} />
              </span>
              <span style={{ fontSize: 12.5, width: 74, textAlign: "right", fontWeight: 600 }}>{fmtM3(d.m3)}</span>
              <span style={{ fontSize: 11.5, width: 62, textAlign: "right", color: "var(--slate)" }}>{d.loads} loads</span>
            </div>
          ))}
        </div>

        <div className="card">
          <h3 style={{ fontSize: 14, margin: "0 0 12px" }}>By recipe</h3>
          {!data.by_recipe.length && <div style={{ fontSize: 13, color: "var(--slate)" }}>—</div>}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {data.by_recipe.map((r) => (
                <tr key={r.recipe_code} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ ...TD, fontWeight: 600 }}>{r.recipe_code}</td>
                  <td style={{ ...TD, color: "var(--slate)", fontSize: 12 }}>{r.recipe_name || ""}</td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmtM3(r.m3)}</td>
                  <td style={{ ...TD, textAlign: "right", color: "var(--slate)", fontSize: 12 }}>{r.loads} loads</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h3 style={{ fontSize: 15, margin: "0 0 10px" }}>Recent loads</h3>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Batch</th><th style={TH}>Started</th><th style={TH}>Recipe</th>
              <th style={{ ...TH, textAlign: "right" }}>Made</th><th style={{ ...TH, textAlign: "right" }}>Mixes</th>
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
  const totalKg = data.silos.reduce((a, s) => a + Number(s.actual_kg || 0), 0);

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
          Every figure is what the plant's own load cells weighed, summed across the batches that made
          up each load. Nothing here is derived from a mix design.
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
              <tr><td colSpan={7} style={{ ...TD, color: "var(--slate)" }}>Nothing consumed in this period.</td></tr>
            )}
          </tbody>
        </table>
      </div>

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
            {data.rows.map((r) => (
              <tr key={r.material_id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={TD}>{r.material_name}</td>
                <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap" }}>{fmtKg(r.consumed_kg)}</td>
                <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap", color: r.has_rate ? "inherit" : "var(--amber)" }}>{r.has_rate ? Number(r.rate_per_kg).toFixed(2) : "no rate"}</td>
                <td style={{ ...TD, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{r.cost_per_m3 == null ? "—" : fmtINR(r.cost_per_m3)}</td>
                <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>{r.share_pct == null ? "—" : `${r.share_pct}%`}</td>
              </tr>
            ))}
            {!data.rows.length && <tr><td style={TD} colSpan={5}><span style={{ color: "var(--slate)" }}>No consumption in this period.</span></td></tr>}
          </tbody>
        </table>
        <div style={{ fontSize: 10.5, color: "var(--slate)", lineHeight: 1.55, padding: "10px 12px" }}>
          <b>Consumed</b> is the plant's load-cell figure <b>plus</b> the operator's manual entries — never the auto
          figure alone. <b>Rate</b> is the weighted-average landed cost per material from the Material Module{anyMissing
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
    // MT/kL, stored in kg.
    if (capTouched) body.capacity_kg = capDraft[slot] === "" ? "" : fromSiloUnit(capDraft[slot]);
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
              ? <>{fmtSiloQty(l.level_kg)} <span style={{ fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>{siloUnit(l.kind)}</span></>
              : <span style={{ fontSize: 13.5, color: "var(--amber)", fontWeight: 600 }}>no fills yet</span>}
          </div>
          <div style={{ fontSize: 11, color: "var(--slate)" }}>
            {l.capacity_kg != null ? `of ${fmtSiloQty(l.capacity_kg)} ${siloUnit(l.kind)}` : "capacity not set"}
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
                               value={capDraft[s.slot] ?? (a?.capacity_kg != null ? String(toSiloUnit(a.capacity_kg)) : "")}
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

      <h3 style={{ fontSize: 15, margin: "0 0 4px" }}>Silo storage levels</h3>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--slate)", lineHeight: 1.55, maxWidth: 860 }}>
        What each hopper holds right now — receipts assigned to a silo raise its level, the plant's load-cell
        draw lowers it. The highlighted figure is the quantity; capacity, set on the mapping row above, gives
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
          No silo is mapped to a material yet. Map the hoppers above and set their capacities, then assign
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
                    <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{fmtKg(n.qty_kg)}</td>
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
    </>
  );
}

// ---------------------------------------------------------------------------

function Manual({ canEdit }) {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState({});

  async function load(d) {
    setError("");
    try { setData(await apiRequest(`/plant/manual?date=${d}`)); }
    catch (err) { setError(err.message || "Could not load the day."); }
  }
  useEffect(() => { load(date); setDraft({}); }, [date]);

  async function save(materialId, value) {
    setError(""); setNotice("");
    try {
      const body = { entry_date: date, reason: (draft.reason ?? data?.reason ?? "") || undefined };
      if (materialId == null) body.qty_m3 = Number(value || 0);
      else { body.material_id = materialId; body.qty_kg = Number(value || 0); }
      await apiRequest("/plant/manual", { method: "POST", body });
      setNotice("Saved. The plant's own figure is untouched — this is added to it.");
      await load(date);
    } catch (err) { setError(err.message); }
  }

  // Round 166b — surface a load error instead of a frozen "Loading…": when the
  // fetch throws, `data` stays null, so without this the screen never leaves the
  // loading state and the real reason is invisible (exactly the Silos 42703 bug).
  if (!data) return <div className="card" style={{ fontSize: 13, color: error ? "var(--alert-red)" : "var(--slate)" }}>{error || "Loading…"}</div>;

  const manualByMaterial = new Map(data.entries.filter((e) => e.material_id != null).map((e) => [e.material_id, e]));
  const prodManual = data.entries.find((e) => e.material_id == null);
  const autoM3 = Number(data.production?.auto_m3 || 0);
  const manM3 = Number(prodManual?.qty_m3 || 0);

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 14, color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 14, color: "var(--signal-green)", fontSize: 13 }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ fontSize: 11.5, color: "var(--slate)", display: "flex", flexDirection: "column", gap: 3 }}>Day
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ fontSize: 13 }} />
        </label>
        <p style={{ margin: 0, fontSize: 12, color: "var(--slate)", lineHeight: 1.55, maxWidth: 720 }}>
          The plant's column cannot be edited — it is what the load cells weighed, and if it looks wrong that
          is a finding, not a typo. Enter <strong style={{ color: "var(--charcoal)" }}>only what the plant did
          not record</strong>: a hand mix, a load batched while the agent was offline, material taken for
          something else. The two are added.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14, marginBottom: 20 }}>
        <div className="card">
          <div className="kpi-label">Production — from the plant</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{autoM3.toFixed(1)} <span style={{ fontSize: 15, color: "var(--slate)" }}>m³</span></div>
          <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{data.production?.loads ?? 0} loads · {data.production?.batches ?? 0} batches</div>
        </div>
        <div className="card" style={{ background: "var(--amber-bg)" }}>
          <label htmlFor="manm3" className="kpi-label">Production — manual</label>
          <input id="manm3" type="number" step="0.5" min="0" disabled={!canEdit}
                 defaultValue={manM3 || ""} placeholder="0"
                 onBlur={(e) => canEdit && save(null, e.target.value)}
                 style={{ width: "100%", fontSize: 22, fontWeight: 700, padding: "2px 6px" }} />
          <div style={{ fontSize: 11, color: "var(--amber)", marginTop: 3 }}>m³ the plant did not record</div>
        </div>
        <div className="card" style={{ background: "var(--signal-green-bg)" }}>
          <div className="kpi-label">Total today</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{(autoM3 + manM3).toFixed(1)} <span style={{ fontSize: 15, color: "var(--slate)" }}>m³</span></div>
          <div style={{ fontSize: 11.5, color: "var(--signal-green)" }}>this is what cost per m³ divides by</div>
        </div>
      </div>

      <h3 style={{ fontSize: 15, margin: "0 0 10px" }}>Consumption</h3>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Material</th>
              <th style={{ ...TH, textAlign: "right" }}>From the plant</th>
              <th style={{ ...TH, textAlign: "right" }}>Manual</th>
              <th style={{ ...TH, textAlign: "right" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {data.consumption.map((c) => {
              const auto = Number(c.auto_kg || 0);
              const man = Number(manualByMaterial.get(c.material_id)?.qty_kg || 0);
              return (
                <tr key={c.material_id ?? "unmapped"} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={TD}>
                    {c.material_name || <span style={{ color: "var(--amber)" }}>not mapped yet</span>}
                    <div style={{ fontSize: 10.5, color: "var(--slate)", fontFamily: "ui-monospace, monospace" }}>{c.slot}</div>
                  </td>
                  <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>{fmtKg(auto)}</td>
                  <td style={{ ...TD, textAlign: "right" }}>
                    {c.material_id ? (
                      <input type="number" step="1" min="0" disabled={!canEdit}
                             defaultValue={man || ""} placeholder="0"
                             aria-label={`Manual consumption of ${c.material_name}`}
                             onBlur={(e) => canEdit && save(c.material_id, e.target.value)}
                             style={{ width: 96, textAlign: "right", fontSize: 13 }} />
                    ) : <span style={{ color: "var(--slate)" }}>—</span>}
                  </td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 700 }}>{fmtKg(auto + man)}</td>
                </tr>
              );
            })}
            {!data.consumption.length && (
              <tr><td colSpan={4} style={{ ...TD, color: "var(--slate)" }}>The plant batched nothing on this day.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {!canEdit && (
        <p style={{ fontSize: 12, color: "var(--slate)", marginTop: 12 }}>
          You can see these figures but not add to them. That is the Plant Operator's entry.
        </p>
      )}
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
  const [customers, setCustomers] = useState([]);
  const [sites, setSites] = useState([]);
  const [scope, setScope] = useState("site");
  const [targetId, setTargetId] = useState("");
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");

  const load = () => apiRequest("/plant/qc-delays").then(setRows).catch(() => {});
  useEffect(() => {
    load();
    apiRequest("/customers").then((c) => setCustomers(c || [])).catch(() => {});
    apiRequest("/sites").then((s) => setSites(s || [])).catch(() => {});
  }, []);

  async function save(e) {
    e.preventDefault();
    setMsg("");
    const body = { delay_minutes: Number(minutes), note: note || null };
    if (scope === "site") body.site_id = Number(targetId) || null;
    else if (scope === "customer") body.customer_id = Number(targetId) || null;
    try {
      await apiRequest("/plant/qc-delays", { method: "POST", body });
      setMinutes(""); setNote(""); setTargetId("");
      load();
    } catch (err) { setMsg(err.message); }
  }

  const targets = scope === "site" ? sites : scope === "customer" ? customers : [];

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>QC delay allowance</h3>
      <p style={{ fontSize: 13, color: "var(--muted)", maxWidth: 680 }}>
        Added to the plant's own finish time before it is printed on the ticket, so the
        time shown is when the load was released rather than when the last batch dropped.
        A rule for a site beats a rule for that site's customer; a rule with neither
        applies to every load that has no more specific rule.
      </p>

      {canEdit && (
        <form onSubmit={save} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
          <label style={{ fontSize: 13 }}>Applies to<br />
            <select value={scope} onChange={(e) => { setScope(e.target.value); setTargetId(""); }}>
              <option value="site">A site</option>
              <option value="customer">A customer</option>
              <option value="default">Every load (default)</option>
            </select>
          </label>
          {scope !== "default" && (
            <label style={{ fontSize: 13 }}>{scope === "site" ? "Site" : "Customer"}<br />
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)} required>
                <option value="">Choose…</option>
                {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
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
              <td>{r.site_name ? `Site — ${r.site_name}` : r.customer_name ? `Customer — ${r.customer_name}` : "Every load"}</td>
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

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Round 169 — Mix Designs (item 7a). Three read-only views of the lab's mix
// design data on the plant side: Details, Comparison and Costing.
// ---------------------------------------------------------------------------
function fmtRate(n) {
  return n == null ? "—" : "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtKgm3(n) {
  return n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function MixDesignDetails({ id }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setData(null); setError("");
    apiRequest(`/plant/mix-designs/${id}`).then(setData).catch((e) => setError(e.message));
  }, [id]);
  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!data) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;
  const d = data.design;
  const ing = [
    { name: "Cement", src: d.cement_type_source, kg: d.cement_kgm3, sg: d.cement_sp_gr },
    { name: "Fly ash", src: d.fly_ash_type_source, kg: d.fly_ash_kgm3, sg: d.fly_ash_sp_gr },
    { name: "Free water", src: "—", kg: d.free_water_kgm3, sg: 1.0 },
    { name: "Fine aggregate", src: d.fine_agg_type_source, kg: d.fine_agg_kgm3, sg: d.fine_agg_sp_gr },
    { name: "20 mm coarse", src: d.coarse_20mm_type_source, kg: d.coarse_20mm_kgm3, sg: d.coarse_20mm_sp_gr },
    { name: "12.5 mm coarse", src: d.coarse_12_5mm_type_source, kg: d.coarse_12_5mm_kgm3, sg: d.coarse_12_5mm_sp_gr },
    ...data.admixtures.map((a) => ({ name: "Admixture", src: a.type_brand, kg: a.qty_kgm3, sg: a.sp_gr })),
  ];
  const param = (label, value) => (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td style={{ ...TD, color: "var(--slate)" }}>{label}</td>
      <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{value}</td>
    </tr>
  );
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      <div className="card" style={{ flex: 1, minWidth: 290, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: "var(--concrete)" }}><th style={TH} colSpan={2}>Design parameters</th></tr></thead>
          <tbody>
            {param("Grade", d.grade)}
            {param("Design ref / rev", `${d.design_ref_code} · rev ${d.revision}`)}
            {param("Target strength f′ck", `${fmtKgm3(d.fck_28day_mpa)} MPa`)}
            {param("Std deviation", `${fmtKgm3(d.std_deviation_mpa)} MPa`)}
            {param("Target mean strength", `${fmtKgm3(d.target_mean_strength_mpa)} MPa`)}
            {param("Max aggregate size", d.max_agg_size_mm ? `${d.max_agg_size_mm} mm` : "—")}
            {param("Target workability", d.target_workability_mm || "—")}
            {param("Design density", d.design_density_kgm3 ? `${fmtKgm3(d.design_density_kgm3)} kg/m³` : "—")}
            {param("w/c ratio", d.wb_ratio != null ? Number(d.wb_ratio).toFixed(2) : "—")}
            {param("Status", d.status)}
          </tbody>
        </table>
      </div>
      <div className="card" style={{ flex: 1.3, minWidth: 320, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: "var(--concrete)" }}>
            <th style={TH}>Ingredient</th><th style={TH}>Type / source</th>
            <th style={{ ...TH, textAlign: "right" }}>kg/m³</th><th style={{ ...TH, textAlign: "right" }}>Sp. gr</th>
          </tr></thead>
          <tbody>
            {ing.map((r, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={TD}>{r.name}</td>
                <td style={{ ...TD, color: "var(--slate)" }}>{r.src || "—"}</td>
                <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{fmtKgm3(r.kg)}</td>
                <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>{r.sg != null ? Number(r.sg).toFixed(2) : "—"}</td>
              </tr>
            ))}
            <tr style={{ borderTop: "2px solid var(--border)" }}>
              <td style={{ ...TD, fontWeight: 700 }}>Total binder</td><td style={TD} />
              <td style={{ ...TD, textAlign: "right", fontWeight: 700 }}>{fmtKgm3(d.total_binder_kgm3)}</td><td style={TD} />
            </tr>
            <tr>
              <td style={{ ...TD, fontWeight: 700 }}>Total aggregate</td><td style={TD} />
              <td style={{ ...TD, textAlign: "right", fontWeight: 700 }}>{fmtKgm3(d.total_aggregate_kgm3)}</td><td style={TD} />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MixDesignComparison() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    apiRequest("/plant/mix-designs-comparison").then(setRows).catch((e) => setError(e.message));
  }, []);
  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!rows) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;
  if (!rows.length) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>No standard designs to compare yet.</div>;
  const R = { ...TD, textAlign: "right" };
  return (
    <>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--slate)", maxWidth: 820, lineHeight: 1.55 }}>
        Every grade's standard approved design side by side — cement, binder, the water/cement spread and the
        aggregate total.
      </p>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: "var(--concrete)" }}>
            <th style={TH}>Grade</th><th style={R}>Cement</th><th style={R}>Fly ash</th><th style={R}>Binder</th>
            <th style={R}>Water</th><th style={R}>w/c</th><th style={R}>Total agg</th><th style={R}>Admix %</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ ...TD, fontWeight: 700 }}>{r.grade}</td>
                <td style={R}>{fmtKgm3(r.cement_kgm3)}</td>
                <td style={R}>{fmtKgm3(r.fly_ash_kgm3)}</td>
                <td style={R}>{fmtKgm3(r.total_binder_kgm3)}</td>
                <td style={R}>{fmtKgm3(r.free_water_kgm3)}</td>
                <td style={R}>{r.wb_ratio != null ? Number(r.wb_ratio).toFixed(2) : "—"}</td>
                <td style={R}>{fmtKgm3(r.total_aggregate_kgm3)}</td>
                <td style={R}>{r.admix_pct != null ? `${r.admix_pct.toFixed(1)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function MixDesignCosting({ id }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [days, setDays] = useState(30);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const qs = days === "custom" && from && to ? `from_date=${from}&to_date=${to}` : `days=${days === "custom" ? 30 : days}`;
  useEffect(() => {
    setData(null); setError("");
    apiRequest(`/plant/mix-designs/${id}/costing?${qs}`).then(setData).catch((e) => setError(e.message));
  }, [id, qs]);
  const R = { ...TD, textAlign: "right" };
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <p style={{ margin: 0, fontSize: 12, color: "var(--slate)", maxWidth: 560, lineHeight: 1.55 }}>
          <b>Design</b> cost (design kg/m³ × landed rate) vs <b>actual</b> cost (what the plant weighed per m³ for
          this grade in the period × the same rate). The gap is the over/under-batching cost.
        </p>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select aria-label="Period" value={days} onChange={(e) => setDays(e.target.value === "custom" ? "custom" : Number(e.target.value))} style={{ fontSize: 13 }}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
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
      </div>
      {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {!data && !error && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}
      {data && (
        <>
          {!data.has_actual && (
            <div className="card" style={{ marginBottom: 12, fontSize: 12.5, color: "var(--amber)" }}>
              No plant batches resolved to this grade in the selected period, so the actual columns are blank. The
              design costing still shows. (Check the recipe→grade mapping if you expected batches here.)
            </div>
          )}
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ background: "var(--concrete)" }}>
                <th style={TH}>Ingredient</th><th style={R}>Rate ₹/kg</th>
                <th style={R}>Design kg/m³</th><th style={R}>Design ₹/m³</th>
                <th style={R}>Actual kg/m³</th><th style={R}>Actual ₹/m³</th>
              </tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.key} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={TD}>{r.label}</td>
                    <td style={R}>{fmtRate(r.rate_per_kg)}</td>
                    <td style={R}>{fmtKgm3(r.design_kg_m3)}</td>
                    <td style={R}>{fmtINR(r.design_cost_m3)}</td>
                    <td style={R}>{fmtKgm3(r.actual_kg_m3)}</td>
                    <td style={R}>{fmtINR(r.actual_cost_m3)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "2px solid var(--border)", background: "var(--concrete)" }}>
                  <th style={{ ...TH }}>Material cost / m³</th><th style={R} /><th style={R} />
                  <th style={{ ...R, fontWeight: 800 }}>{fmtINR(data.design_total_cost_m3)}</th>
                  <th style={R} />
                  <th style={{ ...R, fontWeight: 800 }}>{data.actual_total_cost_m3 == null ? "—" : fmtINR(data.actual_total_cost_m3)}</th>
                </tr>
              </tfoot>
            </table>
          </div>
          {data.has_actual && data.actual_total_cost_m3 != null && (
            <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 8 }}>
              Over/under-batching vs design:{" "}
              <b style={{ color: data.actual_total_cost_m3 > data.design_total_cost_m3 ? "var(--alert-red)" : "var(--signal-green)" }}>
                {data.actual_total_cost_m3 > data.design_total_cost_m3 ? "+" : ""}
                {fmtINR(data.actual_total_cost_m3 - data.design_total_cost_m3)}/m³
              </b>{" "}· based on {data.produced_m3} m³ of this grade in the period.
            </div>
          )}
        </>
      )}
    </>
  );
}

function MixDesigns({ canCost }) {
  const [list, setList] = useState(null);
  const [sel, setSel] = useState("");
  const [sub, setSub] = useState("details");
  const [error, setError] = useState("");
  useEffect(() => {
    apiRequest("/plant/mix-designs").then((r) => {
      setList(r);
      if (r.length) setSel(String((r.find((d) => d.is_standard_for_grade) || r[0]).id));
    }).catch((e) => setError(e.message));
  }, []);
  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!list) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;
  if (!list.length) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>No approved mix designs yet. Create and approve one on the Lab side.</div>;
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" className={`btn-tab ${sub === "details" ? "active" : ""}`} onClick={() => setSub("details")}>Details</button>
          <button type="button" className={`btn-tab ${sub === "comparison" ? "active" : ""}`} onClick={() => setSub("comparison")}>Comparison</button>
          {canCost && <button type="button" className={`btn-tab ${sub === "costing" ? "active" : ""}`} onClick={() => setSub("costing")}>Costing</button>}
        </div>
        {sub !== "comparison" && (
          <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ marginLeft: "auto", fontSize: 13, maxWidth: 360 }}>
            {list.map((d) => (
              <option key={d.id} value={d.id}>{d.grade} — {d.design_ref_code} rev {d.revision}{d.is_standard_for_grade ? " · standard" : ""}</option>
            ))}
          </select>
        )}
      </div>
      {sub === "details" && <MixDesignDetails id={sel} />}
      {sub === "comparison" && <MixDesignComparison />}
      {sub === "costing" && canCost && <MixDesignCosting id={sel} />}
    </>
  );
}

export default function PlantProduction() {
  const { can, ready } = usePermissions();
  const [tab, setTab] = useState("production");
  const [days, setDays] = useState(30);          // a number, or "custom"
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [summary, setSummary] = useState(null);

  const canView = ready && can("production.plant-data", "view");
  const canCost = ready && can("material.stock-valuation", "view");
  const canMap = ready && can("production.plant-mapping", "view");
  const canManualView = ready && can("production.plant-manual", "view");
  const canManualEdit = ready && can("production.plant-manual", "create");
  // Round 160 — Administrator changes it, Manager may look. Deliberately not
  // the Plant Operator's: this moves a time printed on a customer's document.
  const canQcDelayView = ready && can("production.mixtrack-qc-delay", "view");
  const canQcDelayEdit = ready && can("production.mixtrack-qc-delay", "create");

  useEffect(() => {
    if (!canView) return;
    let alive = true;
    const pull = () => apiRequest("/plant/summary").then((s) => { if (alive) setSummary(s); }).catch(() => {});
    pull();
    const id = setInterval(pull, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [canView]);

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
  const periodTab = tab === "production" || tab === "consumption" || tab === "cost";
  // A valid custom range wins; otherwise fall back to the days preset (and to
  // 30 while a custom range is half-filled).
  const qs = (days === "custom" && from && to)
    ? `from_date=${from}&to_date=${to}`
    : `days=${days === "custom" ? 30 : days}`;

  return (
    <>
      <TopBar title="Plant Production" />
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 32px" }}>

        <div className="card" style={{ marginBottom: 16, display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div className="kpi-label">Made today</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{summary ? fmtM3(summary.today_m3) : "—"}</div>
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
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div className="kpi-label">Plant agent</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: heartbeat.stale ? "var(--alert-red)" : "var(--signal-green)" }}>
              {heartbeat.stale ? "Last seen " : "Live · "}{heartbeat.text}
            </div>
            {summary?.last_sync_error && (
              <div style={{ fontSize: 11, color: "var(--alert-red)", maxWidth: 320 }}>{summary.last_sync_error}</div>
            )}
          </div>
        </div>

        {heartbeat.stale && summary && (
          <div className="card" style={{ marginBottom: 16, background: "var(--alert-red-bg)", borderColor: "var(--alert-red)", fontSize: 13 }}>
            The plant PC has not sent anything recently. Nothing is lost — every batch is still in
            MCI370 and arrives once the agent is back — but nothing here is current until then.
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" className={`btn-tab ${tab === "production" ? "active" : ""}`} onClick={() => setTab("production")}>Production</button>
          <button type="button" className={`btn-tab ${tab === "consumption" ? "active" : ""}`} onClick={() => setTab("consumption")}>Consumption</button>
          {canView && (
            <button type="button" className={`btn-tab ${tab === "mix-designs" ? "active" : ""}`} onClick={() => setTab("mix-designs")}>Mix Designs</button>
          )}
          {canMap && (
            <button type="button" className={`btn-tab ${tab === "silos" ? "active" : ""}`} onClick={() => setTab("silos")}>Silos</button>
          )}
          {/* Round 159 — what the plant did not record. Shown to anyone who can
              read the plant data; only the Plant Operator can type into it. */}
          <button type="button" className={`btn-tab ${tab === "manual" ? "active" : ""}`} onClick={() => setTab("manual")}>Manual entry</button>
          {canCost && (
            <button type="button" className={`btn-tab ${tab === "cost" ? "active" : ""}`} onClick={() => setTab("cost")}>Cost/m³ – Material</button>
          )}
          {canQcDelayView && (
            <button type="button" className={`btn-tab ${tab === "qc-delay" ? "active" : ""}`} onClick={() => setTab("qc-delay")}>QC delay</button>
          )}
          {periodTab && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
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
          )}
        </div>

        {days === "custom" && periodTab && !(from && to) && (
          <div className="card" style={{ marginBottom: 16, fontSize: 12.5, color: "var(--slate)" }}>
            Pick both a From and a To date; showing the last 30 days until then.
          </div>
        )}

        {tab === "silos" && canMap ? <Silos />
          : tab === "mix-designs" && canView ? <MixDesigns canCost={canCost} />
          : tab === "qc-delay" && canQcDelayView ? <QcDelays canEdit={canQcDelayEdit} />
          : tab === "manual" ? <Manual canEdit={canManualEdit} />
          : tab === "cost" && canCost ? <CostPerM3 qs={qs} />
          : tab === "consumption" ? <Consumption qs={qs} />
          : <Production qs={qs} />}
      </div>
    </>
  );
}
