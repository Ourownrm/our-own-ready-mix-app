import { useEffect, useState } from "react";

// Counts up from `since` (an ISO timestamp) and switches to alert styling once
// past `alertAfterMinutes`. Re-renders every second while mounted.
export default function ElapsedTimer({ since, alertAfterMinutes = 12, label, big = false }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const elapsedMs = now - new Date(since).getTime();
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const isAlert = minutes >= alertAfterMinutes;

  const timeStr = `${minutes}m ${String(seconds).padStart(2, "0")}s`;

  if (big) {
    return (
      <div
        style={{
          textAlign: "center", padding: "14px 10px", borderRadius: 10,
          background: isAlert ? "var(--alert-red-bg, #FBEAEA)" : "var(--amber-bg)",
          border: `2px solid ${isAlert ? "var(--alert-red)" : "var(--amber)"}`,
        }}
      >
        {label && <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{label}</div>}
        <div style={{ fontSize: 32, fontWeight: 700, fontFamily: "monospace", color: isAlert ? "var(--alert-red)" : "var(--amber)" }}>
          {timeStr}
        </div>
        {isAlert && <div style={{ fontSize: 12, color: "var(--alert-red)", fontWeight: 600, marginTop: 4 }}>Past {alertAfterMinutes} min — start batching now</div>}
      </div>
    );
  }

  return (
    <span style={{ fontSize: 12, fontWeight: 600, color: isAlert ? "var(--alert-red)" : "var(--amber)" }}>
      {label ? `${label} — ` : ""}{timeStr}{isAlert ? " (delayed)" : ""}
    </span>
  );
}
