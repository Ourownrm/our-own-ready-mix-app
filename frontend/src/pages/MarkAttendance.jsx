// Round 202 — mark attendance on the phone: face (matched on the server
// against the photo HR enrolled, plus a blink), location, registered phone.
// See backend/src/routes/hrPunch.js for the rules.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { loadFaceApi, startCamera, stopCamera, watchForBlink, snapshot, deviceId, currentPosition } from "../lib/faceKit.js";

function distKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const istTime = () => new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

function Check({ state, title, sub }) {
  const tone = state === "ok" ? ["#E5F2EA", "#2F7A4D"] : state === "bad" ? ["#FBE9E7", "#B3261E"] : ["#ECEAE4", "#5E646B"];
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: "1px solid #EEEAE3" }}>
      <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true" style={{ flex: "0 0 auto" }}>
        <circle cx="10" cy="10" r="9" fill={tone[0]} />
        {state === "ok" && <path d="M6 10.5l2.6 2.6L14 7.6" fill="none" stroke={tone[1]} strokeWidth="2" />}
        {state === "bad" && <path d="M10 5.5v5.5M10 13.6v.9" stroke={tone[1]} strokeWidth="2" strokeLinecap="round" />}
        {state !== "ok" && state !== "bad" && <circle cx="10" cy="10" r="2" fill={tone[1]} />}
      </svg>
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</span>
        {sub && <span style={{ fontSize: 11.5, color: "var(--slate)" }}>{sub}</span>}
      </div>
    </div>
  );
}

