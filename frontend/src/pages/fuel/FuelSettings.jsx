import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { TankGraphic, fmtL, fmtRs, fmtWhen, fmtNum } from "./fuelUi.jsx";

// Round 199 — the Fuel module's settings. The user's rule: only an
// Administrator sets the tank capacity. Editing is the "Fuel settings" edit
// permission (Administrator by default); everyone else with the tab sees the
// values read-only.

const FIELDS = ["tank_name", "capacity_l", "reorder_level_l", "warning_days", "band_high_pct", "band_above_pct",
  "band_efficient_pct", "close_fill_hours", "work_start", "work_end"];

function Field({ label, hint, unit, value, onChange, type = "number", disabled, width }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12.5, fontWeight: 600 }}>
      {label}
      <span style={{ position: "relative", display: "block" }}>
        <input type={type} value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value)}
          style={{ width: width || "100%", paddingRight: unit ? 44 : undefined }} />
        {unit && <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 12.5, color: "var(--slate)" }}>{unit}</span>}
      </span>
      {hint && <span style={{ fontSize: 11.5, color: "var(--slate)", fontWeight: 400 }}>{hint}</span>}
    </label>
  );
}

export default function FuelSettings() {
  const { can } = usePermissions();
  const canEdit = can("fuel.settings", "edit");
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [rate, setRate] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const d = await apiRequest("/fuel-module/settings");
      setData(d);
      setForm(Object.fromEntries(FIELDS.map((k) => [k, d.settings[k] ?? ""])));
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function save() {
    setSaving(true); setError(""); setNotice("");
    try {
      const r = await apiRequest("/fuel-module/settings", { method: "PATCH", body: form });
      setNotice(r.changed ? "Settings saved." : "Nothing changed.");
      await load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }
  async function saveRate() {
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest("/fuel-module/rate", { method: "POST", body: { rate_per_liter: rate } });
      setRate(""); setNotice("New rate saved. Issue screens pre-fill cost from it from now on.");
      await load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  if (error && !data) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!data || !form) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;

  const set = (k) => (v) => setForm({ ...form, [k]: v });
  const cap = Number(form.capacity_l) || null;
  const ro = form.reorder_level_l === "" ? null : Number(form.reorder_level_l);
  const dis = !canEdit;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }} className="field-input">
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 21, margin: 0 }}>Fuel settings</h1>
          <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 3 }}>
            {canEdit ? "Only Administrators can change these by default. Manager and Store can see them." : "Read-only — an Administrator changes these."}
          </div>
        </div>
        {data.settings.updated_by_name && <div style={{ fontSize: 12, color: "var(--slate)" }}>Last changed {fmtWhen(data.settings.updated_at)} by {data.settings.updated_by_name}</div>}
      </div>
      {notice && <div style={{ background: "var(--signal-green-bg)", color: "var(--signal-green)", borderRadius: 8, padding: "10px 12px", fontSize: 13 }}>{notice}</div>}
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <section className="card" style={{ flex: "999 1 520px", display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <h2 style={{ fontSize: 16 }}>Tank</h2>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 3 }}>These drive the tank picture, the reorder alert and days of cover.</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16 }}>
            <Field label="Tank name" type="text" value={form.tank_name} onChange={set("tank_name")} disabled={dis} />
            <Field label="Capacity" unit="L" value={form.capacity_l} onChange={set("capacity_l")} disabled={dis} hint="A full tank. The picture is drawn against this." />
            <Field label="Reorder level" unit="L" value={form.reorder_level_l} onChange={set("reorder_level_l")} disabled={dis}
              hint={cap && ro != null ? `${fmtNum((ro / cap) * 100)}% of capacity — the red line on the tank.` : "The red line on the tank."} />
            <Field label="Early warning" unit="days" value={form.warning_days} onChange={set("warning_days")} disabled={dis}
              hint="Warn when stock will reach the reorder level within this many days." />
          </div>
          <div style={{ background: "var(--concrete)", borderRadius: 10, padding: 14, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <TankGraphic current={data.item.current_qty} capacity={cap} reorder={ro} statusKey={ro != null && data.item.current_qty <= ro ? "critical" : "ok"} width={110} compact />
            <div style={{ flex: "1 1 260px", fontSize: 12.5, lineHeight: 1.6 }}>
              <b>Preview</b> with today's {fmtL(data.item.current_qty)}<br />
              Capacity {cap ? fmtL(cap) : "not set"} · reorder at {ro != null ? fmtL(ro) : "not set"}<br />
              <span style={{ color: "var(--slate)" }}>Reorder must be lower than capacity. Changing capacity only redraws the tank — it never changes the stock balance.</span>
            </div>
          </div>

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
            <h2 style={{ fontSize: 16 }}>360° analysis status bands</h2>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 3 }}>How each truck or machine is coloured against its fleet or type average. 12 / 3 / 10 are the values the analysis has always used.</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16 }}>
            <Field label="High consumption — over average by more than" unit="%" value={form.band_high_pct} onChange={set("band_high_pct")} disabled={dis} />
            <Field label="Above average — over average by more than" unit="%" value={form.band_above_pct} onChange={set("band_above_pct")} disabled={dis} />
            <Field label="Efficient — under average by more than" unit="%" value={form.band_efficient_pct} onChange={set("band_efficient_pct")} disabled={dis} />
          </div>

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
            <h2 style={{ fontSize: 16 }}>Exception checks</h2>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 3 }}>Used by the Exceptions view of the 360° analysis.</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16 }}>
            <Field label="Two fills of one vehicle within" unit="hrs" value={form.close_fill_hours} onChange={set("close_fill_hours")} disabled={dis} />
            <Field label="Working hours start" type="time" value={form.work_start} onChange={set("work_start")} disabled={dis} />
            <Field label="Working hours end" type="time" value={form.work_end} onChange={set("work_end")} disabled={dis} hint="Fuel issued outside these hours is flagged." />
          </div>

          {canEdit && (
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <button type="button" onClick={load} disabled={saving}>Cancel</button>
              <button type="button" className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
            </div>
          )}
        </section>

        <section style={{ flex: "1 1 320px", display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div className="card">
            <h2 style={{ fontSize: 16 }}>Rate per litre</h2>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 8 }}>{data.item.rate_per_liter != null ? fmtRs(data.item.rate_per_liter, 2) : "—"}<span style={{ fontSize: 13, color: "var(--slate)", fontWeight: 600 }}> / L</span></div>
            <div style={{ fontSize: 11.5, color: "var(--slate)" }}>Pre-fills the cost on every issue; still editable there.</div>
            {canEdit && (
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 12 }}>
                <Field label="New rate" unit="₹/L" value={rate} onChange={setRate} width={140} />
                <button type="button" className="btn-primary" disabled={saving || rate === ""} onClick={saveRate}>Save</button>
              </div>
            )}
            <table style={{ marginTop: 12 }}>
              <thead><tr><th>From</th><th style={{ textAlign: "right" }}>Rate</th><th>Set by</th></tr></thead>
              <tbody>
                {data.rate_history.map((h, i) => (
                  <tr key={i}><td>{fmtWhen(h.effective_from)}</td><td style={{ textAlign: "right" }}>{fmtRs(h.rate_per_liter, 2)}</td><td style={{ fontSize: 12 }}>{h.set_by_name || h.note || "—"}</td></tr>
                ))}
                {data.rate_history.length === 0 && <tr><td colSpan={3} style={{ color: "var(--slate)" }}>No rate set yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card" style={{ fontSize: 12.5 }}>
            <div className="kpi-label" style={{ marginBottom: 8 }}>Change history</div>
            {data.change_log.length === 0 ? <div style={{ color: "var(--slate)" }}>No changes yet.</div> : (
              <div style={{ lineHeight: 1.7 }}>
                {data.change_log.map((l, i) => (
                  <div key={i}>{fmtWhen(l.changed_at)} · {l.changed_by_name || "—"} · {l.field}: {l.old_value ?? "not set"} → {l.new_value ?? "not set"}</div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
