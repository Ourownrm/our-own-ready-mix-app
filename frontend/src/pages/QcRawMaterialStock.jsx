import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

export default function QcRawMaterialStock() {
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      setRows(await apiRequest("/master/raw-material-stock"));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  function update(id, field, value) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  async function save() {
    // A shared PIN keeps this from being editable by just anyone who has the
    // QC screen open on a shared device — only whoever knows the PIN can
    // actually save a change. If the server hasn't had a PIN configured yet,
    // this still saves (nothing to protect against), same as before.
    const pin = window.prompt("Enter PIN to save stock levels:");
    if (pin === null) return; // cancelled

    setSaving(true); setError(""); setNotice("");
    try {
      const updated = await apiRequest("/qc-engineer/raw-material-stock", {
        method: "PUT",
        body: { pin, rows: rows.map((r) => ({ id: r.id, type_brand: r.type_brand, stock_qty: r.stock_qty })) },
      });
      setRows(updated);
      setNotice("Stock levels saved.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const lastUpdated = rows.reduce((latest, r) => {
    if (!r.updated_at) return latest;
    return !latest || new Date(r.updated_at) > new Date(latest) ? r.updated_at : latest;
  }, null);

  return (
    <>
      <TopBar title="QC Engineer · Raw Material Stock" />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontWeight: 600 }}>Raw material stock</div>
          </div>
          {lastUpdated && (
            <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>
              Last updated {new Date(lastUpdated).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
              {rows.find((r) => r.updated_at === lastUpdated)?.updated_by_name ? ` by ${rows.find((r) => r.updated_at === lastUpdated).updated_by_name}` : ""}
            </div>
          )}
          {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
          {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 8 }}>{notice}</div>}
          <table style={{ fontSize: 13 }}>
            <thead>
              <tr><th>Bin</th><th>Type / brand</th><th>Stock qty</th><th>Unit</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.bin_name}</td>
                  <td><input type="text" value={r.type_brand || ""} onChange={(e) => update(r.id, "type_brand", e.target.value)} style={{ width: "100%" }} /></td>
                  <td><input type="number" value={r.stock_qty ?? ""} onChange={(e) => update(r.id, "stock_qty", e.target.value)} style={{ width: 80 }} /></td>
                  <td style={{ color: "var(--slate)" }}>{r.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button style={{ marginTop: 12, width: "100%" }} onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save stock levels"}
          </button>
        </div>
      </div>
    </>
  );
}
