import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { generateTruckInspectionPdf } from "../lib/truckInspectionPdf.js";

// Round 98 — items 10 (Maintenance module) & 11 (Best Driver of the Month),
// built from the round-97 mockup the business approved. Reuses that
// mockup's exact layout/classes (kanban, meter, stacked-bar, timeline —
// see index.css) now wired to real data instead of sample rows.

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString([], { day: "2-digit", month: "short" });
}

export default function Maintenance() {
  // Round 216 — the Maintenance and Repair Action Points tabs moved into the
  // Maintenance module (/maintenance-module); this page keeps Best Driver and
  // Site Efficiency, which stay outside it.
  const [tab, setTab] = useState("driver"); // 'driver' | 'site_efficiency'
  const [error, setError] = useState("");

  return (
    <>
      <TopBar title="Best Driver & Site Efficiency" />
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: "0 16px 40px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: "flex", gap: 6, marginBottom: 18, borderBottom: "1px solid var(--border-strong)", flexWrap: "wrap" }}>

          {/* Round 136 — Repair Action Points: scheduled repairs against a
              specific vehicle/equipment, distinct from the Maintenance
              module's preventive schedule above and from the reactive
              External Repair flow inside it. Its own tab rather than a
              section of "Maintenance module" since it has its own
              add/edit/status lifecycle. */}

          <button
            className={`btn-tab ${tab === "driver" ? "active" : ""}`}
            style={{ borderRadius: "8px 8px 0 0", borderBottom: "none" }}
            onClick={() => setTab("driver")}
          >
            Best Driver of the Month
          </button>
          <button
            className={`btn-tab ${tab === "site_efficiency" ? "active" : ""}`}
            style={{ borderRadius: "8px 8px 0 0", borderBottom: "none" }}
            onClick={() => setTab("site_efficiency")}
          >
            Site Efficiency
          </button>
        </div>

        <div className="card" style={{ marginBottom: 16, fontSize: 13 }}>
          Preventive maintenance, repairs, outside repairs and the service history are now in the{" "}
          <Link to="/maintenance-module">Maintenance module</Link>. The weekly truck inspection below still feeds Best Driver; its
          “Action required” items go onto the truck’s job card there.
        </div>
        {tab === "driver" && <BestDriverTab setError={setError} />}
        {tab === "site_efficiency" && <SiteEfficiencyTab setError={setError} />}
      </div>
    </>
  );
}

// ===================== BEST DRIVER TAB =====================

const COMPONENT_COLORS = {
  checklist: "var(--rebar)",
  on_time: "var(--violet)",
  quality: "var(--signal-green)",
  volume: "var(--amber)",
  fuel: "var(--info)",
};

