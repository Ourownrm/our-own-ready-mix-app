import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

export default function RawMaterialStockCard() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/master/raw-material-stock").then(setRows).catch((err) => setError(err.message));
  }, []);

  const lastUpdated = rows.reduce((latest, r) => {
    if (!r.updated_at) return latest;
    return !latest || new Date(r.updated_at) > new Date(latest) ? r.updated_at : latest;
  }, null);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Raw material stock</div>
        {lastUpdated && (
          <div style={{ fontSize: 11, color: "var(--slate)" }}>
            Updated {new Date(lastUpdated).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
          </div>
        )}
      </div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {rows.length === 0 && !error ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Not entered yet.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))", gap: 6 }}>
          {rows.map((r) => (
            <div key={r.id} style={{ background: "var(--concrete)", borderRadius: 8, padding: "6px 8px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.bin_name}</div>
              <div style={{ fontSize: 10, color: "var(--slate)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.type_brand || "—"}</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>
                {r.stock_qty} <span style={{ fontSize: 10, color: "var(--slate)", fontWeight: 400 }}>{r.unit}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
