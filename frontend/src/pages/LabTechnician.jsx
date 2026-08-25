// Lab Technician (round 118) — new role. Owns cube compressive-strength
// testing (downstream of QC Engineer's plant-side slump/temp/cube-casting,
// which is unchanged) and the mix design library both PDF reports are built
// from. Single-file, internal-view-state dashboard, matching the pattern
// used by every other role's own screen (QcEngineer.jsx, Accountant.jsx, etc).
import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { generateMixDesignPdf } from "../lib/mixDesignPdf.js";
import { generateCubeTestPdf } from "../lib/cubeTestPdf.js";

const CUBE_VOLUME_M3 = 0.003375; // 150mm cube
const CUBE_FACE_AREA_MM2 = 150 * 150;

function computeDensity(weightKg) {
  const w = Number(weightKg);
  if (!w) return "";
  return (w / CUBE_VOLUME_M3).toFixed(1);
}
function computeStrength(loadKn) {
  const l = Number(loadKn);
  if (!l) return "";
  return ((l * 1000) / CUBE_FACE_AREA_MM2).toFixed(1);
}
function fmtDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

const STATUS_LABEL = {
  done: "Done",
  overdue: "Overdue",
  due_today: "Due today",
  upcoming: "Not yet due",
};
const STATUS_COLOR = {
  done: "badge-success",
  overdue: "badge-danger",
  due_today: "badge-warning",
  upcoming: "badge-neutral",
};

export default function LabTechnician() {
  const [tab, setTab] = useState("batches"); // batches | mix-designs
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  return (
    <>
      <TopBar title="Lab Technician" />
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button className={`btn-tab ${tab === "batches" ? "active" : ""}`} onClick={() => setTab("batches")}>Cube Testing</button>
          <button className={`btn-tab ${tab === "mix-designs" ? "active" : ""}`} onClick={() => setTab("mix-designs")}>Mix Designs</button>
        </div>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 8 }}>{notice}</div>}

        {tab === "batches" && <CubeTestingTab setError={setError} setNotice={setNotice} />}
        {tab === "mix-designs" && <MixDesignsTab setError={setError} setNotice={setNotice} />}
      </div>
    </>
  );
}

// ===== Cube Testing =====

function CubeTestingTab({ setError, setNotice }) {
  const [batches, setBatches] = useState([]);
  const [openBatchId, setOpenBatchId] = useState(null);

  async function load() {
    try { setBatches(await apiRequest("/lab-technician/cube-batches")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      {batches.map((b) => (
        <div key={b.plant_qc_id} className="card" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontWeight: 600 }}>{b.ticket_number} · {b.mix_grade_name} · {b.number_of_cubes} cubes</div>
              <div style={{ fontSize: 12, color: "var(--slate)" }}>{b.customer_name} — {b.site_name}</div>
              <div style={{ fontSize: 11, color: "var(--slate)" }}>Cast {fmtDate(b.cast_at)} · Sample IDs: {b.sample_ids || "—"}</div>
            </div>
            <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setOpenBatchId(openBatchId === b.plant_qc_id ? null : b.plant_qc_id)}>
              {openBatchId === b.plant_qc_id ? "Close" : "Open"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <AgeBadge label="7-day" status={b.status_7day} due={b.due_7day} strength={b.result_7day_strength} />
            <AgeBadge label="28-day" status={b.status_28day} due={b.due_28day} strength={b.result_28day_strength} />
          </div>
          {openBatchId === b.plant_qc_id && (
            <BatchDetail
              plantQcId={b.plant_qc_id}
              setError={setError}
              setNotice={setNotice}
              onSaved={() => { load(); }}
            />
          )}
        </div>
      ))}
      {batches.length === 0 && <div style={{ fontSize: 13, color: "var(--slate)" }}>No cube batches yet — cubes are cast and identified by QC Engineer at plant QC entry.</div>}
    </div>
  );
}

function AgeBadge({ label, status, due, strength }) {
  return (
    <div style={{ fontSize: 11 }}>
      <span className={`badge ${STATUS_COLOR[status] || "badge-neutral"}`}>{label}: {STATUS_LABEL[status] || status}</span>
      {status === "done" && strength != null && <span style={{ color: "var(--slate)", marginLeft: 4 }}>{Number(strength).toFixed(1)} MPa</span>}
      {status !== "done" && due && <span style={{ color: "var(--slate)", marginLeft: 4 }}>{fmtDate(due)}</span>}
    </div>
  );
}

