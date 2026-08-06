import { useEffect, useRef, useState } from "react";
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
  const [trucks, setTrucks] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [stations, setStations] = useState([]);
  const [lubricantTypes, setLubricantTypes] = useState([]);
  const [myRequests, setMyRequests] = useState([]);

  const [requestType, setRequestType] = useState("fuel");
  const [equipmentType, setEquipmentType] = useState("truck");
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

  return (
    <>
      <TopBar title="Fuel and lubricants" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>

        {active.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Your requests</div>
            {active.map((r) => <RequestStatusCard key={r.id} request={r} />)}
          </div>
        )}

        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>New request</div>

          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button type="button" onClick={() => setRequestType("fuel")} style={{ flex: 1, padding: "8px", fontSize: 13, fontWeight: requestType === "fuel" ? 600 : 400, background: requestType === "fuel" ? "var(--concrete)" : "transparent" }}>Fuel</button>
            <button type="button" onClick={() => setRequestType("lubricant")} style={{ flex: 1, padding: "8px", fontSize: 13, fontWeight: requestType === "lubricant" ? 600 : 400, background: requestType === "lubricant" ? "var(--concrete)" : "transparent" }}>Lubricant</button>
          </div>

          <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 6 }}>Vehicle or machine type</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {EQUIPMENT_TABS.map((t) => (
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

          <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>Which {EQUIPMENT_TABS.find((t) => t.type === equipmentType).label.toLowerCase()}</div>
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

function RequestStatusCard({ request: r }) {
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
      <div style={{ display: "inline-block", background: "var(--signal-green)", color: "#fff", fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999, marginBottom: 8 }}>Approved</div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{unitLabel(r)}</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>{r.approved_quantity} {isFuel ? "L" : r.lubricant_type_name}{isFuel && r.approved_station_name ? ` · ${r.approved_station_name}` : ""}</div>

      {isPlantIssue ? (
        <>
          <img src={qrImgUrl} alt="QR code to show Store" style={{ width: 160, height: 160, margin: "0 auto 8px" }} />
          <div style={{ fontSize: 11, color: "var(--slate)" }}>Show this to Store to receive it. Disappears once issued.</div>
        </>
      ) : (
        <ShareableSlip request={r} />
      )}
    </div>
  );
}

function ShareableSlip({ request: r }) {
  const slipRef = useRef(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState("");

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
      <div ref={slipRef} style={{ background: "#fff", borderRadius: 8, padding: 14, marginBottom: 8, border: "1px solid #ddd" }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "#111" }}>Our Own Ready Mix — fuel approval</div>
        <div style={{ display: "inline-block", background: "#E1F5EE", color: "#0F6E56", fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999, marginBottom: 8 }}>Approved</div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderTop: "1px solid #eee", color: "#222" }}><span style={{ color: "#777" }}>Station</span><span>{r.approved_station_name}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderTop: "1px solid #eee", color: "#222" }}><span style={{ color: "#777" }}>Vehicle</span><span>{unitLabel(r)}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderTop: "1px solid #eee", color: "#222" }}><span style={{ color: "#777" }}>Driver</span><span>{r.requested_by_name || ""}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderTop: "1px solid #eee", color: "#222" }}><span style={{ color: "#777" }}>Quantity</span><span>{r.approved_quantity} L</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderTop: "1px solid #eee", borderBottom: "1px solid #eee", color: "#222" }}><span style={{ color: "#777" }}>Approved</span><span>{new Date(r.approved_at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span></div>
      </div>
      {shareError && <div style={{ color: "var(--alert-red)", marginBottom: 6 }}>{shareError}</div>}
      <button onClick={share} disabled={sharing} style={{ width: "100%" }}>{sharing ? "Preparing..." : "Share to station"}</button>
    </div>
  );
}

function FuelCostReport() {
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/supply-requests/mine").then(setRequests).catch((err) => setError(err.message));
  }, []);

  return (
    <>
      <TopBar title="Fuel and lubricants" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Fuel and lubricant requests are logged by drivers and machine operators now — no self-service entry here.</div>
        {error && <div style={{ color: "var(--alert-red)", marginTop: 12 }}>{error}</div>}
      </div>
    </>
  );
}
