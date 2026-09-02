// Round 135 — "Samples Due for Testing" page. Opened from the Lab
// Technician dashboard's due-testing KPI card (see DueTestingCard in
// LabTechnician.jsx), this is the full-detail view that card summarizes:
// every plant pour and site cast with at least one age (7-day/28-day)
// overdue or due today, as one card per sample.
//
// This replaces the old inline due-testing list (a flat one-line-per-age
// row above the tab bar), which — per explicit feedback on the first
// redesign of this panel — had dropped several things the old list/cards
// elsewhere in the app already showed: the sample/cube count, BOTH due
// dates together (not just whichever age triggered the row), the
// poured/cast date, and a quick "Close — not testing" action. All four are
// on every card below. Entering results, changing a recorded result's
// date, deleting a result, deleting a whole site cast, and the "Visible in
// customer module" toggle all still live where they always have — inside
// PourDetail/SiteCastDetail (see CubeTestingTab/SiteCubeTestingTab in
// LabTechnician.jsx, untouched this round) — "Open" below jumps straight
// into that same screen rather than duplicating those controls here.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

const STATUS_LABEL = { done: "Done", overdue: "Overdue", due_today: "Due today", upcoming: "Not yet due" };
const STATUS_COLOR = { done: "badge-success", overdue: "badge-danger", due_today: "badge-warning", upcoming: "badge-neutral" };

export default function LabDueToday() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function load() {
    apiRequest("/lab-technician/due-testing").then(setRows).catch((err) => setError(err.message));
  }
  useEffect(() => { load(); }, []);

  // Same close flow as CubeTestingTab's own "Close — not testing" button
  // (LabTechnician.jsx) — same prompt text, same endpoint — just reachable
  // straight from this card instead of only after opening the pour.
  async function closeSample(orderId) {
    const reason = window.prompt("Why is this pour not being tested? (optional — leave blank if you'd rather not say)");
    if (reason === null) return;
    setError(""); setNotice("");
    try {
      await apiRequest(`/lab-technician/cube-pours/${orderId}/close`, { method: "POST", body: { reason } });
      setNotice("Pour closed — moved to the Closed list.");
      load();
    } catch (err) { setError(err.message); }
  }

  function openSample(r) {
    navigate(r.source === "plant" ? `/lab-technician?focusOrder=${r.ref_id}` : `/lab-technician?focusCast=${r.ref_id}`);
  }

  if (rows === null) {
    return (
      <>
        <TopBar title="Samples Due for Testing" />
        <div style={{ maxWidth: 1040, margin: "0 auto", padding: "16px" }}>Loading...</div>
      </>
    );
  }

  const overdueCount = rows.filter((r) => r.row_status === "overdue").length;
  const dueTodayCount = rows.length - overdueCount;

  return (
    <>
      <TopBar title="Samples Due for Testing" />
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ fontSize: 13, color: "var(--slate)", marginBottom: 16 }}>
          {overdueCount > 0 && <b style={{ color: "var(--alert-red)" }}>{overdueCount} overdue</b>}
          {overdueCount > 0 && dueTodayCount > 0 && " · "}
          {dueTodayCount > 0 && <span>{dueTodayCount} due today</span>}
          {rows.length > 0 && " · "}
          plant pours and site casts together
        </div>

        {error && <div style={{ color: "var(--alert-red)", marginBottom: 12 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", marginBottom: 12 }}>{notice}</div>}

        {rows.length === 0 && (
          <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Nothing due for testing right now.</div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
          {rows.map((r) => (
            <div
              key={`${r.source}-${r.ref_id}`}
              className="card"
              style={{ borderLeft: `3px solid ${r.row_status === "overdue" ? "var(--alert-red)" : "var(--amber)"}` }}
            >
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                <span className={`badge ${r.row_status === "overdue" ? "badge-danger" : "badge-warning"}`}>
                  {r.row_status === "overdue" ? "Overdue" : "Due today"}
                </span>
                <span className={`badge ${r.source === "site" ? "badge-violet" : "badge-info"}`}>
                  {r.source === "site" ? "Site" : "Plant"}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--slate)" }}>
                  {r.total_cubes ?? "?"} cube{Number(r.total_cubes) === 1 ? "" : "s"}
                </span>
              </div>

              <div style={{ fontWeight: 700, fontSize: 14.5 }}>{r.customer_name}</div>
              <div style={{ fontSize: 12.5, color: "var(--slate)" }}>{r.site_name}</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>
                {r.mix_grade_name} · {r.source === "site" ? "Cast" : "Poured"} {fmtDate(r.sample_date)}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 9, paddingTop: 9, borderTop: "1px solid var(--concrete)", fontSize: 12 }}>
                <div>
                  <span className={`badge ${STATUS_COLOR[r.status_7day] || "badge-neutral"}`}>7-day: {STATUS_LABEL[r.status_7day] || r.status_7day}</span>
                  {r.status_7day !== "done" && <span style={{ color: "var(--slate)", marginLeft: 6 }}>{fmtDate(r.due_7day)}</span>}
                </div>
                <div>
                  <span className={`badge ${STATUS_COLOR[r.status_28day] || "badge-neutral"}`}>28-day: {STATUS_LABEL[r.status_28day] || r.status_28day}</span>
                  {r.status_28day !== "done" && <span style={{ color: "var(--slate)", marginLeft: 6 }}>{fmtDate(r.due_28day)}</span>}
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button type="button" style={{ flex: 1 }} onClick={() => openSample(r)}>
                  {r.source === "site" ? "Open cast" : "Open pour"}
                </button>
                {r.can_close && (
                  <button type="button" onClick={() => closeSample(r.ref_id)}>Close — not testing</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
