import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { useAuth } from "../lib/AuthContext.jsx";

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

// Round 178 — Recipe <-> Mix Design mapping, shown on both the recipe side and
// the mix-design side. Chips for what is linked (with a remove ✕ when the user
// may edit), and an add dropdown of everything not yet linked. The parent owns
// the data and the add/remove calls; this is just the control.
function MappingEditor({ label, hint, emptyText, items, options, canEdit, busy, onAdd, onRemove }) {
  const [pick, setPick] = useState("");
  const linkedIds = new Set(items.map((i) => String(i.id)));
  const available = options.filter((o) => !linkedIds.has(String(o.id)));
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8 }}>{hint}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: canEdit ? 10 : 0 }}>
        {items.length === 0 && <span style={{ fontSize: 12, color: "var(--slate)" }}>{emptyText}</span>}
        {items.map((i) => (
          <span key={i.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--concrete)", borderRadius: 14, padding: "3px 10px", fontSize: 12 }}>
            {i.label}
            {canEdit && (
              <button type="button" title="Remove" disabled={busy} onClick={() => onRemove(i.id)}
                      style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--slate)", fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
            )}
          </span>
        ))}
      </div>
      {canEdit && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ fontSize: 12.5, minWidth: 220, maxWidth: "100%" }} disabled={busy || available.length === 0}>
            <option value="">{available.length ? "Add…" : "Nothing left to add"}</option>
            {available.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <button type="button" className="btn-primary" style={{ fontSize: 12.5 }} disabled={busy || !pick}
                  onClick={() => { const v = pick; setPick(""); onAdd(v); }}>Add</button>
        </div>
      )}
    </div>
  );
}

function MixDesignDetails({ id, canEdit }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  // Round 178 — recipe↔mix-design mapping from the design side.
  const [allRecipes, setAllRecipes] = useState([]);
  const [mapBusy, setMapBusy] = useState(false);
  function load() {
    setData(null); setError("");
    apiRequest(`/plant/mix-designs/${id}`).then(setData).catch((e) => setError(e.message));
  }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { apiRequest("/plant/recipes").then(setAllRecipes).catch(() => {}); }, []);
  async function addRecipe(recipeId) {
    setMapBusy(true);
    try { await apiRequest("/plant/recipe-design-map", { method: "POST", body: { recipe_id: Number(recipeId), mix_design_id: id } }); load(); }
    catch (e) { setError(e.message); } finally { setMapBusy(false); }
  }
  async function removeRecipe(recipeId) {
    setMapBusy(true);
    try { await apiRequest(`/plant/recipe-design-map?recipe_id=${recipeId}&mix_design_id=${id}`, { method: "DELETE" }); load(); }
    catch (e) { setError(e.message); } finally { setMapBusy(false); }
  }
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
    <>
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      <div className="card" style={{ flex: 1, minWidth: 290, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: "var(--concrete)" }}><th style={TH} colSpan={2}>Design parameters</th></tr></thead>
          <tbody>
            {param("Grade", d.grade)}
            {param("Design ref / rev", `${d.design_ref_code} · rev ${d.revision}`)}
            {d.mix_description && param("Description", d.mix_description)}
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
    <MappingEditor
      label="Mapped recipes"
      hint="A mix design can belong to several plant recipes; a recipe can carry several designs."
      emptyText="No recipe mapped to this mix design yet."
      items={(data.mapped_recipes || []).map((x) => ({ id: x.recipe_id, label: x.recipe_name ? `${x.recipe_code} — ${x.recipe_name}` : x.recipe_code }))}
      options={allRecipes.map((x) => ({ id: x.id, label: x.recipe_name ? `${x.recipe_code} — ${x.recipe_name}` : x.recipe_code }))}
      canEdit={canEdit}
      busy={mapBusy}
      onAdd={addRecipe}
      onRemove={removeRecipe}
    />
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