export default function MarkAttendance() {
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(istTime());
  const [phase, setPhase] = useState("idle"); // idle | loading | camera | checking | done
  const [status, setStatus] = useState("");
  const [loc, setLoc] = useState(null);
  const [face, setFace] = useState(null); // {live, sent}
  const [result, setResult] = useState(null);
  const [problem, setProblem] = useState(null); // {code, error, ...}
  const [tries, setTries] = useState(0);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const load = () => apiRequest("/hr/punch/setup").then(setSetup).catch((e) => setError(e.message));
  useEffect(() => { load(); const t = setInterval(() => setClock(istTime()), 15000); return () => { clearInterval(t); stopCamera(streamRef.current); }; }, []);

  // Round 233 (revised) — working area: the location is checked FIRST. Off,
  // or outside the area → the tap is saved (not counted) and the attendance
  // is not marked; the camera never opens.
  async function areaRefused(pos) {
    const a = setup?.area;
    const outside = !pos.off && a && a.lat != null && distKm(pos, a) > a.km;
    const rough = !pos.off && pos.accuracy > 2000;
    if (!pos.off && !outside && !rough) return false;
    try {
      await apiRequest("/hr/punch", { method: "POST", body: {
        lat: pos.off ? null : pos.lat, lng: pos.off ? null : pos.lng, accuracy: pos.off ? null : pos.accuracy, location_error: pos.off ? pos.error : undefined,
        kind: next === "OUT" ? "out" : "in", device_id: deviceId() } });
    } catch (err) {
      const body = err.data || {};
      setProblem({ code: body.code || "no_location_area", error: err.message, detail: body.detail });
      setPhase("idle"); load();
      return true;
    }
    return false;
  }

  async function begin() {
    setError(""); setProblem(null); setResult(null); setPhase("loading");
    try {
      setStatus("Getting your location…");
      let first = null;
      if (setup?.mode === "area") {
        first = await currentPosition().then((p) => { setLoc(p); return p; }).catch((e) => { const off = { off: true, error: e.message }; setLoc(off); return off; });
        if (await areaRefused(first)) return;
      }
      const posP = first ? Promise.resolve(first) : currentPosition().then((p) => { setLoc(p); return p; });
      setStatus("Opening the camera…");
      const apiP = loadFaceApi();
      streamRef.current = await startCamera(videoRef.current);
      setPhase("camera");
      setStatus("Loading face check…");
      const [faceapi, pos] = await Promise.all([apiP, posP]);
      await attempt(faceapi, pos, tries + 1);
    } catch (err) {
      setError(err.message || String(err));
      setPhase("idle");
      stopCamera(streamRef.current);
    }
  }

  async function attempt(faceapi, pos, n) {
    setTries(n); setPhase("camera"); setProblem(null);
    setStatus("Look at the camera and blink once");
    const { face: f, live } = await watchForBlink(faceapi, videoRef.current, { onTick: setStatus });
    setPhase("checking"); setStatus("Checking…");
    setFace({ live, found: !!f });
    try {
      const r = await apiRequest("/hr/punch", { method: "POST", body: {
        lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy,
        kind: next === "OUT" ? "out" : "in", device_id: deviceId(),
        descriptor: f ? f.descriptor : null, live, tries: n, photo: snapshot(videoRef.current),
      } });
      setResult(r); setPhase("done");
      stopCamera(streamRef.current);
      load();
    } catch (err) {
      const body = err.data || {};
      setProblem({ code: body.code || null, error: err.message, tries_left: body.tries_left });
      if (["face_mismatch", "no_blink", "no_face"].includes(body.code)) { setPhase("retry"); return; }
      setPhase("idle"); stopCamera(streamRef.current);
    }
  }
  async function retry() {
    try { const faceapi = await loadFaceApi(); await attempt(faceapi, loc, tries + 1); } catch (err) { setError(err.message); }
  }

  const s = setup;
  const next = s?.today?.length ? (s.today.length % 2 === 1 ? "OUT" : "IN") : "IN";
  return (
    <>
      <TopBar title="Mark attendance" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px", display: "flex", flexDirection: "column", gap: 12 }}>
        {!s && !error && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}
        {s && !s.allowed && <div className="card" style={{ fontSize: 13.5 }}>{s.reason}</div>}
        {s?.allowed && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
              <div><div style={{ fontSize: 17, fontWeight: 700 }}>{s.employee.name}</div><div style={{ fontSize: 12, color: "var(--slate)" }}>{s.employee.emp_code} · {s.mode === "anywhere" ? "field — any location, saved" : s.mode === "area" ? `working area — ${s.area ? `${s.area.km} km around ${s.area.name}` : "location saved"}` : "at the plant"}</div></div>
              <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{clock}</div>
            </div>
            {!s.enrolled && <div className="card" style={{ background: "var(--amber-bg)", color: "var(--amber)", fontSize: 13 }}>HR hasn't enrolled your face yet. Ask HR to take your photo once — until then, use the gate machine.</div>}

            <div style={{ position: "relative", borderRadius: 16, background: "#2E3338", overflow: "hidden", aspectRatio: "4 / 3", display: phase === "idle" && !result ? "none" : "block" }}>
              <video ref={videoRef} style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} playsInline muted />
              {(phase === "camera" || phase === "checking" || phase === "loading") && (
                <span style={{ position: "absolute", left: 12, bottom: 12, background: "rgba(255,255,255,0.92)", color: "#22262B", fontSize: 12.5, fontWeight: 600, borderRadius: 999, padding: "6px 12px" }}>{status}</span>
              )}
            </div>

            <div className="card" style={{ padding: "4px 12px" }}>
              <Check state={face ? (face.found && face.live && !problem ? "ok" : problem && ["face_mismatch", "no_blink", "no_face"].includes(problem.code) ? "bad" : face.found && face.live ? "ok" : "wait") : "wait"}
                title={problem?.code === "face_mismatch" ? "Face not recognised" : problem?.code === "no_blink" ? "Blink not seen" : problem?.code === "no_face" ? "No face found" : "It's you"}
                sub={problem && ["face_mismatch", "no_blink", "no_face"].includes(problem.code) ? `${problem.error}${problem.tries_left ? ` · ${problem.tries_left} more ${problem.tries_left === 1 ? "try" : "tries"} before it goes to your manager` : ""}` : "Matched to the photo HR enrolled · blink once"} />
              {s.mode === "area" ? (
                <Check state={problem && ["outside_area", "no_location_area"].includes(problem.code) ? "bad" : loc && !loc.off ? "ok" : "wait"}
                  title={problem?.code === "outside_area" ? "Not inside your working area" : problem?.code === "no_location_area" ? "Location not available" : `Inside your working area${s.area ? ` (${s.area.km} km)` : ""}`}
                  sub={problem && ["outside_area", "no_location_area"].includes(problem.code) ? (problem.detail || "Turn location on and try again") : loc && !loc.off ? `GPS ±${Math.round(loc.accuracy)} m · saved with the punch` : s.area ? `Within ${s.area.km} km of ${s.area.name} · location must be on` : "Location must be on"} />
              ) : (
              <Check state={problem?.code === "outside" || problem?.code === "inaccurate" || problem?.code === "no_location" ? "bad" : loc ? "ok" : "wait"}
                title={problem?.code === "outside" ? "Outside the plant" : problem?.code === "inaccurate" ? "Location not accurate enough" : s.mode === "anywhere" ? "Location saved with the punch" : "Inside the plant"}
                sub={problem && ["outside", "inaccurate", "no_location"].includes(problem.code) ? problem.error : loc ? `GPS ±${Math.round(loc.accuracy)} m` : s.mode === "anywhere" ? "Any location" : `Within ${s.locations.map((l) => `${l.radius_m} m of ${l.name}`).join(" or ") || "a work location"}`} />
              )}
              <Check state={problem?.code === "wrong_device" ? "bad" : s.device_registered ? "ok" : "wait"}
                title={problem?.code === "wrong_device" ? "Not your registered phone" : "Your registered phone"}
                sub={problem?.code === "wrong_device" ? problem.error : s.device_registered ? "Registered" : "This phone becomes your registered phone on the first punch"} />
            </div>

            {result && (
              <div className="card" style={{ background: result.status === "ok" && !result.warning ? "var(--signal-green-bg)" : "var(--amber-bg)", color: result.status === "ok" && !result.warning ? "var(--signal-green)" : "var(--amber)", fontSize: 14, fontWeight: 600 }}>
                {result.message}
                {result.warning && <div style={{ fontSize: 12.5, fontWeight: 500, marginTop: 4 }}>Warning for HR: {result.warning === "no_location" ? "no location" : result.warning === "outside_area" ? "outside the working area" : "location not accurate"}{result.warning_note ? ` — ${result.warning_note}` : ""}.</div>}
              </div>
            )}
            {problem && !["face_mismatch", "no_blink", "no_face"].includes(problem.code) && (
              <div className="card" style={{ background: "var(--alert-red-bg)", color: "var(--alert-red)", fontSize: 13.5 }}>
                {problem.error}
                {problem.detail && <div style={{ fontSize: 12.5, marginTop: 4 }}>{problem.detail}</div>}
                {["outside", "outside_area", "no_location_area"].includes(problem.code) && <div style={{ marginTop: 8 }}><Link to="/my-attendance">Working? Ask for On duty →</Link></div>}
              </div>
            )}
            {error && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}

            {phase === "retry" && (
              <button className="btn-primary" style={{ height: 52, fontSize: 16, fontWeight: 700 }} onClick={retry}>Try again</button>
            )}
            {(phase === "idle" || phase === "done") && s.enrolled && (
              <button className="btn-primary" style={{ height: 56, fontSize: 17, fontWeight: 700 }} onClick={begin}>
                Punch {next} · {clock}
              </button>
            )}
            {(phase === "loading" || phase === "camera" || phase === "checking") && <div style={{ textAlign: "center", fontSize: 12.5, color: "var(--slate)" }}>{status}</div>}

            <div className="card" style={{ fontSize: 13 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Today</div>
              {!s.today.length ? <span style={{ color: "var(--slate)" }}>No phone punches yet. The gate machine still works — use either.</span> : s.today.map((p) => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderTop: "1px solid var(--border)" }}>
                  <span>{p.t}{p.kind ? ` · ${p.kind.toUpperCase()}` : ""}{p.warning ? <span style={{ color: "var(--amber)", fontSize: 11.5 }}> · {p.warning === "no_location" ? "no location" : p.warning === "outside_area" ? "outside area" : "rough location"}</span> : null}</span><span style={{ color: p.status === "ok" || p.status === "approved" ? "var(--signal-green)" : p.status === "review" ? "var(--amber)" : "var(--alert-red)" }}>{p.status === "ok" ? "counted" : p.status === "review" ? "waiting for manager" : p.warning ? "not marked — location" : p.status}</span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--slate)", textAlign: "center" }}>Your photo and location are saved with each punch.</div>
          </>
        )}
        {error && !s && <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      </div>
    </>
  );
}