function BatchDetail({ plantQcId, setError, setNotice, onSaved }) {
  const [detail, setDetail] = useState(null);
  const [age, setAge] = useState(7);
  const [mixDesignId, setMixDesignId] = useState("");
  const [cubes, setCubes] = useState([]);
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiRequest(`/lab-technician/cube-batches/${plantQcId}`)
      .then((d) => {
        setDetail(d);
        setMixDesignId(d.resolved_mix_design_id || (d.approved_designs[0]?.id ?? ""));
        const labels = (d.sample_ids || "").split(",").map((s) => s.trim()).filter(Boolean);
        const count = d.number_of_cubes || labels.length || 3;
        setCubes(Array.from({ length: count }, (_, i) => ({
          cube_label: labels[i] || `Cube ${i + 1}`, weight_kg: "", testing_load_kn: "",
        })));
      })
      .catch((err) => setError(err.message));
  }, [plantQcId]);

  function updateCube(i, field, value) {
    setCubes((cs) => cs.map((c, idx) => idx === i ? { ...c, [field]: value } : c));
  }

  const avgStrength = (() => {
    const vals = cubes.map((c) => Number(computeStrength(c.testing_load_kn))).filter((v) => v > 0);
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
  })();

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      const payload = {
        testing_age_days: age,
        mix_design_id: mixDesignId || null,
        remarks,
        cubes: cubes.map((c) => ({
          cube_label: c.cube_label,
          weight_kg: c.weight_kg || null,
          testing_load_kn: c.testing_load_kn || null,
          density_kgm3: computeDensity(c.weight_kg) || null,
          strength_mpa: computeStrength(c.testing_load_kn) || null,
        })),
      };
      await apiRequest(`/lab-technician/cube-batches/${plantQcId}/results`, { method: "POST", body: payload });
      setNotice("Test result saved.");
      onSaved();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function viewPdf(resultId) {
    try {
      const data = await apiRequest(`/lab-technician/cube-tests/${resultId}/pdf-data`);
      await generateCubeTestPdf(data);
    } catch (err) { setError(err.message); }
  }

  if (!detail) return <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 8 }}>Loading…</div>;

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--concrete)", paddingTop: 12 }}>
      {detail.results.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {detail.results.map((r) => (
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, marginBottom: 4 }}>
              <span>{r.testing_age_days}-day — {Number(r.average_strength_mpa).toFixed(1)} MPa avg, tested by {r.tested_by_name}</span>
              <button type="button" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => viewPdf(r.id)}>View PDF</button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
        <div style={{ display: "flex", gap: 16 }}>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="radio" checked={age === 7} onChange={() => setAge(7)} /> 7-day
          </label>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="radio" checked={age === 28} onChange={() => setAge(28)} /> 28-day
          </label>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Compare against mix design</div>
          <select value={mixDesignId} onChange={(e) => setMixDesignId(e.target.value)}>
            <option value="">— none on file —</option>
            {detail.approved_designs.map((d) => <option key={d.id} value={d.id}>{d.design_ref_code}</option>)}
          </select>
        </div>
        {cubes.map((c, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, alignItems: "end" }}>
            <div>
              <div style={{ color: "var(--slate)", fontSize: 11 }}>{i === 0 ? "Cube" : ""}</div>
              <input value={c.cube_label} onChange={(e) => updateCube(i, "cube_label", e.target.value)} style={{ width: "100%" }} />
            </div>
            <div>
              <div style={{ color: "var(--slate)", fontSize: 11 }}>{i === 0 ? "Weight (kg)" : ""}</div>
              <input type="number" step="0.001" value={c.weight_kg} onChange={(e) => updateCube(i, "weight_kg", e.target.value)} style={{ width: "100%" }} />
            </div>
            <div>
              <div style={{ color: "var(--slate)", fontSize: 11 }}>{i === 0 ? "Load (kN)" : ""}</div>
              <input type="number" step="0.01" value={c.testing_load_kn} onChange={(e) => updateCube(i, "testing_load_kn", e.target.value)} style={{ width: "100%" }} />
            </div>
            <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--slate)" }}>
              {c.weight_kg && `Density: ${computeDensity(c.weight_kg)} kg/m³`} {c.testing_load_kn && `· Strength: ${computeStrength(c.testing_load_kn)} MPa`}
            </div>
          </div>
        ))}
        {avgStrength && (
          <div style={{ background: "var(--concrete)", borderRadius: 8, padding: "8px 10px", fontSize: 12.5 }}>
            Average strength: <b>{avgStrength} MPa</b>
          </div>
        )}
        <div>
          <div style={{ color: "var(--slate)" }}>Remarks</div>
          <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save test result"}</button>
      </form>
    </div>
  );
}

