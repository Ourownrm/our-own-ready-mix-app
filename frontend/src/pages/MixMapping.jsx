// Round 254 — Quality Control → Mix mapping (owner, 31 Oct 2026). QC maps
// each customer's quoted mix design to the plant recipe that makes it. The
// Plant Operator then sees "Mix Design / Recipe: <mix> / <recipe>" on the
// ticket screen ("Not mapped" until this is done). QC Engineer and
// Administrator only.
import { useEffect, useMemo, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";

const sub = { fontSize: 12, color: "var(--slate)" };
const TH = { padding: "9px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--slate)", whiteSpace: "nowrap" };
const TD = { padding: "10px", fontSize: 13, verticalAlign: "top", borderTop: "1px solid var(--border)" };
const code = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5, background: "#F0E9F7", color: "#5a3784", borderRadius: 6, padding: "1px 6px" };
const VIOLET = "#7A4BA8";
const digits = (s) => String(s || "").match(/\d+(\.\d+)?/)?.[0] || "";
const keyOf = (r) => `${r.customer_id}|${r.mix_design_id}`;

export default function MixMapping() {
  const { can } = usePermissions();
  const canEdit = can("quality.mix-mapping", "edit");
  const [data, setData] = useState(null);
  const [recipes, setRecipes] = useState([]);
  const [show, setShow] = useState("not");
  const [grade, setGrade] = useState("");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState({}); // key -> {plant_recipe_id, reason}
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      const [d, r] = await Promise.all([apiRequest("/mix-mapping"), apiRequest("/mix-mapping/recipes")]);
      setData(d); setRecipes(r);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.list || []).filter((r) => {
      if (show === "not" && r.recipe_code && !r.recipe_gone) return false;
      if (show === "mapped" && (!r.recipe_code || r.recipe_gone)) return false;
      if (grade && r.grade_name !== grade) return false;
      if (s && ![r.customer_name, r.mix_code, r.recipe_code, r.sites].some((v) => String(v || "").toLowerCase().includes(s))) return false;
      return true;
    });
  }, [data, show, grade, q]);
  const grades = useMemo(() => [...new Set((data?.list || []).map((r) => r.grade_name))].sort(), [data]);

  // Recipes of the same strength first (suggested), then the rest.
  function recipeOptions(r) {
    const g = digits(r.grade_name);
    const same = recipes.filter((x) => g && digits(x.strength) === g);
    const rest = recipes.filter((x) => !same.includes(x));
    return { same, rest };
  }

  async function save(r) {
    const e = editing[keyOf(r)];
    if (!e?.plant_recipe_id) return setError("Choose the recipe.");
    if (r.recipe_code && !r.recipe_gone && !e.reason?.trim()) return setError("Give a reason for changing the recipe.");
    setError("");
    try {
      const res = await apiRequest("/mix-mapping", { method: "PUT", body: { customer_id: r.customer_id, mix_design_id: r.mix_design_id, plant_recipe_id: Number(e.plant_recipe_id), reason: e.reason || (r.recipe_gone ? "recipe no longer in the plant" : "") } });
      setEditing((x) => { const n = { ...x }; delete n[keyOf(r)]; return n; });
      setNotice(`${r.customer_name} · ${r.mix_code} → ${res.recipe_code}`);
      load();
    } catch (err) { setError(err.message); }
  }
  async function showHistory(r) {
    try { setHistory({ r, rows: await apiRequest(`/mix-mapping/history?customer_id=${r.customer_id}&mix_design_id=${r.mix_design_id}`) }); } catch (e) { setError(e.message); }
  }

  const c = data?.counts;
  return (
    <>
      <TopBar title="Mix Mapping" />
      <div className="field-input" style={{ maxWidth: 1240, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ ...sub, marginBottom: 12 }}>Quality Control · each customer's quoted mix design → the plant recipe that makes it. The Plant Operator sees the recipe on the ticket screen.</div>
        {error && <div className="card" style={{ marginBottom: 10, color: "var(--alert-red)", background: "var(--alert-red-bg)", fontSize: 13 }}>{error} <button type="button" onClick={() => setError("")} style={{ marginLeft: 8, padding: "2px 8px" }}>✕</button></div>}
        {notice && <div className="card" style={{ marginBottom: 10, color: "var(--signal-green)", background: "var(--signal-green-bg)", fontSize: 13 }}>Mapped: {notice}</div>}

        {c && (
          <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 14 }}>
            <div className="card" style={{ padding: "12px 14px" }}><div style={sub}>Customer mix designs (price lists)</div><div style={{ fontSize: 22, fontWeight: 700 }}>{c.total}</div></div>
            <div className="card" style={{ padding: "12px 14px" }}><div style={sub}>Mapped to a plant recipe</div><div style={{ fontSize: 22, fontWeight: 700, color: "var(--signal-green)" }}>{c.mapped - c.gone}</div></div>
            <div className="card" style={{ padding: "12px 14px", background: c.not_mapped ? "var(--amber-bg)" : undefined, borderColor: c.not_mapped ? "var(--amber)" : undefined }}>
              <div style={{ ...sub, color: c.not_mapped ? "#7a5410" : sub.color }}>Not mapped</div><div style={{ fontSize: 22, fontWeight: 700, color: "var(--amber)" }}>{c.not_mapped}</div>
              {c.urgent > 0 && <div style={{ ...sub, color: "#7a5410" }}>{c.urgent} with an order coming</div>}
            </div>
            <div className="card" style={{ padding: "12px 14px", background: c.gone ? "var(--alert-red-bg)" : undefined, borderColor: c.gone ? "var(--alert-red)" : undefined }}>
              <div style={{ ...sub, color: c.gone ? "var(--alert-red)" : sub.color }}>Recipe gone from the plant</div><div style={{ fontSize: 22, fontWeight: 700, color: "var(--alert-red)" }}>{c.gone}</div>
              {c.gone > 0 && <div style={{ ...sub, color: "var(--alert-red)" }}>map again</div>}
            </div>
          </section>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", marginBottom: 12 }}>
          <button type="button" className={`btn-tab ${show === "not" ? "active" : ""}`} onClick={() => setShow("not")}>Not mapped{c ? ` · ${c.not_mapped + c.gone}` : ""}</button>
          <button type="button" className={`btn-tab ${show === "mapped" ? "active" : ""}`} onClick={() => setShow("mapped")}>Mapped</button>
          <button type="button" className={`btn-tab ${show === "all" ? "active" : ""}`} onClick={() => setShow("all")}>All</button>
          <label style={{ ...sub, fontWeight: 600, display: "flex", flexDirection: "column", gap: 4 }}>Grade
            <select value={grade} onChange={(e) => setGrade(e.target.value)}><option value="">All grades</option>{grades.map((g) => <option key={g}>{g}</option>)}</select></label>
          <label style={{ ...sub, fontWeight: 600, display: "flex", flexDirection: "column", gap: 4, marginLeft: "auto" }}>Search
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer, mix code, recipe" style={{ width: 250 }} /></label>
        </div>

        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
            <thead><tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Customer · sites</th><th style={TH}>Grade</th><th style={TH}>Mix design (quotation)</th><th style={{ ...TH, width: 320 }}>Recipe (from the plant)</th><th style={TH}>Status</th><th style={TH}></th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const k = keyOf(r);
                const e = editing[k];
                const open = !!e || (!r.recipe_code && canEdit);
                const { same, rest } = recipeOptions(r);
                const val = e?.plant_recipe_id || "";
                return (
                  <tr key={k} style={{ background: open ? "#FBF8F2" : undefined }}>
                    <td style={TD}><b>{r.customer_name}</b><div style={sub}>{[r.sites, r.quote_nos].filter(Boolean).join(" · ")}</div></td>
                    <td style={TD}>{r.grade_name}</td>
                    <td style={TD}><span style={code}>{r.design_ref_code}</span>{r.revision != null ? ` rev ${r.revision}` : ""}{r.mix_description && <div style={sub}>{r.mix_description}</div>}</td>
                    <td style={TD}>
                      {open && canEdit ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <select aria-label={`Recipe for ${r.mix_code}`} value={val} onChange={(ev) => setEditing((x) => ({ ...x, [k]: { ...(x[k] || {}), plant_recipe_id: ev.target.value } }))} style={{ minWidth: 240 }}>
                            <option value="">Choose recipe…</option>
                            {same.length > 0 && <optgroup label={`Same strength (${r.grade_name})`}>{same.map((x) => <option key={x.id} value={x.id}>{x.recipe_code}{x.recipe_name ? ` — ${x.recipe_name}` : ""}{x.strength ? ` · ${x.strength}` : ""}</option>)}</optgroup>}
                            <optgroup label="Other recipes">{rest.map((x) => <option key={x.id} value={x.id}>{x.recipe_code}{x.recipe_name ? ` — ${x.recipe_name}` : ""}{x.strength ? ` · ${x.strength}` : ""}</option>)}</optgroup>
                          </select>
                          {r.recipe_code && !r.recipe_gone && <input placeholder="Reason for the change" value={e?.reason || ""} onChange={(ev) => setEditing((x) => ({ ...x, [k]: { ...(x[k] || {}), reason: ev.target.value } }))} />}
                        </div>
                      ) : r.recipe_code ? (
                        <><span style={{ ...code, ...(r.recipe_gone ? { textDecoration: "line-through", background: "#ECEAE4", color: "var(--slate)" } : {}) }}>{r.recipe_code}</span>
                          <div style={{ ...sub, color: r.recipe_gone ? "var(--alert-red)" : sub.color }}>{r.recipe_gone ? "no longer in the plant's recipe list" : [r.recipe_name, r.recipe_strength].filter(Boolean).join(" · ")}</div></>
                      ) : <span style={sub}>—</span>}
                    </td>
                    <td style={TD}>
                      {r.recipe_gone ? <span className="badge badge-danger">Map again</span>
                        : r.recipe_code ? <><span className="badge badge-success">Mapped</span><div style={sub}>{r.mapped_by || ""}{r.mapped_at ? ` · ${new Date(r.mapped_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}` : ""}</div></>
                        : <><span className="badge badge-warning">Not mapped</span>{r.next_order && <div style={{ ...sub, color: "var(--alert-red)" }}>order on {r.next_order}</div>}</>}
                    </td>
                    <td style={{ ...TD, whiteSpace: "nowrap" }}>
                      <span style={{ display: "flex", gap: 6 }}>
                        {open && canEdit && <button type="button" onClick={() => save(r)} style={{ background: VIOLET, borderColor: VIOLET, color: "#fff", fontWeight: 600 }}>Save</button>}
                        {e && r.recipe_code && <button type="button" onClick={() => setEditing((x) => { const n = { ...x }; delete n[k]; return n; })}>Back</button>}
                        {!open && canEdit && <button type="button" onClick={() => setEditing((x) => ({ ...x, [k]: { plant_recipe_id: r.recipe_gone ? "" : String(r.plant_recipe_id || ""), reason: "" } }))}>Change</button>}
                        {r.recipe_code && <button type="button" onClick={() => showHistory(r)}>History</button>}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {data && rows.length === 0 && <tr><td colSpan={6} style={{ ...TD, color: "var(--slate)" }}>{show === "not" ? "Every customer mix design is mapped." : "Nothing here."}</td></tr>}
            </tbody>
          </table>
        </div>

        {history && (
          <section className="card" style={{ padding: 14, marginTop: 14, maxWidth: 620 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><b style={{ fontSize: 14 }}>History · {history.r.customer_name} · {history.r.mix_code}</b><button type="button" onClick={() => setHistory(null)} style={{ padding: "2px 8px" }}>✕</button></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8, fontSize: 13 }}>
              {history.rows.map((h, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 6, flexWrap: "wrap" }}>
                  <span>{new Date(h.changed_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })} · {h.new_recipe_code} {h.old_recipe_code && <span style={sub}>was {h.old_recipe_code}</span>}</span>
                  <span style={sub}>{h.changed_by || "—"} · {h.old_recipe_code ? `“${h.reason || ""}”` : "first mapping"}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
