// Round 202 — the HR side of attendance on the phone: enrolling a face and
// moving a registered phone (Employee edit), work locations (Settings), and
// punches whose face check failed (Requests).
import { useEffect, useRef, useState } from "react";
import { apiRequest, BASE_URL } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { loadFaceApi, startCamera, stopCamera, readFace, snapshot, currentPosition } from "../lib/faceKit.js";

// An <img> for a photo behind login (a plain <img src> can't send the token).
export function AuthImg({ path, alt, style }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let u = null, alive = true;
    fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${localStorage.getItem("oorm_token") || ""}` } })
      .then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && alive) { u = URL.createObjectURL(b); setUrl(u); } }).catch(() => {});
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [path]);
  return url ? <img src={url} alt={alt} style={style} /> : <div style={{ ...style, background: "#ECEAE4", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--slate)" }}>no photo</div>;
}

// ---------------------------------------------------------------- face enrolment
export function FacePanel({ employee, canEdit }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [cam, setCam] = useState(false);
  const [v, setV] = useState(0);
  const videoRef = useRef(null), streamRef = useRef(null);
  const load = () => apiRequest(`/hr/employees/${employee.id}/punch-status`).then(setSt).catch(() => {});
  useEffect(() => { load(); return () => stopCamera(streamRef.current); }, [employee.id]);

  async function openCam() {
    setError(""); setMsg(""); setCam(true);
    try { streamRef.current = await startCamera(videoRef.current); loadFaceApi().catch(() => {}); }
    catch (err) { setError(err.message); setCam(false); }
  }
  async function capture() {
    setBusy(true); setError("");
    try {
      const faceapi = await loadFaceApi();
      const f = await readFace(faceapi, videoRef.current);
      if (!f) throw new Error("No face found. Face the camera in good light, without helmet or mask.");
      await apiRequest(`/hr/employees/${employee.id}/face`, { method: "PUT", body: { descriptor: f.descriptor, photo: snapshot(videoRef.current) } });
      stopCamera(streamRef.current); setCam(false); setMsg("Face enrolled."); setV((x) => x + 1); load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function resetPhone() {
    if (!window.confirm(`Forget ${employee.name}'s registered phone? The next phone they mark attendance from becomes the registered one.`)) return;
    await apiRequest(`/hr/employees/${employee.id}/device`, { method: "DELETE" }); load(); setMsg("Registered phone cleared.");
  }

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, marginTop: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Attendance on the phone — face &amp; phone</div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        {st?.enrolled_at ? <AuthImg key={v} path={`/hr/employees/${employee.id}/face/photo`} alt={`${employee.name}, enrolled photo`} style={{ width: 96, height: 72, objectFit: "cover", borderRadius: 8 }} />
          : <div style={{ width: 96, height: 72, borderRadius: 8, background: "#ECEAE4", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--slate)" }}>not enrolled</div>}
        <div style={{ fontSize: 12.5, lineHeight: 1.6, flex: 1, minWidth: 200 }}>
          <div>Face: {st?.enrolled_at ? <b>enrolled {new Date(st.enrolled_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}{st.enrolled_by_name ? ` by ${st.enrolled_by_name}` : ""}</b> : <b style={{ color: "var(--amber)" }}>not enrolled — can't mark on the phone yet</b>}</div>
          <div>Registered phone: {st?.device_registered_at ? <b>since {new Date(st.device_registered_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}</b> : <span>none yet — the first phone used is registered</span>}</div>
          {canEdit && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
              {!cam && <button type="button" onClick={openCam}>{st?.enrolled_at ? "Re-take photo" : "Take photo"}</button>}
              {st?.device_registered_at && <button type="button" onClick={resetPhone}>Move to a new phone</button>}
            </div>
          )}
        </div>
      </div>
      <div style={{ display: cam ? "block" : "none", marginTop: 10 }}>
        <video ref={videoRef} style={{ width: "100%", maxWidth: 360, borderRadius: 10, transform: "scaleX(-1)", background: "#2E3338" }} playsInline muted />
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button type="button" className="btn-primary" disabled={busy} onClick={capture}>{busy ? "Reading face…" : "Use this photo"}</button>
          <button type="button" onClick={() => { stopCamera(streamRef.current); setCam(false); }}>Cancel</button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 4 }}>Good light, facing the camera, no helmet, mask or dark glasses. The person stands in front of this device.</div>
      </div>
      {msg && <div style={{ color: "var(--signal-green)", fontSize: 13, marginTop: 6 }}>{msg}</div>}
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- work locations
export function WorkLocationsCard({ canEdit, canCreate }) {
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState("");
  const [locating, setLocating] = useState(false);
  const load = () => apiRequest("/hr/work-locations").then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  async function here() {
    setLocating(true); setError("");
    try { const p = await currentPosition(); setEdit((x) => ({ ...x, lat: p.lat.toFixed(6), lng: p.lng.toFixed(6), _acc: Math.round(p.accuracy) })); }
    catch (err) { setError(err.message); } finally { setLocating(false); }
  }
  async function save(e) {
    e.preventDefault(); setError("");
    try {
      const body = { ...edit, lat: Number(edit.lat), lng: Number(edit.lng), radius_m: Number(edit.radius_m) };
      if (edit.id) await apiRequest(`/hr/work-locations/${edit.id}`, { method: "PATCH", body });
      else await apiRequest("/hr/work-locations", { method: "POST", body });
      setEdit(null); load();
    } catch (err) { setError(err.message); }
  }
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Work locations — attendance on the phone</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>Staff set to "at the plant" can mark attendance on the phone only within the radius of one of these. Set a point by standing there with a phone and tapping "Use where I am".</div>
      {rows && !rows.length && !edit && <div style={{ fontSize: 13, color: "var(--amber)", marginBottom: 8 }}>No location yet — nobody "at the plant" can mark attendance on the phone until one is added.</div>}
      {rows && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Location</th><th>Point</th><th style={{ textAlign: "right" }}>Radius</th><th></th></tr></thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} style={{ opacity: l.is_active ? 1 : 0.5 }}>
                  <td style={{ fontWeight: 600 }}>{l.name}{!l.is_active && " (off)"}</td>
                  <td style={{ fontSize: 12.5 }}><a href={`https://www.google.com/maps?q=${l.lat},${l.lng}`} target="_blank" rel="noreferrer">{Number(l.lat).toFixed(5)}, {Number(l.lng).toFixed(5)}</a></td>
                  <td style={{ textAlign: "right" }}>{l.radius_m} m</td>
                  <td>{canEdit && <button style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setEdit({ ...l })}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit ? (
        <form onSubmit={save} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginTop: 12, alignItems: "end" }} className="field-input">
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>Name<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>Latitude<input value={edit.lat} onChange={(e) => setEdit({ ...edit, lat: e.target.value })} required /></label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>Longitude<input value={edit.lng} onChange={(e) => setEdit({ ...edit, lng: e.target.value })} required /></label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>Radius (m)<input type="number" min="20" max="5000" value={edit.radius_m} onChange={(e) => setEdit({ ...edit, radius_m: e.target.value })} required /></label>
          <button type="button" onClick={here} disabled={locating}>{locating ? "Reading…" : "Use where I am"}</button>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={edit.is_active !== false} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> In use</label>
          <div style={{ display: "flex", gap: 6 }}><button className="btn-primary" type="submit">Save</button><button type="button" onClick={() => setEdit(null)}>Cancel</button></div>
          {edit._acc && <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--slate)" }}>Read with GPS ±{edit._acc} m.</div>}
        </form>
      ) : canCreate && <button style={{ marginTop: 10 }} onClick={() => setEdit({ name: "Plant — main gate", lat: "", lng: "", radius_m: 200, is_active: true })}>+ Add a location</button>}
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginTop: 8 }}>{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- punches to check
export function PhonePunchReview() {
  const { can } = usePermissions();
  const [rows, setRows] = useState(null);
  const [notes, setNotes] = useState({});
  const [error, setError] = useState("");
  const load = () => apiRequest("/hr/app-punches?status=review").then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  if (!rows || !rows.length) return null;
  const decide = async (p, approve) => {
    setError("");
    try { await apiRequest(`/hr/app-punches/${p.id}/decide`, { method: "POST", body: { approve, note: notes[p.id] || "" } }); load(); }
    catch (err) { setError(err.message); }
  };
  return (
    <div className="card" style={{ marginBottom: 14, borderColor: "var(--amber)" }}>
      <div style={{ fontWeight: 700 }}>Phone punches to check ({rows.length})</div>
      <div style={{ fontSize: 12, color: "var(--slate)", margin: "2px 0 8px" }}>The face check failed 3 times. Look at the photo: approve if it's them, and the punch counts.</div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {rows.map((p) => (
        <div key={p.id} style={{ display: "flex", gap: 12, borderTop: "1px solid var(--border)", padding: "10px 0", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <AuthImg path={`/hr/app-punches/${p.id}/photo`} alt={`Punch photo, ${p.employee_name}`} style={{ width: 96, height: 72, objectFit: "cover", borderRadius: 8 }} />
            <AuthImg path={`/hr/employees/${p.employee_id}/face/photo`} alt={`Enrolled photo, ${p.employee_name}`} style={{ width: 96, height: 72, objectFit: "cover", borderRadius: 8, opacity: 0.85 }} />
          </div>
          <div style={{ flex: 1, minWidth: 200, fontSize: 13 }}>
            <div><b>{p.employee_name}</b> <span style={{ color: "var(--slate)", fontSize: 12 }}>{p.emp_code}{p.department ? ` · ${p.department}` : ""}</span></div>
            <div>{new Date(p.date + "T12:00:00+05:30").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })} · {p.time} · {p.location_name ? `${p.distance_m} m from ${p.location_name}` : "no work location"}</div>
            <div style={{ fontSize: 12, color: "var(--amber)" }}>{p.review_reason} · {p.tries} tries</div>
            <div style={{ fontSize: 11.5, color: "var(--slate)" }}>Left: this punch · right: enrolled photo</div>
          </div>
          {p.can_decide && can("hr.requests", "edit") ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }} className="field-input">
              <input placeholder="Note (required to reject)" value={notes[p.id] || ""} onChange={(e) => setNotes((n) => ({ ...n, [p.id]: e.target.value }))} />
              <button className="btn-primary" onClick={() => decide(p, true)}>It's them — count it</button>
              <button onClick={() => decide(p, false)} style={{ color: "var(--alert-red)" }}>Reject</button>
            </div>
          ) : <div style={{ fontSize: 12, color: "var(--slate)" }}>{p.app_user_role === "manager" ? "Needs Admin." : "You cannot decide this one."}</div>}
        </div>
      ))}
    </div>
  );
}