function BestDriverTab({ setError }) {
  const [data, setData] = useState(null);
  const [showForm, setShowForm] = useState(false);

  async function load() {
    try { setData(await apiRequest("/maintenance/best-driver")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  if (!data) return <div className="card">Loading…</div>;
  const winner = data.ranked[0];
  const w = data.weights;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>
            {new Date(data.year, data.month - 1, 1).toLocaleDateString([], { month: "long", year: "numeric" })} — Best Driver of the Month
          </h2>
          <p style={{ fontSize: 12.5, color: "var(--slate)", margin: "0 0 14px", maxWidth: 640, lineHeight: 1.5 }}>
            Composite of the weekly Transit Mixer inspection checklist, transit efficiency, load-quality, completed-trip volume,
            and fuel economy. No minimum trip count — every driver is eligible regardless of volume.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm(true)}>+ New weekly inspection</button>
      </div>

      {showForm && <InspectionForm setError={setError} onCancel={() => setShowForm(false)} onDone={() => { setShowForm(false); load(); }} />}

      {winner ? (
        <div className="spotlight" style={{ marginBottom: 18 }}>
          <div className="spotlight-badge">🏆</div>
          <div>
            <div className="spotlight-name">{winner.driver_name}</div>
            <div className="spotlight-sub">{winner.trip_count} trip{winner.trip_count === 1 ? "" : "s"} this month</div>
          </div>
          <div className="spotlight-score">
            <div className="num">{winner.composite_score}</div>
            <div className="lbl">Composite score</div>
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 18, color: "var(--slate)", fontSize: 13 }}>
          No driver has both a completed trip and a weekly checklist logged yet this month.
        </div>
      )}

      <div className="open-q" style={{ marginBottom: 18 }}>
        <b>Weighting (confirmed round 99, fuel added round 137):</b> Checklist {Math.round(w.checklist * 100)}% ·
        Transit efficiency {Math.round(w.on_time * 100)}% · Quality {Math.round(w.quality * 100)}% · Volume {Math.round(w.volume * 100)}% ·
        Fuel economy {Math.round(w.fuel * 100)}%.
        Transit efficiency scores only the two legs that are actually on the driver — plant-out → site-in, and site-out → plant-in —
        compared against other drivers who visited the <i>same site</i> that month. Time spent waiting/pouring at site is excluded, since
        that depends on site conditions, not the driver. See the <b>Site Efficiency</b> tab for the per-site breakdown behind this score.
        Fuel economy compares each driver's fuel use per m³ delivered (the truck(s) they drove that month, weighted by trip volume)
        against the fleet average — see the <b>360° Fuel Analysis</b> report for the underlying figures.
      </div>

      {data.ranked.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>Leaderboard</h2>
          <div className="legend">
            <span className="legend-item"><span className="legend-swatch" style={{ background: COMPONENT_COLORS.checklist }}></span>Checklist ({Math.round(w.checklist * 100)}%)</span>
            <span className="legend-item"><span className="legend-swatch" style={{ background: COMPONENT_COLORS.on_time }}></span>Transit efficiency ({Math.round(w.on_time * 100)}%)</span>
            <span className="legend-item"><span className="legend-swatch" style={{ background: COMPONENT_COLORS.quality }}></span>Quality ({Math.round(w.quality * 100)}%)</span>
            <span className="legend-item"><span className="legend-swatch" style={{ background: COMPONENT_COLORS.volume }}></span>Volume ({Math.round(w.volume * 100)}%)</span>
            <span className="legend-item"><span className="legend-swatch" style={{ background: COMPONENT_COLORS.fuel }}></span>Fuel economy ({Math.round(w.fuel * 100)}%)</span>
          </div>
          <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 18 }}>
            <table>
              <thead>
                <tr><th></th><th>Driver</th><th>Composite</th><th style={{ width: 200 }}>Breakdown</th><th>Checklist</th><th>Transit eff.</th><th>Quality</th><th>Volume</th><th>Fuel</th></tr>
              </thead>
              <tbody>
                {data.ranked.map((d, i) => (
                  <tr key={d.driver_id}>
                    <td style={{ fontWeight: 700, color: i === 0 ? "var(--rebar)" : "var(--slate)" }}>{i + 1}</td>
                    <td style={{ fontWeight: i === 0 ? 600 : 400 }}>{d.driver_name}</td>
                    <td style={{ fontWeight: 700, fontSize: 14 }}>{d.composite_score}</td>
                    <td>
                      <div className="stack-bar">
                        <div className="stack-seg" style={{ background: COMPONENT_COLORS.checklist, width: `${w.checklist * 100}%` }}></div>
                        {d.on_time_score != null && <div className="stack-seg" style={{ background: COMPONENT_COLORS.on_time, width: `${w.on_time * 100}%` }}></div>}
                        <div className="stack-seg" style={{ background: COMPONENT_COLORS.quality, width: `${w.quality * 100}%` }}></div>
                        <div className="stack-seg" style={{ background: COMPONENT_COLORS.volume, width: `${w.volume * 100}%` }}></div>
                        {d.fuel_score != null && <div className="stack-seg" style={{ background: COMPONENT_COLORS.fuel, width: `${w.fuel * 100}%` }}></div>}
                      </div>
                    </td>
                    <td>{d.checklist_score}</td>
                    <td>{d.on_time_score ?? "—"}</td>
                    <td>{d.quality_score}</td>
                    <td>{d.volume_score}</td>
                    <td title={d.fuel_litres_per_m3 != null ? `${d.fuel_litres_per_m3} L/m³` : undefined}>{d.fuel_score ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {data.unranked.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Not yet ranked this month</div>
          {data.unranked.map((d) => (
            <div key={d.driver_id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "4px 0", borderTop: "1px solid var(--concrete)" }}>
              <span>{d.driver_name}</span>
              <span style={{ color: "var(--slate)" }}>{d.reason}</span>
            </div>
          ))}
        </div>
      )}

      <InspectionActionItemsPanel setError={setError} />
      <PastInspectionsPanel setError={setError} />
    </div>
  );
}

