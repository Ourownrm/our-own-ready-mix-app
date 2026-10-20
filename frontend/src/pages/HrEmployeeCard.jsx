// Round 221 — employee photo and employee details (owner, 21 Oct 2026):
//   * PhotoPanel — choose or take a photo; it is resized here to at most
//     600 px (plus a 96 px thumbnail for the list) before it is sent.
//   * EmployeeDetails — the record read-only, with the photo and a Print
//     button (lib/hrPdf.js printEmployee).
import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";

const money = (v) => (v == null || v === "" ? "—" : "₹" + Number(v).toLocaleString("en-IN"));
const day = (d) => (d ? new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }) : "—");
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Draw an image file into a canvas no larger than `max` px and return a JPEG
// data URL. Square-cropped (centre) when `square`.
function resize(img, max, square, quality = 0.85) {
  let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
  if (square) { const s = Math.min(sw, sh); sx = (sw - s) / 2; sy = (sh - s) / 2; sw = sh = s; }
  const scale = Math.min(1, max / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file is not a photo this browser can read.")); };
    img.src = url;
  });
}

export function usePhoto(id, version) {
  const [photo, setPhoto] = useState(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoaded(false);
    apiRequest(`/hr/employees/${id}/photo`).then((d) => { if (alive) { setPhoto(d.data_url); setLoaded(true); } }).catch(() => alive && setLoaded(true));
    return () => { alive = false; };
  }, [id, version]);
  return { photo, loaded, setPhoto };
}