// ===== Mix Designs =====

function MixDesignsTab({ setError, setNotice }) {
  const [designs, setDesigns] = useState([]);
  const [creating, setCreating] = useState(false);
  const [me, setMe] = useState(null);

  async function load() {
    try {
      setDesigns(await apiRequest("/lab-technician/mix-designs"));
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    // Best-effort: used only to grey out "Approve" on a design this same
    // user created (the backend enforces this regardless).
    try { const t = localStorage.getItem("oorm_user"); if (t) setMe(JSON.parse(t)); } catch { /* ignore */ }
  }, []);

  async function approve(id) {
    setError(""); setNotice("");
    try {
      await apiRequest(`/lab-technician/mix-designs/${id}/approve`, { method: "POST" });
      setNotice("Approved.");
      load();
    } catch (err) { setError(err.message); }
  }

  async function viewPdf(id) {
    try {
      const data = await apiRequest(`/lab-technician/mix-designs/${id}/pdf-data`);
      await generateMixDesignPdf(data);
    } catch (err) { setError(err.message); }
  }

  if (creating) {
    return <MixDesignForm setError={setError} setNotice={setNotice} onDone={() => { setCreating(false); load(); }} onCancel={() => setCreating(false)} />;
  }

  return (
    <div>
      <button type="button" className="btn-primary" style={{ marginBottom: 12 }} onClick={() => setCreating(true)}>+ New mix design</button>
      {designs.map((d) => (
        <div key={d.id} className="card" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontWeight: 600 }}>{d.design_ref_code} · {d.mix_grade_name}</div>
              <div style={{ fontSize: 12, color: "var(--slate)" }}>{d.mix_description || "—"}</div>
              <div style={{ fontSize: 11, color: "var(--slate)" }}>f'ck {d.fck_28day_mpa} MPa · target mean {Number(d.target_mean_strength_mpa).toFixed(1)} MPa</div>
              <div style={{ fontSize: 11, color: "var(--slate)" }}>Created by {d.created_by_name} on {fmtDate(d.created_at)}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
              <span className={`badge ${d.status === "approved" ? "badge-success" : "badge-warning"}`}>
                {d.status === "approved" ? "Approved" : "Pending approval"}
              </span>
              {d.is_standard_for_grade && <span className="badge badge-neutral">Standard for {d.mix_grade_name}</span>}
              {Number(d.assigned_customer_count) > 0 && <span className="badge badge-neutral">{d.assigned_customer_count} customer(s)</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {d.status === "draft" && (
              <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} disabled={me && d.created_by_name === me.name} onClick={() => approve(d.id)}>
                Approve
              </button>
            )}
            {d.status === "approved" && (
              <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => viewPdf(d.id)}>View PDF</button>
            )}
          </div>
        </div>
      ))}
      {designs.length === 0 && <div style={{ fontSize: 13, color: "var(--slate)" }}>No mix designs yet.</div>}
    </div>
  );
}