// Round 133 — the weekly checklist itself had no way to be looked back at
// or printed after saving (only the "+ New weekly inspection" form and the
// leaderboard existed) — a Plant In-Charge who fills these out on paper
// today needs a printable copy for their own records/signature, matching
// the business's own TM_Check_list_for_Plant_Incharge.pdf template. Reuses
// the existing GET /maintenance/inspections list (already returns each
// row's full ratings + observations, so no separate detail fetch is
// needed) and GET /maintenance/checklist-definition (already fetched by
// InspectionForm above, for the section/item/scale structure the PDF
// needs to make sense of a row's raw ratings object).
function PastInspectionsPanel({ setError }) {
  const [rows, setRows] = useState(null);
  const [def, setDef] = useState(null);
  const [printing, setPrinting] = useState(null);

  useEffect(() => {
    Promise.all([
      apiRequest("/maintenance/inspections"),
      apiRequest("/maintenance/checklist-definition"),
    ]).then(([r, d]) => { setRows(r); setDef(d); }).catch((err) => setError(err.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function printRow(row) {
    setPrinting(row.id);
    try {
      await generateTruckInspectionPdf(row, def);
    } catch (err) {
      setError(err.message);
    } finally {
      setPrinting(null);
    }
  }

  if (rows === null) return null;

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Past weekly inspections</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No weekly inspections logged yet.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Date</th><th>Vehicle</th><th>Driver</th><th>Cleaner</th><th>Checklist score</th><th>Filled by</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.inspection_date)}</td>
                <td>{r.truck_number}</td>
                <td>{r.driver_name || "—"}</td>
                <td>{r.cleaner_name || "—"}</td>
                <td>{r.checklist_score ?? "—"}</td>
                <td>{r.filled_by_name}</td>
                <td>
                  <button type="button" style={{ fontSize: 11, padding: "3px 8px" }} disabled={!def || printing === r.id} onClick={() => printRow(r)}>
                    {printing === r.id ? "..." : "Print"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Round 101, item 2 — "Action required" remarks against individual checklist
// items on the weekly inspection, tracked here as open maintenance action
// items until Manager marks them resolved.
function InspectionActionItemsPanel({ setError }) {
  const [items, setItems] = useState([]);
  const [showResolved, setShowResolved] = useState(false);
  const [resolvingId, setResolvingId] = useState(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function load(status) {
    try { setItems(await apiRequest(`/maintenance/action-items?status=${status}`)); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(showResolved ? "resolved" : "open"); }, [showResolved]);

  async function resolve(id) {
    setSaving(true); setError("");
    try {
      await apiRequest(`/maintenance/action-items/${id}/resolve`, { method: "PATCH", body: { resolution_notes: notes || undefined } });
      setResolvingId(null); setNotes("");
      load(showResolved ? "resolved" : "open");
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Action items from weekly inspections</div>
        <button style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => setShowResolved(!showResolved)}>
          {showResolved ? "Show open" : "Show resolved"}
        </button>
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>
          {showResolved ? "No resolved action items yet." : "No open action items — nothing flagged on recent checklists."}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ fontSize: 12.5 }}>
            <thead>
              <tr><th>Vehicle</th><th>Inspection date</th><th>Item</th><th>Remark</th><th>Raised by</th>{showResolved ? <><th>Resolved by</th><th>Notes</th></> : <th></th>}</tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>{it.truck_number}</td>
                  <td>{fmtDate(it.inspection_date)}</td>
                  <td>{it.item_label}</td>
                  <td>{it.remark}</td>
                  <td>{it.raised_by_name}</td>
                  {showResolved ? (
                    <>
                      <td>{it.resolved_by_name}</td>
                      <td>{it.resolution_notes || "–"}</td>
                    </>
                  ) : resolvingId === it.id ? (
                    <td style={{ display: "flex", gap: 4 }}>
                      <input placeholder="Resolution notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ fontSize: 11, width: 140 }} />
                      <button onClick={() => resolve(it.id)} disabled={saving}>Save</button>
                      <button onClick={() => { setResolvingId(null); setNotes(""); }}>Cancel</button>
                    </td>
                  ) : (
                    <td><button style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setResolvingId(it.id)}>Resolve</button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ===================== SITE EFFICIENCY TAB (round 99) =====================
// Per-site breakdown behind the Best Driver "Transit efficiency" component —
// business asked to be able to see, for a given site, how each driver's
// plant-out/site-in and site-out/plant-in times compare, since travel time
// depends heavily on which site a driver was sent to.

function fmtMin(m) {
  if (m == null) return "—";
  const h = Math.floor(m / 60), mm = Math.round(m % 60);
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}

function SiteEfficiencyTab({ setError }) {
  const [data, setData] = useState(null);

  async function load() {
    try { setData(await apiRequest("/maintenance/site-efficiency")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  if (!data) return <div className="card">Loading…</div>;

  return (
    <div>
      <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>
        {new Date(data.year, data.month - 1, 1).toLocaleDateString([], { month: "long", year: "numeric" })} — Site Efficiency
      </h2>
      <p style={{ fontSize: 12.5, color: "var(--slate)", margin: "0 0 14px", maxWidth: 680, lineHeight: 1.5 }}>
        For each site, average time each driver took on the plant-out → site-in and site-out → plant-in legs only
        (site dwell time excluded — that's site conditions, not the driver). "vs site avg" is positive when a driver
        is faster than the average of everyone who delivered to that site this month. A site needs at least two
        trips (from any drivers) this month before a comparison is shown.
      </p>

      {data.sites.length === 0 ? (
        <div className="card" style={{ color: "var(--slate)", fontSize: 13 }}>No comparable transit data yet this month.</div>
      ) : (
        data.sites.map((site) => (
          <div key={site.site_id} className="card" style={{ marginBottom: 14, padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{site.site_name}</div>
              <div style={{ fontSize: 12, color: "var(--slate)" }}>{site.trip_count} trip{site.trip_count === 1 ? "" : "s"} · site avg {fmtMin(site.site_avg_total_min)}</div>
            </div>
            <table>
              <thead>
                <tr><th></th><th>Driver</th><th>Trips</th><th>Avg out (plant→site)</th><th>Avg return (site→plant)</th><th>Avg total</th><th>vs site avg</th></tr>
              </thead>
              <tbody>
                {site.drivers.map((d, i) => (
                  <tr key={d.driver_id}>
                    <td style={{ fontWeight: 700, color: i === 0 ? "var(--signal-green)" : "var(--slate)" }}>{i + 1}</td>
                    <td style={{ fontWeight: i === 0 ? 600 : 400 }}>{d.driver_name}</td>
                    <td>{d.trip_count}</td>
                    <td>{fmtMin(d.avg_out_min)}</td>
                    <td>{fmtMin(d.avg_return_min)}</td>
                    <td style={{ fontWeight: 600 }}>{fmtMin(d.avg_total_min)}</td>
                    <td>
                      {d.vs_site_avg_pct == null ? (
                        <span style={{ color: "var(--slate)" }}>—</span>
                      ) : (
                        <span className={`badge ${d.vs_site_avg_pct >= 0 ? "badge-success" : "badge-danger"}`}>
                          {d.vs_site_avg_pct >= 0 ? "+" : ""}{d.vs_site_avg_pct}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  );
}

function InspectionForm({ setError, onCancel, onDone }) {
  const [def, setDef] = useState(null);
  const [trucks, setTrucks] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [truckId, setTruckId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [cleanerName, setCleanerName] = useState("");
  const [inspectionDate, setInspectionDate] = useState("");
  // Round 134, item 3
  const [odometerReading, setOdometerReading] = useState("");
  const [hourMeterReading, setHourMeterReading] = useState("");
  const [ratings, setRatings] = useState({});
  const [actionRequired, setActionRequired] = useState({}); // item_key -> remark text
  const [observations, setObservations] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      apiRequest("/maintenance/checklist-definition"),
      apiRequest("/master/trucks"),
      apiRequest("/master/drivers"),
    ]).then(([d, t, dr]) => { setDef(d); setTrucks(t); setDrivers(dr); }).catch((err) => setError(err.message));
  }, []);

  function setRating(itemKey, value) {
    setRatings((r) => ({ ...r, [itemKey]: value }));
  }

  function setActionRemark(itemKey, value) {
    setActionRequired((a) => ({ ...a, [itemKey]: value }));
  }

  const totalItems = def ? def.sections.reduce((s, sec) => s + sec.items.length, 0) : 0;
  const scoredItems = Object.keys(ratings).length;

  async function submit(e) {
    e.preventDefault();
    if (!truckId) return setError("Select a vehicle.");
    if (scoredItems < totalItems) return setError(`${totalItems - scoredItems} checklist item(s) still need a rating.`);
    setSaving(true); setError("");
    try {
      const itemLabels = {};
      def.sections.forEach((sec) => sec.items.forEach((item) => { itemLabels[item.key] = item.label; }));
      const action_items = Object.entries(actionRequired)
        .filter(([, remark]) => remark && remark.trim())
        .map(([item_key, remark]) => ({ item_key, item_label: itemLabels[item_key] || item_key, remark: remark.trim() }));
      await apiRequest("/maintenance/inspections", {
        method: "POST",
        body: {
          truck_id: truckId, driver_id: driverId || undefined, cleaner_name: cleanerName || undefined,
          inspection_date: inspectionDate || undefined, odometer_reading: odometerReading || undefined,
          hour_meter_reading: hourMeterReading || undefined, ratings, observations, action_items,
        },
      });
      onDone();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  if (!def) return <div className="card" style={{ marginBottom: 18 }}>Loading checklist…</div>;

  return (
    <form onSubmit={submit} className="card" style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Transit Mixer Weekly Inspection Checklist</div>
        <div style={{ fontSize: 12, color: "var(--slate)" }}>{scoredItems}/{totalItems} scored</div>
      </div>

      <div className="field-input" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 10, marginBottom: 16, fontSize: 13 }}>
        <div>
          <div style={{ color: "var(--slate)" }}>Vehicle No.</div>
          <select value={truckId} onChange={(e) => setTruckId(e.target.value)} required>
            <option value="">Select</option>
            {trucks.map((t) => <option key={t.id} value={t.id}>{t.truck_number}</option>)}
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Driver Name</div>
          <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">Select</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Cleaner Name</div>
          <input value={cleanerName} onChange={(e) => setCleanerName(e.target.value)} />
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Date</div>
          <input type="date" value={inspectionDate} onChange={(e) => setInspectionDate(e.target.value)} />
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Odometer reading</div>
          <input type="number" value={odometerReading} onChange={(e) => setOdometerReading(e.target.value)} placeholder="45210" />
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Hour meter reading</div>
          <input type="number" value={hourMeterReading} onChange={(e) => setHourMeterReading(e.target.value)} placeholder="1287" />
        </div>
      </div>

      {def.sections.map((sec) => {
        // Round 133 — Safety & Documentation's items each carry their own
        // scale (Available/Not Available, Working/Not Working, Yes/No —
        // see inspectionChecklist.js) instead of every item in the section
        // sharing the same Poor..Very Good columns, so the response options
        // are rendered per-row rather than as shared table-header columns
        // (a section can mix item.scale with the default def.rating_scale).
        return (
        <div key={sec.key} style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6, color: "var(--charcoal)" }}>{sec.title}</div>
          <table>
            <thead>
              <tr>
                <th>Inspection item</th>
                <th>Response</th>
                <th>Action required</th>
              </tr>
            </thead>
            <tbody>
              {sec.items.map((item) => {
                const scale = item.scale || def.rating_scale;
                return (
                <tr key={item.key}>
                  <td>{item.label}</td>
                  <td>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                      {scale.map((r) => (
                        <label key={r.value} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12.5, cursor: "pointer" }}>
                          <input
                            type="radio"
                            name={item.key}
                            checked={ratings[item.key] === r.value}
                            onChange={() => setRating(item.key, r.value)}
                          />
                          {r.label}
                        </label>
                      ))}
                    </div>
                  </td>
                  <td>
                    <input
                      type="text"
                      placeholder="Remark, if action is needed"
                      value={actionRequired[item.key] || ""}
                      onChange={(e) => setActionRemark(item.key, e.target.value)}
                      style={{ width: "100%", fontSize: 12 }}
                    />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        );
      })}

      <div className="field-input" style={{ marginBottom: 14 }}>
        <div style={{ color: "var(--slate)", fontSize: 13 }}>Observations / Corrective action required</div>
        <textarea rows={3} value={observations} onChange={(e) => setObservations(e.target.value)} />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save inspection"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
