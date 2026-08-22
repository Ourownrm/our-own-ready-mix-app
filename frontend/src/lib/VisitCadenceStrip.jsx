// Round 115 — a reusable day-strip for "did they visit anyone today", shared
// between the Sales Executive's own Visits tab (their own trailing 7 days)
// and the Sales Performance page's cross-rep cadence report (one strip per
// rep). Days the rep was on duty with zero visits logged are flagged red —
// a day off is a day off, not a missed visit, so only on-duty zero-visit
// days get flagged.
export default function VisitCadenceStrip({ days }) {
  if (!days || days.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {days.map((d) => {
        const dateObj = new Date(d.date);
        const isFuture = dateObj > new Date();
        const flagged = !isFuture && d.on_duty && d.visits === 0;
        return (
          <div
            key={d.date}
            style={{
              flex: 1, minWidth: 70, textAlign: "center", borderRadius: 8, padding: "8px 4px", fontSize: 11,
              border: "1px solid var(--border)",
              background: isFuture ? "#F5F3EE" : flagged ? "var(--alert-red-bg)" : d.on_duty ? "var(--signal-green-bg)" : "var(--concrete)",
              borderColor: isFuture ? "var(--border)" : flagged ? "var(--alert-red)" : d.on_duty ? "var(--signal-green)" : "var(--border)",
              opacity: isFuture ? 0.6 : 1,
            }}
          >
            <div style={{ color: "var(--slate)", fontSize: 10, textTransform: "uppercase" }}>
              {dateObj.toLocaleDateString([], { weekday: "short", day: "2-digit" })}
            </div>
            <div style={{ fontWeight: 700, fontSize: 15, marginTop: 2, color: isFuture ? "var(--slate)" : flagged ? "var(--alert-red)" : d.on_duty ? "var(--signal-green)" : "var(--charcoal)" }}>
              {isFuture ? "—" : d.visits}
            </div>
          </div>
        );
      })}
    </div>
  );
}
