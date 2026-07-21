import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

function lowStockThreshold(binName) {
  if (binName.startsWith("Silo")) return 15;   // cement, tons
  if (binName.startsWith("Agg")) return 2;     // aggregate, loads
  if (binName.startsWith("Admix")) return 2;   // admixture, barrels
  return null;
}

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
  const lowStockCount = rows.filter((r) => {
    const threshold = lowStockThreshold(r.bin_name);
    return threshold !== null && Number(r.stock_qty) <= threshold;
  }).length;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          Raw material stock
          {lowStockCount > 0 && (
            <span className="badge badge-danger" style={{ marginLeft: 8 }}>
              {lowStockCount} low
            </span>
          )}
        </div>
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
          {rows.map((r) => {
            const threshold = lowStockThreshold(r.bin_name);
            const low = threshold !== null && Number(r.stock_qty) <= threshold;
            return (
              <div
                key={r.id}
                style={{
                  background: low ? "var(--alert-red-bg)" : "var(--concrete)",
                  border: low ? "1px solid var(--alert-red)" : "1px solid transparent",
                  borderRadius: 8, padding: "6px 8px",
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: low ? "var(--alert-red)" : undefined }}>
                  {r.bin_name}
                </div>
                <div style={{ fontSize: 10, color: "var(--slate)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.type_brand || "—"}</div>
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2, color: low ? "var(--alert-red)" : undefined }}>
                  {r.stock_qty} <span style={{ fontSize: 10, color: low ? "var(--alert-red)" : "var(--slate)", fontWeight: 400 }}>{r.unit}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