function MixDesignForm({ setError, setNotice, onDone, onCancel }) {
  const [form, setForm] = useState({
    mix_grade_id: "", design_ref_code: "", mix_description: "",
    fck_28day_mpa: "", std_deviation_mpa: "4.0", max_agg_size_mm: "20", target_workability_mm: "", design_density_kgm3: "",
    cement_kgm3: "", fly_ash_kgm3: "0", free_water_kgm3: "",
    fine_agg_kgm3: "", coarse_20mm_kgm3: "", coarse_12_5mm_kgm3: "",
    cement_type_source: "", cement_sp_gr: "3.15",
    fly_ash_type_source: "", fly_ash_sp_gr: "",
    fine_agg_type_source: "", fine_agg_sp_gr: "2.75",
    coarse_20mm_type_source: "", coarse_20mm_sp_gr: "2.72",
    coarse_12_5mm_type_source: "", coarse_12_5mm_sp_gr: "2.71",
    fine_moisture_pct: "", fine_absorption_pct: "",
    coarse_20mm_moisture_pct: "", coarse_20mm_absorption_pct: "",
    coarse_12_5mm_moisture_pct: "", coarse_12_5mm_absorption_pct: "",
    notes: "",
  });
  const [admixtures, setAdmixtures] = useState([{ type_brand: "", dosage_pct_of_binder: "", qty_kgm3: "", sp_gr: "" }]);
  const [grades, setGrades] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { apiRequest("/master/mix-grades").then(setGrades).catch((err) => setError(err.message)); }, []);

  function set(field, value) { setForm((f) => ({ ...f, [field]: value })); }
  function updateAdmixture(i, field, value) {
    setAdmixtures((as) => as.map((a, idx) => idx === i ? { ...a, [field]: value } : a));
  }

  const targetMean = form.fck_28day_mpa && form.std_deviation_mpa
    ? (Number(form.fck_28day_mpa) + 1.65 * Number(form.std_deviation_mpa)).toFixed(1)
    : null;
  const totalBinder = (Number(form.cement_kgm3) || 0) + (Number(form.fly_ash_kgm3) || 0);
  const wbRatio = totalBinder ? (Number(form.free_water_kgm3) / totalBinder).toFixed(3) : null;
  const totalAggregate = (Number(form.fine_agg_kgm3) || 0) + (Number(form.coarse_20mm_kgm3) || 0) + (Number(form.coarse_12_5mm_kgm3) || 0);
  const totalAdmixture = admixtures.reduce((sum, a) => sum + (Number(a.qty_kgm3) || 0), 0);
  const densitySum = totalBinder + (Number(form.free_water_kgm3) || 0) + totalAggregate + totalAdmixture;

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest("/lab-technician/mix-designs", {
        method: "POST",
        body: { ...form, admixtures: admixtures.filter((a) => a.type_brand && a.qty_kgm3) },
      });
      setNotice("Mix design saved as draft.");
      onDone();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
      <button type="button" onClick={onCancel} style={{ alignSelf: "flex-start" }}>← Cancel</button>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Identification</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <div style={{ color: "var(--slate)" }}>Mix grade</div>
            <select value={form.mix_grade_id} onChange={(e) => set("mix_grade_id", e.target.value)} required>
              <option value="">Select</option>
              {grades.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>Design ref. code</div>
            <input value={form.design_ref_code} onChange={(e) => set("design_ref_code", e.target.value)} required />
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <div style={{ color: "var(--slate)" }}>Mix description</div>
          <input value={form.mix_description} onChange={(e) => set("mix_description", e.target.value)} placeholder="e.g. M25 (OPC + Fly Ash) 340Kg" />
        </div>
        <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 8 }}>
          Not assigned to any customer here — assign it to one or more customers afterward from Approved Mix Assignments.
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Strength &amp; workability</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <div><div style={{ color: "var(--slate)" }}>f'ck, 28-day</div><input type="number" step="0.1" value={form.fck_28day_mpa} onChange={(e) => set("fck_28day_mpa", e.target.value)} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Std. deviation</div><input type="number" step="0.1" value={form.std_deviation_mpa} onChange={(e) => set("std_deviation_mpa", e.target.value)} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Max agg. size (mm)</div><input type="number" value={form.max_agg_size_mm} onChange={(e) => set("max_agg_size_mm", e.target.value)} /></div>
        </div>
        {targetMean && (
          <div style={{ background: "var(--info-bg, #E3EEF4)", borderRadius: 8, padding: "8px 10px", marginTop: 8 }}>
            Target mean strength (f'ck + 1.65σ): <b>{targetMean} MPa</b>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          <div><div style={{ color: "var(--slate)" }}>Target workability</div><input value={form.target_workability_mm} onChange={(e) => set("target_workability_mm", e.target.value)} placeholder="100 ± 25 mm" /></div>
          <div><div style={{ color: "var(--slate)" }}>Design density (kg/m³)</div><input type="number" value={form.design_density_kgm3} onChange={(e) => set("design_density_kgm3", e.target.value)} /></div>
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Mix proportions (SSD, per m³)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div><div style={{ color: "var(--slate)" }}>Cement (kg/m³)</div><input type="number" value={form.cement_kgm3} onChange={(e) => set("cement_kgm3", e.target.value)} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Fly ash (kg/m³)</div><input type="number" value={form.fly_ash_kgm3} onChange={(e) => set("fly_ash_kgm3", e.target.value)} /></div>
        </div>
        <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>Total binder: {totalBinder.toFixed(1)} kg/m³{wbRatio && ` · W/B ratio: ${wbRatio}`}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          <div><div style={{ color: "var(--slate)" }}>Free water (kg/m³)</div><input type="number" value={form.free_water_kgm3} onChange={(e) => set("free_water_kgm3", e.target.value)} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Fine aggregate (kg/m³)</div><input type="number" value={form.fine_agg_kgm3} onChange={(e) => set("fine_agg_kgm3", e.target.value)} required /></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          <div><div style={{ color: "var(--slate)" }}>Coarse 20mm (kg/m³)</div><input type="number" value={form.coarse_20mm_kgm3} onChange={(e) => set("coarse_20mm_kgm3", e.target.value)} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Coarse 12.5mm (kg/m³)</div><input type="number" value={form.coarse_12_5mm_kgm3} onChange={(e) => set("coarse_12_5mm_kgm3", e.target.value)} required /></div>
        </div>
        <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>Total aggregate: {totalAggregate.toFixed(1)} kg/m³</div>
        {form.design_density_kgm3 && (
          <div style={{ fontSize: 11, color: Math.abs(densitySum - Number(form.design_density_kgm3)) > 30 ? "var(--alert-red)" : "var(--signal-green)", marginTop: 4 }}>
            Binder + water + aggregate + admixture = {densitySum.toFixed(1)} kg/m³ vs. design density {form.design_density_kgm3} kg/m³
            {Math.abs(densitySum - Number(form.design_density_kgm3)) > 30 ? " — check your figures" : " ✓"}
          </div>
        )}
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Admixtures</div>
        {admixtures.map((a, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 6, marginBottom: 6 }}>
            <input placeholder="Type / brand" value={a.type_brand} onChange={(e) => updateAdmixture(i, "type_brand", e.target.value)} />
            <input type="number" step="0.01" placeholder="% binder" value={a.dosage_pct_of_binder} onChange={(e) => updateAdmixture(i, "dosage_pct_of_binder", e.target.value)} />
            <input type="number" step="0.01" placeholder="kg/m³" value={a.qty_kgm3} onChange={(e) => updateAdmixture(i, "qty_kgm3", e.target.value)} />
            <input type="number" step="0.01" placeholder="Sp. gr." value={a.sp_gr} onChange={(e) => updateAdmixture(i, "sp_gr", e.target.value)} />
          </div>
        ))}
        <button type="button" style={{ fontSize: 12 }} onClick={() => setAdmixtures((as) => [...as, { type_brand: "", dosage_pct_of_binder: "", qty_kgm3: "", sp_gr: "" }])}>
          + Add another admixture
        </button>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Aggregate moisture &amp; absorption <span style={{ fontWeight: 400, color: "var(--slate)" }}>— baseline only</span></div>
        {[
          ["Fine — M-Sand", "fine_moisture_pct", "fine_absorption_pct"],
          ["Coarse — 20mm", "coarse_20mm_moisture_pct", "coarse_20mm_absorption_pct"],
          ["Coarse — 12.5mm", "coarse_12_5mm_moisture_pct", "coarse_12_5mm_absorption_pct"],
        ].map(([label, mKey, aKey]) => (
          <div key={mKey} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 6, alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 12 }}>{label}</div>
            <input type="number" step="0.1" placeholder="Moisture %" value={form[mKey]} onChange={(e) => set(mKey, e.target.value)} />
            <input type="number" step="0.1" placeholder="Absorption %" value={form[aKey]} onChange={(e) => set(aKey, e.target.value)} />
          </div>
        ))}
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Materials — type / source / sp. gr.</div>
        {[
          ["Cement", "cement_type_source", "cement_sp_gr"],
          ["Fly ash (SCM)", "fly_ash_type_source", "fly_ash_sp_gr"],
          ["Fine aggregate", "fine_agg_type_source", "fine_agg_sp_gr"],
          ["Coarse 20mm", "coarse_20mm_type_source", "coarse_20mm_sp_gr"],
          ["Coarse 12.5mm", "coarse_12_5mm_type_source", "coarse_12_5mm_sp_gr"],
        ].map(([label, tKey, sKey]) => (
          <div key={tKey} style={{ display: "grid", gridTemplateColumns: "1.1fr 1.6fr 0.7fr", gap: 6, alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 12 }}>{label}</div>
            <input placeholder="Type / source" value={form[tKey]} onChange={(e) => set(tKey, e.target.value)} />
            <input type="number" step="0.01" placeholder="Sp. gr." value={form[sKey]} onChange={(e) => set(sKey, e.target.value)} />
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <div style={{ color: "var(--slate)" }}>Notes</div>
          <textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </div>
      </div>

      <button type="submit" className="btn-primary" disabled={saving}>{saving ? "Saving..." : "Save as draft"}</button>
      <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center" }}>Draft designs show "Pending approval" until a second person approves them.</div>
    </form>
  );
}
