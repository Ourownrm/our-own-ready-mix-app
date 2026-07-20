import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

export default function ProductionChart() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest(`/reports/daily-production?days=${days}`).then(setData).catch((err) => setError(err.message));
  }, [days]);

  const max = Math.max(1, ...data.map((d) => d.qty_m3));
  const barWidth = days > 14 ? 14 : 28;
  const gap = days > 14 ? 4 : 8;
  const chartWidth = data.length * (barWidth + gap);
  const chartHeight = 140;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Daily production — last {days} days</div>
        <button style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setDays(days === 7 ? 30 : 7)}>
          {days === 7 ? "View 30 days" : "View 7 days"}
        </button>
      </div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {data.length === 0 && !error ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No production data yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <svg width={Math.max(chartWidth, 280)} height={chartHeight + 30} role="img" aria-label={`Bar chart of daily concrete production over the last ${days} days`}>
            {data.map((d, i) => {
              const barHeight = (d.qty_m3 / max) * chartHeight;
              const x = i * (barWidth + gap);
              const label = new Date(d.day).toLocaleDateString([], { day: "2-digit", month: "short" });
              return (
                <g key={d.day}>
                  <title>{`${label}: ${d.qty_m3} m³`}</title>
                  <rect x={x} y={chartHeight - barHeight} width={barWidth} height={barHeight} rx={3} fill="var(--rebar)" />
                  {days <= 7 && (
                    <text x={x + barWidth / 2} y={chartHeight - barHeight - 4} textAnchor="middle" fontSize="10" fill="var(--charcoal)">
                      {d.qty_m3}
                    </text>
                  )}
                  <text x={x + barWidth / 2} y={chartHeight + 14} textAnchor="middle" fontSize="9" fill="var(--slate)">
                    {label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}
