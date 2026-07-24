import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

const EQUIPMENT_TABS = [
  { type: "truck", label: "Truck" },
  { type: "pump", label: "Pump" },
  { type: "pickup_van", label: "Pickup van" },
  { type: "loader", label: "Loader" },
  { type: "generator", label: "Generator" },
];

export default function FuelFilling() {
  const [trucks, setTrucks] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [stations, setStations] = useState([]);
  const [history, setHistory] = useState([]);

  const [equipmentType, setEquipmentType] = useState("truck");
  const [unitId, setUnitId] = useState("");
  const [odometer, setOdometer] = useState("");
  const [hourMeter, setHourMeter] = useState("");
  const [litres, setLitres] = useState("");
  const [cost, setCost] = useState("");
  const [stationId, setStationId] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      const [t, p, e, s, h] = await Promise.all([
        apiRequest("/master/trucks"),
        apiRequest("/master/pumps"),
        apiRequest("/master/equipment"),
        apiRequest("/master/fuel-stations"),
        apiRequest("/fuel/history"),
      ]);
      setTrucks(t); setPumps(p); setEquipment(e); setStations(s); setHistory(h);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

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
    if (!litres) return setError("Enter the fuel quantity.");
    if (!odometer && !hourMeter) return setError("Enter either an odometer reading or an hour meter reading.");

    const body = {
      equipment_type: equipmentType,
      fuel_quantity_litres: litres,
      fuel_cost: cost || null,
      fuel_station_id: stationId || null,
      odometer_reading: odometer || null,
      hour_meter_reading: hourMeter || null,
    };
    if (equipmentType === "truck") body.truck_id = unitId;
    else if (equipmentType === "pump") body.pump_id = unitId;
    else body.equipment_id = unitId;

    setSaving(true);
    try {
      await apiRequest("/fuel", { method: "POST", body });
      setNotice("Fuel entry saved.");
      setUnitId(""); setOdometer(""); setHourMeter(""); setLitres(""); setCost(""); setStationId("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title="Fuel Filling" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Report fuel filling</div>

          <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 6 }}>Equipment type</div>
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
              {unitOptions.length === 0 && (
                <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>
                  None set up yet — Administrator can add these under Fuel stations and equipment.
                </div>
              )}
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

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <div style={{ color: "var(--slate)" }}>Fuel quantity (litres)</div>
                <input type="number" value={litres} onChange={(e) => setLitres(e.target.value)} required />
              </div>
              <div>
                <div style={{ color: "var(--slate)" }}>Cost (₹)</div>
                <input type="number" value={cost} onChange={(e) => setCost(e.target.value)} />
              </div>
            </div>

            <div>
              <div style={{ color: "var(--slate)" }}>Filled from</div>
              <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
                <option value="">Select</option>
                {stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>

            {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
            {notice && <div style={{ color: "var(--signal-green)" }}>{notice}</div>}
            <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save fuel entry"}</button>
          </form>
        </div>

        <FuelHistory history={history} />
      </div>
    </>
  );
}

function equipmentLabel(row) {
  return row.truck_number || row.pump_code || row.equipment_name || "—";
}

function FuelHistory({ history }) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? history : history.slice(0, 10);

  const totals = history.reduce((acc, r) => {
    const key = `${r.equipment_type}:${equipmentLabel(r)}`;
    if (!acc[key]) acc[key] = { label: equipmentLabel(r), litres: 0, cost: 0 };
    acc[key].litres += Number(r.fuel_quantity_litres || 0);
    acc[key].cost += Number(r.fuel_cost || 0);
    return acc;
  }, {});
  const summary = Object.values(totals).sort((a, b) => b.litres - a.litres);

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Fuel by equipment</div>
        {summary.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>No fuel entries yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 13 }}>
              <thead><tr><th>Equipment</th><th>Total litres</th><th>Total cost</th></tr></thead>
              <tbody>
                {summary.map((s) => (
                  <tr key={s.label}>
                    <td>{s.label}</td>
                    <td>{s.litres.toFixed(1)} L</td>
                    <td>{s.cost ? `₹${s.cost.toLocaleString("en-IN")}` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Recent fuel entries</div>
        {rows.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>None yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 13 }}>
              <thead><tr><th>Date</th><th>Equipment</th><th>Litres</th><th>Cost</th><th>Reading</th><th>Station</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.logged_at).toLocaleDateString([], { day: "2-digit", month: "short" })}</td>
                    <td>{equipmentLabel(r)}</td>
                    <td>{r.fuel_quantity_litres} L</td>
                    <td>{r.fuel_cost ? `₹${r.fuel_cost}` : "–"}</td>
                    <td>{r.odometer_reading ? `${r.odometer_reading} km` : r.hour_meter_reading ? `${r.hour_meter_reading} hrs` : "–"}</td>
                    <td>{r.fuel_station_name || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {history.length > 10 && (
          <button style={{ marginTop: 10, width: "100%" }} onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show less" : `Show all ${history.length}`}
          </button>
        )}
      </div>
    </>
  );
}