export function Avatar({ src, name, size = 36 }) {
  const initials = String(name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return src
    ? <img src={src} alt="" width={size} height={size} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flex: "none", border: "1px solid var(--border)" }} />
    : <span aria-hidden="true" style={{ width: size, height: size, borderRadius: "50%", background: "#ECEAE4", color: "var(--slate)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.36, fontWeight: 700, flex: "none" }}>{initials}</span>;
}

export function PhotoPanel({ employee, canEdit, onChanged }) {
  const [ver, setVer] = useState(0);
  const { photo, loaded } = usePhoto(employee.id, ver);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);
  const camRef = useRef(null);

  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true); setError("");
    try {
      const img = await loadImage(file);
      const data_url = resize(img, 600, false);
      const thumb_url = resize(img, 96, true, 0.8);
      await apiRequest(`/hr/employees/${employee.id}/photo`, { method: "PUT", body: { data_url, thumb_url } });
      setVer((v) => v + 1);
      onChanged?.();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(`Remove ${employee.name}'s photo?`)) return;
    setBusy(true); setError("");
    try { await apiRequest(`/hr/employees/${employee.id}/photo`, { method: "DELETE" }); setVer((v) => v + 1); onChanged?.(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ width: 96, height: 120, borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--concrete)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
        {photo ? <img src={photo} alt={`${employee.name}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : <span style={{ fontSize: 11.5, color: "var(--slate)", textAlign: "center", padding: 6 }}>{loaded ? "No photo" : "Loading…"}</span>}
      </div>
      {canEdit && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} style={{ display: "none" }} />
          <input ref={camRef} type="file" accept="image/*" capture="user" onChange={pick} style={{ display: "none" }} />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>{photo ? "Change photo" : "Upload photo"}</button>
            <button type="button" disabled={busy} onClick={() => camRef.current?.click()}>Take photo</button>
            {photo && <button type="button" disabled={busy} onClick={remove}>Remove</button>}
          </div>
          <div style={{ fontSize: 11, color: "var(--slate)" }}>{busy ? "Saving…" : "JPEG, PNG or WebP — resized before upload."}</div>
          {error && <div role="alert" style={{ fontSize: 12, color: "var(--alert-red)" }}>{error}</div>}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 11, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</span>
      <span style={{ fontSize: 13.5, overflowWrap: "anywhere" }}>{children || "—"}</span>
    </div>
  );
}
const SECTION = { fontSize: 12, fontWeight: 700, color: "var(--rebar)", textTransform: "uppercase", letterSpacing: 0.4, margin: "16px 0 8px" };
const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "10px 16px" };

export function EmployeeDetails({ employee: e, canSalary, onEdit, onClose, onChanged }) {
  const { can } = usePermissions();
  const canIds = can("hr.employee-ids", "view");
  const canEdit = can("hr.employees", "edit");
  const [ver, setVer] = useState(0);
  const { photo } = usePhoto(e.id, ver);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState("");
  async function print() {
    setPrinting(true); setError("");
    try {
      const m = await import("../lib/hrPdf.js");
      await m.printEmployee(e, { photo, canSalary, canIds });
    } catch (err) { setError(err.message); } finally { setPrinting(false); }
  }
  const gross = ["salary_basic", "salary_da", "salary_hra", "salary_conveyance", "salary_special"].reduce((t, f) => t + Number(e[f] || 0), 0);
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <PhotoPanel employee={e} canEdit={canEdit} onChanged={() => { setVer((v) => v + 1); onChanged?.(); }} />
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{e.name}</div>
            <div style={{ fontSize: 12.5, color: "var(--slate)" }}>{e.emp_code}{e.designation ? ` · ${e.designation}` : ""}{e.department ? ` · ${e.department}` : ""}</div>
            <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span className={`badge ${e.is_active ? "badge-success" : "badge-neutral"}`}>{e.is_active ? "Active" : "Left"}</span>
              <span className="badge badge-info">{e.employment_type === "contract" ? `Contract${e.contractor_name ? ` — ${e.contractor_name}` : ""}` : "Payroll"}</span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" className="btn-primary" disabled={printing} onClick={print}>{printing ? "Preparing…" : "Print"}</button>
          {canEdit && <button type="button" onClick={onEdit}>Edit</button>}
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
      {error && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 8 }}>{error}</div>}

      <div style={SECTION}>Personal &amp; job</div>
      <div style={GRID}>
        <Row label="Mobile">{e.mobile}</Row>
        <Row label="Joined">{day(e.date_of_joining)}</Row>
        <Row label="Left">{e.date_of_leaving ? day(e.date_of_leaving) : null}</Row>
        <Row label="Designation">{e.designation}</Row>
        <Row label="Department">{e.department}</Row>
      </div>

      <div style={SECTION}>Attendance &amp; timing</div>
      <div style={GRID}>
        <Row label="Attendance">{e.attendance_source === "machine" ? `Machine${e.machine_user_id ? ` #${e.machine_user_id}` : ""}${e.name_on_machine ? ` · ${e.name_on_machine}` : ""}` : e.attendance_source === "app" ? "App" : "Not tracked"}</Row>
        <Row label="App login">{e.app_user_name}</Row>
        <Row label="Phone attendance">{e.app_punch === "plant" ? "At the plant" : e.app_punch === "anywhere" ? "Anywhere" : "Off"}</Row>
        <Row label="Timing">{e.policy === "office" ? `Office${e.default_shift_name ? ` · ${e.default_shift_name}` : ""}` : `Operations${e.default_shift_name ? ` · ${e.default_shift_name}` : ""}`}</Row>
        <Row label="Weekly off">{e.weekly_off == null ? null : WEEKDAY[e.weekly_off]}</Row>
        <Row label="Trip allowance">{e.trip_allowance ? "Yes" : "No"}</Row>
      </div>

      {canSalary && (
        <>
          <div style={SECTION}>Pay</div>
          <div style={GRID}>
            {e.employment_type === "contract" ? (
              <>
                <Row label="Basis">{e.contract_basis === "monthly" ? "Monthly rate" : "Daily rate"}</Row>
                <Row label="Rate">{e.contract_basis === "monthly" ? `${money(e.monthly_rate)} / month` : `${money(e.daily_rate)} / day`}</Row>
                <Row label="Service charge">{e.service_charge_pct ? `${e.service_charge_pct}%` : null}</Row>
              </>
            ) : (
              <>
                <Row label="Basic">{money(e.salary_basic)}</Row><Row label="DA">{money(e.salary_da)}</Row><Row label="HRA">{money(e.salary_hra)}</Row>
                <Row label="Conveyance">{money(e.salary_conveyance)}</Row><Row label="Special">{money(e.salary_special)}</Row>
                <Row label="Gross / month"><b>{money(gross || null)}</b></Row>
                <Row label="PF · ESI">{`${e.pf_applicable ? "PF" : "no PF"} · ${e.esi_applicable ? "ESI" : "no ESI"}`}</Row>
                <Row label="Overtime">{e.ot_eligible ? "Paid" : "Not paid"}</Row>
                <Row label="Incentive">{e.incentive_basis && e.incentive_basis !== "none" ? `${money(e.incentive_rate)}/m³${e.incentive_min_m3 ? ` above ${e.incentive_min_m3} m³` : ""}` : "None"}</Row>
              </>
            )}
          </div>
        </>
      )}

      {canIds && (
        <>
          <div style={SECTION}>Identity &amp; bank</div>
          <div style={GRID}>
            <Row label="Aadhaar">{e.aadhaar_no ? e.aadhaar_no.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3") : null}</Row>
            <Row label="PAN">{e.pan_no}</Row>
            <Row label="Driving licence">{e.dl_no ? `${e.dl_no}${e.dl_valid_till ? ` · till ${day(e.dl_valid_till)}` : ""}` : null}</Row>
            <Row label="Account name">{e.bank_account_name}</Row>
            <Row label="Bank">{e.bank_name}</Row>
            <Row label="Account no.">{e.bank_account_no}</Row>
            <Row label="IFSC">{e.bank_ifsc}</Row>
          </div>
        </>
      )}
      {e.notes && (<><div style={SECTION}>Notes</div><div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{e.notes}</div></>)}
    </div>
  );
}
