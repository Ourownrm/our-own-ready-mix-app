import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.jsx";

const EQUIPMENT_TABS = [
  { type: "truck", label: "Truck" },
  { type: "pump", label: "Pump" },
  { type: "pickup_van", label: "Pickup van" },
  { type: "loader", label: "Loader" },
  { type: "generator", label: "Generator" },
];

export default function FuelFilling() {
  const { user } = useAuth();
  const isAccountant = user?.role === "accountant";
  return isAccountant ? <FuelCostReport /> : <RequestFlow />;
}

function RequestFlow() {
  const { user } = useAuth();
  // Round 134, item 2 — a Loader Operator only ever deals with loaders, so
  // skip the "which vehicle/machine type" picker entirely for that role
  // rather than showing trucks/pumps/pickup vans/generators that will never
  // apply to them.
  const isLoaderOperator = user?.role === "loader_operator";
  const equipmentTabs = isLoaderOperator ? EQUIPMENT_TABS.filter((t) => t.type === "loader") : EQUIPMENT_TABS;

  const [trucks, setTrucks] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [stations, setStations] = useState([]);
  const [lubricantTypes, setLubricantTypes] = useState([]);
  const [myRequests, setMyRequests] = useState([]);

  const [requestType, setRequestType] = useState("fuel");
  const [equipmentType, setEquipmentType] = useState(isLoaderOperator ? "loader" : "truck");
  // Round 134, items 1-2 — Loader Operator can also report a breakdown or
  // request an outside repair for their loader, right from this same
  // screen (their whole dashboard), not just fuel/lubricant.
  const [loaderView, setLoaderView] = useState(null); // null | 'breakdown' | 'repair'
  const [unitId, setUnitId] = useState("");
  const [odometer, setOdometer] = useState("");
  const [hourMeter, setHourMeter] = useState("");
  const [quantity, setQuantity] = useState("");
  const [stationId, setStationId] = useState("");
  const [lubricantTypeId, setLubricantTypeId] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      const [t, p, e, s, lt, mine] = await Promise.all([
        apiRequest("/master/trucks"),
        apiRequest("/master/pumps"),
        apiRequest("/master/equipment"),
        apiRequest("/master/fuel-stations"),
        apiRequest("/master/lubricant-types"),
        apiRequest("/supply-requests/mine"),
      ]);
      setTrucks(t); setPumps(p); setEquipment(e); setStations(s); setLubricantTypes(lt); setMyRequests(mine);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => {
    load();
    const interval = setInterval(load, 15000); // so an approval/issue elsewhere shows up, and an issued QR disappears
    return () => clearInterval(interval);
  }, []);

  const unitOptions = {
    truck: trucks.map((t) => ({ id: t.id, label: t.truck_number })),
    pump: pumps.map((p) => ({ id: p.id, label: p.pump_code })),
    pickup_van: equipment.filter((e) => e.equipment_type === "pickup_van").map((e) => ({ id: e.id, label: e.name })),
    loader: equipment.filter((e) => e.equipment_type === "loader").map((e) => ({ id: e.id, label: e.name })),
    generator: equipment.filter((e) => e.equipment_type === "generator").map((e) => ({ id: e.id, label: e.name })),
  }[equipmentType];

  function switchType(type) {
    setEquipmentType(type);
    setUnitId("");
  }

  async function submit(e) {
    e.preventDefault();
    setError(""); setNotice("");
    if (!unitId) return setError("Select which unit this is.");
    if (!odometer && !hourMeter) return setError("Enter either an odometer reading or an hour meter reading — needed for later analysis.");
    if (!quantity) return setError("Enter the quantity needed.");
    if (requestType === "fuel" && !stationId) return setError("Select a filling station.");
    if (requestType === "lubricant" && !lubricantTypeId) return setError("Select which lubricant.");

    const body = {
      request_type: requestType,
      equipment_type: equipmentType,
      odometer_reading: odometer || null,
      hour_meter_reading: hourMeter || null,
      requested_quantity: quantity,
      fuel_station_id: requestType === "fuel" ? stationId : null,
      lubricant_type_id: requestType === "lubricant" ? lubricantTypeId : null,
    };
    if (equipmentType === "truck") body.truck_id = unitId;
    else if (equipmentType === "pump") body.pump_id = unitId;
    else body.equipment_id = unitId;

    setSaving(true);
    try {
      await apiRequest("/supply-requests", { method: "POST", body });
      setNotice("Request sent — waiting on Manager approval.");
      setUnitId(""); setOdometer(""); setHourMeter(""); setQuantity(""); setStationId(""); setLubricantTypeId("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const active = myRequests.filter((r) => r.status !== "issued");
  const recentIssued = myRequests.filter((r) => r.status === "issued");
  const loaders = equipment.filter((e) => e.equipment_type === "loader");

  if (isLoaderOperator && loaderView === "breakdown") {
    return (
      <LoaderBreakdownForm
        loaders={loaders}
        onCancel={() => setLoaderView(null)}
        onDone={(msg) => { setLoaderView(null); setNotice(msg); }}
      />
    );
  }
  if (isLoaderOperator && loaderView === "repair") {
    return (
      <LoaderRepairForm
        loaders={loaders}
        onCancel={() => setLoaderView(null)}
        onDone={(msg) => { setLoaderView(null); setNotice(msg); }}
      />
    );
  }

  return (
    <>
      <TopBar title="Fuel and lubricants" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>

        {isLoaderOperator && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
            <button type="button" onClick={() => setLoaderView("breakdown")}>Report breakdown</button>
            <button type="button" onClick={() => setLoaderView("repair")}>Request outside repair</button>
          </div>
        )}

        {active.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Your requests</div>
            {active.map((r) => <RequestStatusCard key={r.id} request={r} onReload={load} />)}
          </div>
        )}

        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>New request</div>

          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button type="button" onClick={() => setRequestType("fuel")} style={{ flex: 1, padding: "8px", fontSize: 13, fontWeight: requestType === "fuel" ? 600 : 400, background: requestType === "fuel" ? "var(--concrete)" : "transparent" }}>Fuel</button>
            <button type="button" onClick={() => setRequestType("lubricant")} style={{ flex: 1, padding: "8px", fontSize: 13, fontWeight: requestType === "lubricant" ? 600 : 400, background: requestType === "lubricant" ? "var(--concrete)" : "transparent" }}>Lubricant</button>
          </div>

          {equipmentTabs.length > 1 && (
            <>
              <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 6 }}>Vehicle or machine type</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                {equipmentTabs.map((t) => (
                  <button
                    key={t.type}
                    type="button"
                    onClick={() => switchType(t.type)}
                    style={{
                      padding: "6px 12px", borderRadius: 999, fontSize: 12,
                      border: equipmentType === t.type ? "1px solid var(--rebar)" : "1px solid var(--border, #ccc)",
                      background: equipmentType === t.type ? "var(--concrete)" : "transparent",
                      fontWeight: equipmentType === t.type ? 600 : 400,
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </>
          )}

          <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>Which {equipmentTabs.find((t) => t.type === equipmentType)?.label.toLowerCase() || EQUIPMENT_TABS.find((t) => t.type === equipmentType).label.toLowerCase()}</div>
              <select value={unitId} onChange={(e) => setUnitId(e.target.value)} required>
                <option value="">Select</option>
                {unitOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <div style={{ color: "var(--slate)" }}>Odometer reading</div>
                <input type="number" value={odometer} onChange={(e) => setOdometer(e.target.value)} placeholder="45210" />
              </div>
              <div>
                <div style={{ color: "var(--slate)" }}>Hour meter reading</div>
                <input type="number" value={hourMeter} onChange={(e) => setHourMeter(e.target.value)} placeholder="1287" />
              </div>
            </div>
            <div style={{ fontSize: 11, color: "var(--slate)", marginTop: -4 }}>Enter at least one of the two above.</div>

            {requestType === "fuel" ? (
              <div>
                <div style={{ color: "var(--slate)" }}>Filling station</div>
                <select value={stationId} onChange={(e) => setStationId(e.target.value)} required>
                  <option value="">Select</option>
                  {stations.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_plant ? " (plant)" : ""}</option>)}
                </select>
              </div>
            ) : (
              <div>
                <div style={{ color: "var(--slate)" }}>Lubricant</div>
                <select value={lubricantTypeId} onChange={(e) => setLubricantTypeId(e.target.value)} required>
                  <option value="">Select</option>
                  {lubricantTypes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            )}

            <div>
              <div style={{ color: "var(--slate)" }}>Quantity {requestType === "fuel" ? "(litres)" : "(litres/kg)"}</div>
              <input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
            </div>

            {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
            {notice && <div style={{ color: "var(--signal-green)" }}>{notice}</div>}
            <button type="submit" disabled={saving}>{saving ? "Sending..." : "Send request"}</button>
          </form>
        </div>

        {recentIssued.length > 0 && (
          <div className="card">
            <div style={{ fontWeight: 600, marginBottom: 10 }}>Issued today</div>
            {recentIssued.map((r) => (
              <div key={r.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--concrete)", fontSize: 12 }}>
                <span>{unitLabel(r)} &middot; {r.request_type === "fuel" ? `${r.actual_quantity_issued} L` : `${r.actual_quantity_issued} ${r.lubricant_type_name}`}</span>
                <span style={{ color: "var(--slate)" }}>{new Date(r.issued_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function unitLabel(r) {
  return r.truck_number || r.pump_code || r.equipment_name || "—";
}

function refNumber(r) {
  return `${r.request_type === "fuel" ? "FR" : "LR"}-${r.id}`;
}

// Round 134, items 1-2 — Loader Operator equivalents of DriverDuty.jsx's
// BreakdownForm/RequestRepairForm, adapted to pick a loader (equipment_id)
// instead of a truck. Post to the new /loader-operator/* routes, which
// write into the same breakdown_reports/external_repairs tables the truck
// flow uses, so they show up on Manager's existing screens unchanged.
function LoaderBreakdownForm({ loaders, onDone, onCancel }) {
  const [issueTypes, setIssueTypes] = useState([]);
  const [issueType, setIssueType] = useState("");
  const [equipmentId, setEquipmentId] = useState(loaders.length === 1 ? loaders[0].id : "");
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/master/breakdown-issue-types").then(setIssueTypes).catch(() => {});
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (!equipmentId) return setError("Select which loader this is.");
    if (!issueType) return setError("Select what happened.");
    if (issueType === "other" && !remarks.trim()) return setError("Add a short description.");
    setSaving(true); setError("");
    try {
      await apiRequest("/loader-operator/breakdown", { method: "POST", body: { equipment_id: equipmentId, issue_type: issueType, remarks } });
      onDone("Breakdown reported. The manager has been notified.");
    } catch (err) {
      setError(err.message || "Couldn't save this — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title="Loader Operator · Report breakdown" />
      <div style={{ maxWidth: 320, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 16 }}>Report breakdown</div>
          <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>Which loader</div>
              <select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} required>
                <option value="">Select a loader</option>
                {loaders.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>What happened</div>
              <select value={issueType} onChange={(e) => setIssueType(e.target.value)} required>
                <option value="">Select an issue</option>
                {issueTypes.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
              </select>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>
                {issueType === "other" ? "Describe what happened" : "Additional details (optional)"}
              </div>
              <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} required={issueType === "other"} />
            </div>
            {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" disabled={saving}>{saving ? "Saving..." : "Submit"}</button>
              <button type="button" onClick={onCancel}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

function LoaderRepairForm({ loaders, onDone, onCancel }) {
  const [equipmentId, setEquipmentId] = useState(loaders.length === 1 ? loaders[0].id : "");
  const [issueDescription, setIssueDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (!equipmentId) return setError("Select which loader this is.");
    if (!issueDescription.trim()) return setError("Describe the issue.");
    setSaving(true); setError("");
    try {
      await apiRequest("/loader-operator/external-repair", { method: "POST", body: { equipment_id: equipmentId, issue_description: issueDescription } });
      onDone("Repair request sent — waiting on Manager approval.");
    } catch (err) {
      setError(err.message || "Couldn't save this — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title="Loader Operator · Request outside repair" />
      <div style={{ maxWidth: 320, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 16 }}>Request outside repair</div>
          <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>Which loader</div>
              <select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} required>
                <option value="">Select a loader</option>
                {loaders.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Describe the issue</div>
              <textarea rows={3} value={issueDescription} onChange={(e) => setIssueDescription(e.target.value)} required />
            </div>
            {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" disabled={saving}>{saving ? "Sending..." : "Send request"}</button>
              <button type="button" onClick={onCancel}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

function RequestStatusCard({ request: r, onReload }) {
  const isFuel = r.request_type === "fuel";
  const itemLabel = isFuel ? `${r.requested_quantity} L fuel` : `${r.requested_quantity} ${r.lubricant_type_name}`;

  if (r.status === "pending") {
    return (
      <div style={{ background: "var(--amber-bg)", border: "1px solid var(--amber)", borderRadius: 10, padding: "10px 12px", marginBottom: 8, fontSize: 12 }}>
        <div style={{ fontWeight: 600 }}>{unitLabel(r)} &middot; {itemLabel}</div>
        <div style={{ color: "var(--slate)" }}>Waiting for Manager approval</div>
      </div>
    );
  }
  if (r.status === "rejected") {
    return (
      <div style={{ background: "var(--alert-red-bg, #FBEAEA)", border: "1px solid var(--alert-red)", borderRadius: 10, padding: "10px 12px", marginBottom: 8, fontSize: 12 }}>
        <div style={{ fontWeight: 600 }}>{unitLabel(r)} &middot; {itemLabel}</div>
        <div style={{ color: "var(--alert-red)" }}>Rejected — {r.rejected_reason}</div>
      </div>
    );
  }
  // approved
  const isPlantIssue = !isFuel || r.approved_station_is_plant;
  const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(r.qr_token)}`;

  return (
    <div style={{ background: "var(--surface-2, #fff)", border: "1px solid var(--rebar)", borderRadius: 12, padding: 14, marginBottom: 8, textAlign: "center" }}>
      <div style={{ display: "inline-block", background: "var(--signal-green)", color: "#fff", fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999, marginBottom: 6 }}>Approved</div>
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: 0.5, marginBottom: 4 }}>{refNumber(r)}</div>
      <div style={{ fontSize: 17, fontWeight: 600 }}>{unitLabel(r)}</div>
      <div style={{ fontSize: 16, color: "var(--slate)", marginBottom: 10 }}>{r.approved_quantity} {isFuel ? "L" : r.lubricant_type_name}{isFuel && r.approved_station_name ? ` · ${r.approved_station_name}` : ""}</div>

      {isPlantIssue ? (
        <>
          <img src={qrImgUrl} alt="QR code to show Store" style={{ width: 160, height: 160, margin: "0 auto 8px" }} />
          <div style={{ fontSize: 11, color: "var(--slate)" }}>Show this to Store to receive it. Disappears once issued.</div>
        </>
      ) : (
        <ShareableSlip request={r} onReload={onReload} />
      )}
    </div>
  );
}

function ShareableSlip({ request: r, onReload }) {
  const slipRef = useRef(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [actualQty, setActualQty] = useState(r.approved_quantity);
  const [cost, setCost] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmError, setConfirmError] = useState("");

  async function submitFill() {
    if (!actualQty) { setConfirmError("Enter the actual quantity filled."); return; }
    setSaving(true); setConfirmError("");
    try {
      await apiRequest(`/supply-requests/${r.id}/confirm-external-fill`, {
        method: "POST",
        body: { actual_quantity_issued: actualQty, fuel_cost: cost || null },
      });
      onReload?.();
    } catch (err) {
      setConfirmError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function share() {
    setSharing(true); setShareError("");
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(slipRef.current, { backgroundColor: "#ffffff", scale: 2 });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const file = new File([blob], "fuel-approval-slip.png", { type: "image/png" });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: "Fuel approval slip" });
        } catch {
          // cancelled by the user — not an error
        }
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "fuel-approval-slip.png";
        a.click();
        URL.revokeObjectURL(url);
        window.alert("Sharing images isn't supported on this browser — the slip was downloaded instead. Attach it to WhatsApp or however you'd like to send it.");
      }
    } catch (err) {
      setShareError("Couldn't create the slip image — try again.");
    } finally {
      setSharing(false);
    }
  }

  return (
    <div style={{ textAlign: "left", fontSize: 12 }}>
      <div ref={slipRef} style={{ position: "relative", background: "#fff", borderRadius: 8, padding: 16, marginBottom: 8, border: "1px solid #ddd", overflow: "hidden" }}>
        <div style={{
          position: "absolute", inset: 0, backgroundImage: "url(/logo.jpg)",
          backgroundRepeat: "repeat", backgroundSize: "70px 70px", opacity: 0.06, pointerEvents: "none",
        }} />
        <div style={{ position: "relative" }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2, color: "#111" }}>Our Own Ready Mix — fuel approval</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#333", marginBottom: 6 }}>{new Date(r.approved_at).toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
          <div style={{ display: "inline-block", background: "#E1F5EE", color: "#0F6E56", fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999, marginBottom: 6 }}>Approved</div>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: 0.5, color: "#111", marginBottom: 8 }}>{refNumber(r)}</div>

          <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderTop: "1px solid #eee", color: "#111", fontSize: 15, fontWeight: 500 }}><span style={{ color: "#777", fontWeight: 400, fontSize: 12 }}>Station</span><span>{r.approved_station_name}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderTop: "1px solid #eee", color: "#111", fontSize: 15, fontWeight: 500 }}><span style={{ color: "#777", fontWeight: 400, fontSize: 12 }}>Vehicle</span><span>{unitLabel(r)}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderTop: "1px solid #eee", color: "#222" }}><span style={{ color: "#777" }}>Driver</span><span>{r.requested_by_name || ""}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderTop: "1px solid #eee", borderBottom: "1px solid #eee", color: "#111", fontSize: 15, fontWeight: 500 }}><span style={{ color: "#777", fontWeight: 400, fontSize: 12 }}>Quantity</span><span>{r.approved_quantity} L</span></div>

          <div style={{ marginTop: 8, fontSize: 9, color: "#aaa", textAlign: "center", letterSpacing: 0.5 }}>
            {refNumber(r)} &middot; {(r.requested_by_name || "").toUpperCase()} &middot; {refNumber(r)} &middot; {(r.requested_by_name || "").toUpperCase()}
          </div>
        </div>
      </div>
      {shareError && <div style={{ color: "var(--alert-red)", marginBottom: 6 }}>{shareError}</div>}
      <button onClick={share} disabled={sharing} style={{ width: "100%", marginBottom: 10 }}>{sharing ? "Preparing..." : "Share to station"}</button>

      <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 10 }}>
        {!confirming ? (
          <button onClick={() => setConfirming(true)} style={{ width: "100%", fontSize: 12 }}>Mark as filled</button>
        ) : (
          <>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Confirm what was actually filled</div>
            <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 4 }}>Actual quantity (litres)</div>
            <input type="number" value={actualQty} onChange={(e) => setActualQty(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
            <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 4 }}>Cost (₹, optional)</div>
            <input type="number" value={cost} onChange={(e) => setCost(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
            {confirmError && <div style={{ color: "var(--alert-red)", fontSize: 12, marginBottom: 6 }}>{confirmError}</div>}
            <button onClick={submitFill} disabled={saving} style={{ width: "100%", fontSize: 12, background: "var(--signal-green)", color: "#fff", border: "none" }}>
              {saving ? "Saving..." : "Confirm"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function FuelCostReport() {
  return (
    <>
      <TopBar title="Fuel and lubricants" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ fontSize: 13, color: "var(--slate)", marginBottom: 16 }}>
          Fuel and lubricant requests are logged by drivers and machine operators now — no self-service entry here.
        </div>
        <Link to="/fuel-report"><button type="button" style={{ width: "100%" }}>Open fuel and lubricant report</button></Link>
      </div>
    </>
  );
}