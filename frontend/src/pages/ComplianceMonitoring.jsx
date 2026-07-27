import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

const ASSET_TYPES = [
  ["transit_mixer", "Transit mixer", "vehicle"], ["boom_pump", "Boom pump", "equipment"],
  ["batching_plant", "Batching plant", "equipment"], ["loader", "Loader", "equipment"],
  ["generator", "Generator", "equipment"], ["weighbridge", "Weighbridge", "equipment"],
  ["compressor", "Compressor", "equipment"], ["pickup", "Pickup", "vehicle"],
  ["car", "Car", "vehicle"], ["motor_bike", "Motor bike", "vehicle"], ["other", "Other", "equipment"],
];
const VEHICLE_DOCS = [
  ["insurance", "Insurance"], ["road_tax", "Road tax"], ["permit", "Permit"], ["puc", "PUC"],
  ["fitness_certificate", "Fitness certificate"], ["registration_certificate", "Registration certificate"],
];
const EQUIPMENT_DOCS = [
  ["insurance", "Insurance"], ["amc", "AMC"], ["calibration_certificate", "Calibration certificate"],
  ["inspection_certificate", "Inspection certificate"], ["load_testing_certificate", "Load testing certificate"],
  ["safety_certification", "Safety certification"],
];
const DOC_LABEL = Object.fromEntries([...VEHICLE_DOCS, ...EQUIPMENT_DOCS]);

function statusOf(days) {
  if (days < 0) return { label: "Expired", cls: "badge-danger" };
  if (days <= 7) return { label: "Due in 7 days", cls: "badge-danger" };
  if (days <= 30) return { label: "Due in 30 days", cls: "badge-warning" };
  return { label: "Valid", cls: "badge-success" };
}

export default function ComplianceMonitoring() {
  const [assets, setAssets] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [filter, setFilter] = useState("all"); // all | vehicle | equipment
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showAddAsset, setShowAddAsset] = useState(false);
  const [showAddDoc, setShowAddDoc] = useState(false);

  async function load() {
    try {
      const [a, d] = await Promise.all([apiRequest("/compliance/assets"), apiRequest("/compliance/documents")]);
      setAssets(a); setDocuments(d);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  const rows = filter === "all" ? documents : documents.filter((d) => d.category === filter);
  const counts = {
    expired: documents.filter((d) => d.days_until_expiry < 0).length,
    due7: documents.filter((d) => d.days_until_expiry >= 0 && d.days_until_expiry <= 7).length,
    due30: documents.filter((d) => d.days_until_expiry > 7 && d.days_until_expiry <= 30).length,
    valid: documents.filter((d) => d.days_until_expiry > 30).length,
  };

  return (
    <>
      <TopBar title="Statutory Compliance Monitoring" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 12 }}>{notice}</div>}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginBottom: 16 }}>
          <Kpi label="Expired" value={counts.expired} danger={counts.expired > 0} />
          <Kpi label="Due in 7 days" value={counts.due7} danger={counts.due7 > 0} />
          <Kpi label="Due in 30 days" value={counts.due30} />
          <Kpi label="Valid" value={counts.valid} />
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <button className={`btn-tab ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All assets</button>
          <button className={`btn-tab ${filter === "vehicle" ? "active" : ""}`} onClick={() => setFilter("vehicle")}>Vehicles</button>
          <button className={`btn-tab ${filter === "equipment" ? "active" : ""}`} onClick={() => setFilter("equipment")}>Equipment</button>
          <button onClick={() => setShowAddAsset(!showAddAsset)}>{showAddAsset ? "Hide" : "+ Add asset"}</button>
          <button onClick={() => setShowAddDoc(!showAddDoc)}>{showAddDoc ? "Hide" : "+ Add / renew document"}</button>
        </div>

        {showAddAsset && (
          <AddAssetForm setError={setError} onDone={(msg) => { setNotice(msg); setShowAddAsset(false); load(); }} />
        )}
        {showAddDoc && (
          <AddDocumentForm assets={assets} setError={setError} onDone={(msg) => { setNotice(msg); setShowAddDoc(false); load(); }} />
        )}

        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Compliance register</div>
          {rows.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>No documents tracked yet.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ fontSize: 13 }}>
                <thead>
                  <tr>
                    <th>Asset</th><th>Type</th><th>Document</th><th>Cert. no.</th>
                    <th>Expiry date</th><th>Days</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => {
                    const status = statusOf(d.days_until_expiry);
                    return (
                      <tr key={d.id}>
                        <td>{d.asset_name}</td>
                        <td>{ASSET_TYPES.find((a) => a[0] === d.asset_type)?.[1] || d.asset_type}</td>
                        <td>{DOC_LABEL[d.document_type] || d.document_type}</td>
                        <td>{d.document_number || "–"}</td>
                        <td>{new Date(d.expiry_date).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}</td>
                        <td>{d.days_until_expiry < 0 ? `${Math.abs(d.days_until_expiry)}d overdue` : `${d.days_until_expiry}d left`}</td>
                        <td><span className={`badge ${status.cls}`}>{status.label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Kpi({ label, value, danger }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${danger ? "danger" : ""}`}>{value}</div>
    </div>
  );
}

function AddAssetForm({ setError, onDone }) {
  const [name, setName] = useState("");
  const [assetType, setAssetType] = useState("transit_mixer");
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest("/compliance/assets", { method: "POST", body: { name, asset_type: assetType } });
      setName("");
      onDone("Asset added.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, marginBottom: 16 }}>
      <div><div style={{ color: "var(--slate)" }}>Asset name / registration no.</div><input value={name} onChange={(e) => setName(e.target.value)} required /></div>
      <div>
        <div style={{ color: "var(--slate)" }}>Asset type</div>
        <select value={assetType} onChange={(e) => setAssetType(e.target.value)}>
          {ASSET_TYPES.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
        </select>
      </div>
      <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add asset"}</button></div>
    </form>
  );
}

function AddDocumentForm({ assets, setError, onDone }) {
  const [assetId, setAssetId] = useState("");
  const [docType, setDocType] = useState("");
  const [docNumber, setDocNumber] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedAsset = assets.find((a) => String(a.id) === String(assetId));
  const docOptions = selectedAsset?.category === "vehicle" ? VEHICLE_DOCS : EQUIPMENT_DOCS;

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!docType) return setError("Select which document this is.");
    setSaving(true);
    try {
      await apiRequest("/compliance/documents", {
        method: "POST",
        body: { asset_id: assetId, document_type: docType, document_number: docNumber || null, expiry_date: expiryDate },
      });
      setAssetId(""); setDocType(""); setDocNumber(""); setExpiryDate("");
      onDone("Document saved.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, marginBottom: 16 }}>
      <div>
        <div style={{ color: "var(--slate)" }}>Asset</div>
        <select value={assetId} onChange={(e) => { setAssetId(e.target.value); setDocType(""); }} required>
          <option value="">Select</option>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <div>
        <div style={{ color: "var(--slate)" }}>Document type</div>
        <select value={docType} onChange={(e) => setDocType(e.target.value)} required disabled={!assetId}>
          <option value="">Select</option>
          {docOptions.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
        </select>
      </div>
      <div><div style={{ color: "var(--slate)" }}>Certificate / document no. (optional)</div><input value={docNumber} onChange={(e) => setDocNumber(e.target.value)} /></div>
      <div><div style={{ color: "var(--slate)" }}>Expiry date</div><input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} required /></div>
      <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--slate)" }}>
        If this asset already has this document type on file, saving here renews it (updates the expiry date) rather than creating a duplicate.
      </div>
      <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Save"}</button></div>
    </form>
  );
}