function MixDesigns({ canCost, canEdit }) {
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
            <option key={d.id} value={d.id}>{d.grade} — {d.design_ref_code} rev {d.revision}{d.mix_description ? ` · ${d.mix_description}` : ""}{d.is_standard_for_grade ? " · standard" : ""}</option>
          ))}
        </select>
      </div>
      {sub === "details" && <MixDesignDetails id={sel} canEdit={canEdit} />}
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
const EDIT_INPUT = { fontSize: 13, padding: "4px 7px", border: "1px solid var(--rebar)", borderRadius: 6, background: "#FFF9F3", width: 110, textAlign: "right" };
const STATUS_COLOUR = { pending: "var(--amber)", claimed: "var(--amber)", applied: "var(--signal-green)", failed: "var(--alert-red)" };
const STATUS_LABEL = { pending: "queued for plant", claimed: "writing to plant", applied: "in sync with plant", failed: "write failed" };

function RecipeDetail({ id, canCost, canEdit, editPwSet, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(false);
  const [pw, setPw] = useState("");
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [eerr, setEerr] = useState("");
  function load() {
    if (!id) return;
    setD(null); setErr("");
    apiRequest(`/plant/recipes/${id}`).then(setD).catch((e) => setErr(e.message));
  }
  useEffect(() => { load(); setEditing(false); setMsg(""); setEerr(""); }, [id]);
  // Round 178 — recipe↔mix-design mapping. All designs for the add dropdown; the
  // linked set comes from the recipe detail (d.mapped_designs).
  const [allDesigns, setAllDesigns] = useState([]);
  const [mapBusy, setMapBusy] = useState(false);
  useEffect(() => { apiRequest("/plant/mix-designs").then(setAllDesigns).catch(() => {}); }, []);
  async function addDesign(designId) {
    setMapBusy(true); setEerr("");
    try { await apiRequest("/plant/recipe-design-map", { method: "POST", body: { recipe_id: id, mix_design_id: Number(designId) } }); load(); }
    catch (e) { setEerr(e.message); } finally { setMapBusy(false); }
  }
  async function removeDesign(designId) {
    setMapBusy(true); setEerr("");
    try { await apiRequest(`/plant/recipe-design-map?recipe_id=${id}&mix_design_id=${designId}`, { method: "DELETE" }); load(); }
    catch (e) { setEerr(e.message); } finally { setMapBusy(false); }
  }
  function startEdit() {
    const r = d.recipe;
    const targets = {};
    (d.editable_slots || []).forEach((s) => { targets[s.slot] = String(s.target || 0); });
    setForm({
      recipe_code: r.recipe_code || "",
      recipe_name: r.recipe_name || "",
      consistancy: r.consistancy || "",
      mixing_time: r.mixing_time ?? "",
      mixer_capacity: r.mixer_capacity ?? "",
      mass_weight: r.mass_weight ?? "",
      targets,
    });
    setEditing(true); setMsg(""); setEerr("");
  }
  async function save() {
    setBusy(true); setEerr(""); setMsg("");
    try {
      const targets = {};
      Object.entries(form.targets).forEach(([s, v]) => { targets[s] = v === "" ? 0 : Number(v); });
      const body = {
        edit_password: pw,
        new_recipe_code: form.recipe_code,
        fields: {
          recipe_name: form.recipe_name,
          consistancy: form.consistancy,
          mixing_time: form.mixing_time === "" ? null : Number(form.mixing_time),
          mixer_capacity: form.mixer_capacity === "" ? null : Number(form.mixer_capacity),
          mass_weight: form.mass_weight === "" ? null : Number(form.mass_weight),
        },
        targets,
      };
      const res = await apiRequest(`/plant/recipes/${id}`, { method: "PATCH", body });
      setMsg(res.message || "Saved."); setEditing(false); load(); onChanged && onChanged();
    } catch (e) { setEerr(e.message); } finally { setBusy(false); }
  }
  async function revert(editId) {
    if (!pw) { setEerr("Enter the edit password above, then Revert."); return; }
    setBusy(true); setEerr(""); setMsg("");
    try {
      const res = await apiRequest(`/plant/recipes/edits/${editId}/revert`, { method: "POST", body: { edit_password: pw } });
      setMsg(res.message || "Reverted."); load(); onChanged && onChanged();
    } catch (e) { setEerr(e.message); } finally { setBusy(false); }
  }
  // Round 182 — cancel a queued edit before the agent writes it to the plant.
  async function discard(editId) {
    if (!pw) { setEerr("Enter the edit password above, then Discard."); return; }
    setBusy(true); setEerr(""); setMsg("");
    try {
      const res = await apiRequest(`/plant/recipes/edits/${editId}/discard`, { method: "POST", body: { edit_password: pw } });
      setMsg(res.message || "Discarded."); load(); onChanged && onChanged();
    } catch (e) { setEerr(e.message); } finally { setBusy(false); }
  }
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

      {d.pending_write && (
        <div className="card" style={{ marginBottom: 10, fontSize: 12.5, color: "var(--amber)", borderColor: "#E3D2AE" }}>
          A change to this recipe is queued for the plant — it will show as <b>in sync</b> once the agent writes it to
          MCI370.
        </div>
      )}

      {canEdit && (
        <div className="card" style={{ marginBottom: 12 }}>
          {!editPwSet ? (
            <div style={{ fontSize: 12.5, color: "var(--slate)" }}>
              Editing is locked until a <b>Super Admin sets the recipe edit password</b> (top of this tab).
            </div>
          ) : !editing ? (
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, color: "var(--slate)" }}>Edit password{" "}
                <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="to unlock editing"
                       style={{ fontSize: 13, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 6, marginLeft: 4 }} />
              </label>
              <button type="button" className="btn-primary" style={{ fontSize: 12.5 }} disabled={!pw} onClick={startEdit}>Edit recipe</button>
              <span style={{ fontSize: 11, color: "var(--slate)" }}>Changes write back into MCI370.</span>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Editing {r.recipe_code}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginBottom: 10 }}>
                <label style={{ fontSize: 11, color: "var(--slate)" }}>Recipe code
                  <input value={form.recipe_code} onChange={(e) => setForm({ ...form, recipe_code: e.target.value })} style={{ ...EDIT_INPUT, width: "100%", textAlign: "left" }} /></label>
                <label style={{ fontSize: 11, color: "var(--slate)" }}>Recipe name
                  <input value={form.recipe_name} onChange={(e) => setForm({ ...form, recipe_name: e.target.value })} style={{ ...EDIT_INPUT, width: "100%", textAlign: "left" }} /></label>
                <label style={{ fontSize: 11, color: "var(--slate)" }}>Slump / consistency
                  <input value={form.consistancy} onChange={(e) => setForm({ ...form, consistancy: e.target.value })} style={{ ...EDIT_INPUT, width: "100%", textAlign: "left" }} /></label>
                <label style={{ fontSize: 11, color: "var(--slate)" }}>Mixing time (s)
                  <input type="number" value={form.mixing_time} onChange={(e) => setForm({ ...form, mixing_time: e.target.value })} style={{ ...EDIT_INPUT, width: "100%" }} /></label>
                <label style={{ fontSize: 11, color: "var(--slate)" }}>Mixer capacity (m³)
                  <input type="number" value={form.mixer_capacity} onChange={(e) => setForm({ ...form, mixer_capacity: e.target.value })} style={{ ...EDIT_INPUT, width: "100%" }} /></label>
                <label style={{ fontSize: 11, color: "var(--slate)" }}>Mass / batch (kg)
                  <input type="number" value={form.mass_weight} onChange={(e) => setForm({ ...form, mass_weight: e.target.value })} style={{ ...EDIT_INPUT, width: "100%" }} /></label>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 6 }}>
                Target weight per slot — set a slot to <b>0</b> to take it out of the mix, or give a weight to bring one
                in (e.g. CEM1 → 0, CEM2 → 250).
              </div>
              <div className="card" style={{ padding: 0, overflowX: "auto", marginBottom: 10 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead><tr style={{ background: "var(--concrete)" }}><th style={TH}>Slot</th><th style={TH}>Plant name</th><th style={{ ...TH, textAlign: "right" }}>Target</th></tr></thead>
                  <tbody>
                    {(d.editable_slots || []).map((s) => (
                      <tr key={s.slot} style={{ borderTop: "1px solid var(--border)" }}>
                        <td style={TD}>{s.slot_label}</td>
                        <td style={{ ...TD, color: "var(--slate)" }}>{s.plant_name || "—"}{s.material_name ? ` · ${s.material_name}` : ""}</td>
                        <td style={{ ...TD, textAlign: "right" }}>
                          <input type="number" step="0.1" min="0" value={form.targets[s.slot] ?? "0"}
                                 onChange={(e) => setForm({ ...form, targets: { ...form.targets, [s.slot]: e.target.value } })} style={EDIT_INPUT} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn-primary" style={{ fontSize: 12.5 }} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save & write to plant"}</button>
                <button type="button" style={{ fontSize: 12.5 }} disabled={busy} onClick={() => { setEditing(false); setEerr(""); }}>Cancel</button>
              </div>
            </div>
          )}
          {msg && <div style={{ fontSize: 12, color: "var(--signal-green)", marginTop: 8 }}>{msg}</div>}
          {eerr && <div style={{ fontSize: 12, color: "var(--alert-red)", marginTop: 8 }}>{eerr}</div>}
        </div>
      )}

      {!editing && (<div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
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
      </div>)}
      {!editing && canCost && d.cost_incomplete && (
        <div style={{ fontSize: 11.5, color: "var(--amber)", marginTop: 8 }}>
          Some slots have no priced material yet (shown as "not mapped" or a blank rate), so the cost is a partial
          figure. Map the silo to a material, and receive a priced load, to complete it.
        </div>
      )}

      <MappingEditor
        label="Mapped mix designs"
        hint="A recipe can be tied to several mix designs; a mix design can belong to several recipes."
        emptyText="No mix design mapped to this recipe yet."
        items={(d.mapped_designs || []).map((x) => ({ id: x.mix_design_id, label: `${x.grade} — ${x.design_ref_code}${x.mix_description ? ` · ${x.mix_description}` : ""}` }))}
        options={allDesigns.map((x) => ({ id: x.id, label: `${x.grade} — ${x.design_ref_code}${x.mix_description ? ` · ${x.mix_description}` : ""}` }))}
        canEdit={canEdit}
        busy={mapBusy}
        onAdd={addDesign}
        onRemove={removeDesign}
      />

      {canEdit && d.recent_edits && d.recent_edits.length > 0 && (
        <div className="card" style={{ marginTop: 12, padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Recent changes</th><th style={TH}>By</th><th style={TH}>Status</th><th style={TH} />
            </tr></thead>
            <tbody>
              {d.recent_edits.map((e) => (
                <tr key={e.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={TD}>
                    {new Date(e.edited_at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                    {e.is_code_rename && <div style={{ fontSize: 10.5, color: "var(--slate)" }}>renamed {e.old_recipe_code} → {e.new_recipe_code}</div>}
                    {e.status === "failed" && e.agent_error && <div style={{ fontSize: 10.5, color: "var(--alert-red)" }}>{e.agent_error}</div>}
                  </td>
                  <td style={{ ...TD, color: "var(--slate)" }}>{e.edited_by_name || "—"}</td>
                  <td style={{ ...TD, color: STATUS_COLOUR[e.status] || "var(--slate)", fontWeight: 600 }}>{STATUS_LABEL[e.status] || e.status}</td>
                  <td style={{ ...TD, textAlign: "right" }}>
                    {e.status === "applied" &&
                      <button type="button" style={{ fontSize: 11.5 }} disabled={busy} onClick={() => revert(e.id)}>Undo</button>}
                    {(e.status === "pending" || e.status === "claimed" || e.status === "failed") &&
                      <button type="button" style={{ fontSize: 11.5 }} disabled={busy} onClick={() => discard(e.id)} title="Remove this change — it has not been written to the plant">Discard</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RecipeMaster({ canCost, canEdit, isSuperAdmin }) {
  const [list, setList] = useState(null);
  const [selId, setSelId] = useState(null);
  const [error, setError] = useState("");
  const [pwSet, setPwSet] = useState(null);     // edit-password set?
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  function reload() {
    apiRequest("/plant/recipes").then((r) => {
      setList(r);
      setSelId((cur) => cur || (r.length ? r[0].id : null));
    }).catch((e) => setError(e.message));
  }
  useEffect(() => { reload(); }, []);
  useEffect(() => { apiRequest("/plant/recipes/edit-password/status").then((s) => setPwSet(s.is_set)).catch(() => setPwSet(false)); }, []);
  async function saveEditPassword() {
    setPwMsg("");
    try {
      await apiRequest("/plant/recipes/edit-password", { method: "PUT", body: { password: newPw } });
      setPwSet(true); setNewPw(""); setPwMsg("Edit password saved.");
    } catch (e) { setPwMsg(e.message); }
  }
  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!list) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;
  return (
    <>
      {isSuperAdmin && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Recipe edit password {pwSet ? "— set" : "— not set yet"}</div>
          <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 8 }}>
            The plant-wide key QC enters to edit a recipe. Setting a new value replaces the old one.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder={pwSet ? "new edit password" : "set an edit password"}
                   style={{ fontSize: 13, padding: "5px 9px", border: "1px solid var(--border)", borderRadius: 6 }} />
            <button type="button" className="btn-primary" style={{ fontSize: 12.5 }} disabled={newPw.length < 4} onClick={saveEditPassword}>{pwSet ? "Reset password" : "Set password"}</button>
            {pwMsg && <span style={{ fontSize: 12, color: "var(--signal-green)" }}>{pwMsg}</span>}
          </div>
        </div>
      )}
      {!list.length ? (
        <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>No recipes synced yet — the plant agent copies them in from MCI370's Recipe Master.</div>
      ) : (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div className="card" style={{ flex: "0 1 280px", padding: 0, overflowX: "auto", minWidth: 240 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: "var(--concrete)" }}>
            <th style={TH}>Recipe / name</th>{canCost && <th style={{ ...TH, textAlign: "right" }}>₹/m³</th>}
          </tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} onClick={() => setSelId(r.id)}
                  style={{ borderTop: "1px solid var(--border)", cursor: "pointer", background: r.id === selId ? "var(--concrete)" : "transparent" }}>
                <td style={TD}><span style={{ fontWeight: r.id === selId ? 700 : 500 }}>{r.recipe_code}</span>
                  <div style={{ fontSize: 11.5, color: r.recipe_name ? "var(--charcoal)" : "var(--amber)" }}>{r.recipe_name || "— no name —"}</div>
                  <div style={{ fontSize: 10.5, color: "var(--slate)" }}>w/c {r.wc_ratio != null ? r.wc_ratio.toFixed(2) : "—"} · binder {r.binder_kg}</div></td>
                {canCost && <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{fmtINR(r.cost_per_m3)}{r.cost_incomplete ? "*" : ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RecipeDetail id={selId} canCost={canCost} canEdit={canEdit} editPwSet={pwSet} onChanged={reload} />
    </div>
      )}
    </>
  );
}

export default function QcMixDesigns() {
  const { can, ready } = usePermissions();
  const { user } = useAuth();
  const [tab, setTab] = useState("designs");
  // Round 192 — a Quality Control sub-menu with its own function, so denying
  // Plant Production to a role no longer closes this screen too.
  const canView = ready && can("quality.mix-designs-view", "view");
  const canCost = ready && can("material.stock-valuation", "view");
  const canEdit = ready && can("production.recipe-edit", "edit");
  const isSuperAdmin = user?.role === "super_admin";
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
            {tab === "designs" ? <MixDesigns canCost={canCost} canEdit={canEdit} /> : <RecipeMaster canCost={canCost} canEdit={canEdit} isSuperAdmin={isSuperAdmin} />}
          </>
        )}
      </div>
    </>
  );
}
