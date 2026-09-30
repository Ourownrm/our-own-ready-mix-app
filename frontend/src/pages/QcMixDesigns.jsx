import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { usePermissions } from "../lib/PermissionContext.jsx";

// ---------------------------------------------------------------------------
// Round 170 — Mix Designs, moved out of Plant Production into Quality Control.
//
// The mix design is quality data, not plant-operations data, so the page lives
// with QC. It keeps the two views QC actually uses — Details and Costing — and
// drops the Comparison tab (the owner's call). The data still comes from the
// same /plant/mix-designs endpoints; only the page's home has changed.
// ---------------------------------------------------------------------------
const TH = { padding: "9px 12px", textAlign: "left" };
const TD = { padding: "9px 12px" };
function fmtINR(n) {
  if (n == null) return "—";
  return "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}
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
          {canCost && <button type="button" className={`btn-tab ${sub === "costing" ? "active" : ""}`} onClick={() => setSub("costing")}>Costing</button>}
        </div>
        <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ marginLeft: "auto", fontSize: 13, maxWidth: 360 }}>
          {list.map((d) => (
            <option key={d.id} value={d.id}>{d.grade} — {d.design_ref_code} rev {d.revision}{d.is_standard_for_grade ? " · standard" : ""}</option>
          ))}
        </select>
      </div>
      {sub === "details" && <MixDesignDetails id={sel} />}
      {sub === "costing" && canCost && <MixDesignCosting id={sel} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Round 171 — Recipe Master. A read of the plant's own recipes (MCI370's
// Recipe_Master), synced in by the agent. Shows each recipe's per-slot targets
// under the plant's own slot names, and — for those who may see money — the
// cost per m³ (target × the material's landed rate). Editing is a later round.
// ---------------------------------------------------------------------------
function RecipeDetail({ id, canCost }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!id) return;
    setD(null); setErr("");
    apiRequest(`/plant/recipes/${id}`).then(setD).catch((e) => setErr(e.message));
  }, [id]);
  if (err) return <div className="card" style={{ flex: 1, color: "var(--alert-red)", fontSize: 13 }}>{err}</div>;
  if (!d) return <div className="card" style={{ flex: 1, fontSize: 13, color: "var(--slate)" }}>Loading…</div>;
  const r = d.recipe;
  const R = { ...TD, textAlign: "right" };
  const param = (label, value) => (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td style={{ ...TD, color: "var(--slate)" }}>{label}</td>
      <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{value}</td>
    </tr>
  );
  return (
    <div style={{ flex: "1 1 460px", minWidth: 320 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{r.recipe_code}</h3>
        <span style={{ fontSize: 12.5, color: "var(--slate)" }}>{r.recipe_name}</span>
        {canCost && (
          <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 700 }}>
            {fmtINR(d.cost_per_m3)}<span style={{ fontSize: 11, color: "var(--slate)", fontWeight: 400 }}>/m³ material</span>
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <div className="card" style={{ flex: "1 1 220px", padding: 0, overflowX: "auto", minWidth: 200 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: "var(--concrete)" }}><th style={TH} colSpan={2}>Recipe settings</th></tr></thead>
            <tbody>
              {param("Mixing time", r.mixing_time != null ? `${r.mixing_time} s` : "—")}
              {param("Mixer capacity", r.mixer_capacity != null ? `${r.mixer_capacity} m³` : "—")}
              {param("Total binder", `${r.binder_kg} kg`)}
              {param("Water", `${r.water_kg} kg`)}
              {param("w/c ratio", r.wc_ratio != null ? r.wc_ratio.toFixed(3) : "—")}
              {param("Mass / batch", r.mass_weight != null ? `${r.mass_weight} kg` : "—")}
              {r.plant_modifier_name && param("Last changed (plant)", `${r.plant_modifier_name}${r.plant_modified_at ? " · " + r.plant_modified_at : ""}`)}
            </tbody>
          </table>
        </div>
        <div className="card" style={{ flex: "1 1 300px", padding: 0, overflowX: "auto", minWidth: 260 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Slot</th><th style={{ ...TH, textAlign: "right" }}>Target</th>
              <th style={TH}>Material</th>
              {canCost && <><th style={R}>Rate</th><th style={R}>₹/m³</th></>}
            </tr></thead>
            <tbody>
              {d.targets.map((t) => (
                <tr key={t.slot} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={TD}>{t.plant_name || t.slot_label}<div style={{ fontSize: 10.5, color: "var(--slate)" }}>{t.slot_label}</div></td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{fmtKgm3(t.target)}</td>
                  <td style={{ ...TD, color: t.material_name ? "inherit" : "var(--amber)" }}>{t.material_name || "not mapped"}</td>
                  {canCost && <><td style={R}>{fmtRate(t.rate_per_kg)}</td><td style={R}>{fmtINR(t.cost_per_m3)}</td></>}
                </tr>
              ))}
            </tbody>
            {canCost && (
              <tfoot><tr style={{ borderTop: "2px solid var(--border)", background: "var(--concrete)" }}>
                <th style={TH} colSpan={4}>Material cost / m³</th>
                <th style={{ ...R, fontWeight: 800 }}>{fmtINR(d.cost_per_m3)}</th>
              </tr></tfoot>
            )}
          </table>
        </div>
      </div>
      {canCost && d.cost_incomplete && (
        <div style={{ fontSize: 11.5, color: "var(--amber)", marginTop: 8 }}>
          Some slots have no priced material yet (shown as "not mapped" or a blank rate), so the cost is a partial
          figure. Map the silo to a material, and receive a priced load, to complete it.
        </div>
      )}
    </div>
  );
}

function RecipeMaster({ canCost }) {
  const [list, setList] = useState(null);
  const [selId, setSelId] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    apiRequest("/plant/recipes").then((r) => {
      setList(r);
      if (r.length) setSelId(r[0].id);
    }).catch((e) => setError(e.message));
  }, []);
  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!list) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;
  if (!list.length) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>No recipes synced yet — the plant agent copies them in from MCI370's Recipe Master.</div>;
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div className="card" style={{ flex: "0 1 280px", padding: 0, overflowX: "auto", minWidth: 240 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: "var(--concrete)" }}>
            <th style={TH}>Recipe</th>{canCost && <th style={{ ...TH, textAlign: "right" }}>₹/m³</th>}
          </tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} onClick={() => setSelId(r.id)}
                  style={{ borderTop: "1px solid var(--border)", cursor: "pointer", background: r.id === selId ? "var(--concrete)" : "transparent" }}>
                <td style={TD}><span style={{ fontWeight: r.id === selId ? 700 : 500 }}>{r.recipe_code}</span>
                  <div style={{ fontSize: 10.5, color: "var(--slate)" }}>w/c {r.wc_ratio != null ? r.wc_ratio.toFixed(2) : "—"} · binder {r.binder_kg}</div></td>
                {canCost && <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{fmtINR(r.cost_per_m3)}{r.cost_incomplete ? "*" : ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RecipeDetail id={selId} canCost={canCost} />
    </div>
  );
}

export default function QcMixDesigns() {
  const { can, ready } = usePermissions();
  const [tab, setTab] = useState("designs");
  const canView = ready && can("production.plant-data", "view");
  const canCost = ready && can("material.stock-valuation", "view");
  if (!ready) return null;
  return (
    <>
      <TopBar title="Mix Designs & Recipes" />
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 32px" }}>
        {!canView ? (
          <div className="card" style={{ fontSize: 13 }}>
            You do not have access to this data. A Super Admin can grant it on the Access Control page.
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              <button type="button" className={`btn-tab ${tab === "designs" ? "active" : ""}`} onClick={() => setTab("designs")}>Mix Designs</button>
              <button type="button" className={`btn-tab ${tab === "recipes" ? "active" : ""}`} onClick={() => setTab("recipes")}>Recipe Master</button>
            </div>
            {tab === "designs" ? <MixDesigns canCost={canCost} /> : <RecipeMaster canCost={canCost} />}
          </>
        )}
      </div>
    </>
  );
}
