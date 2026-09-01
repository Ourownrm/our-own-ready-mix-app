// Round 131, item 5 — Manager dashboard summary of fuel/lubricant stock,
// same visual pattern as RawMaterialStockCard.jsx alongside it.
import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

export default function StoreStockCard() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/store-stock/items").then(setRows).catch((err) => setError(err.message));
  }, []);

  const lowStockCount = rows.filter((r) => r.reorder_level != null && Number(r.current_qty) <= Number(r.reorder_level)).length;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          Fuel &amp; lubricant stock
          {lowStockCount > 0 && (
            <span className="badge badge-danger" style={{ marginLeft: 8 }}>
              {lowStockCount} low
            </span>
          )}
        </div>
      </div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {rows.length === 0 && !error ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Not set up yet.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))", gap: 6 }}>
          {rows.map((r) => {
            const low = r.reorder_level != null && Number(r.current_qty) <= Number(r.reorder_level);
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
                  {r.display_name}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2, color: low ? "var(--alert-red)" : undefined }}>
                  {Number(r.current_qty).toFixed(1)} <span style={{ fontSize: 10, color: low ? "var(--alert-red)" : "var(--slate)", fontWeight: 400 }}>{r.unit}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
