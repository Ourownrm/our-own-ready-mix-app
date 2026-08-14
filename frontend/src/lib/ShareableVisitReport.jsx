import { useRef, useState } from "react";

const NEW_PROJECT_SUMMARY_FIELDS = [
  ["meeting_outcome", "Outcome"],
  ["decide_when", "Deciding"],
  ["grades", "Grade(s)"],
  ["volume", "Volume"],
  ["first_pour", "First pour"],
  ["quotation_status", "Quotation"],
];
const RUNNING_PROJECT_SUMMARY_FIELDS = [
  ["supply_status", "Supply"],
  ["volume_trend", "Volume trend"],
  ["payment_status", "Payments"],
  ["relationship_health", "Relationship"],
  ["project_timeline", "Timeline"],
];

// Rough sentiment per field value, just for pill coloring — not stored, purely cosmetic.
function pillColor(value) {
  if (!value) return { bg: "#F2EFE9", fg: "#5B6470" };
  const v = String(value).toLowerCase();
  if (["interested", "all good", "strong", "increasing", "submitted", "happy"].some((s) => v.includes(s))) {
    return { bg: "#E4F2EC", fg: "#1D7A55" };
  }
  if (["not ready", "at risk", "overdue", "unhappy", "decreasing", "lost", "serious"].some((s) => v.includes(s))) {
    return { bg: "#FBEAEA", fg: "#B3261E" };
  }
  if (["comparing", "needs", "minor", "not sure", "unsure"].some((s) => v.includes(s))) {
    return { bg: "#F5EDDD", fg: "#9C6B12" };
  }
  return { bg: "#E3EEF4", fg: "#2A6F97" };
}

const VISITOR_LABEL = { customer: "Customer", client: "Client", consultant: "Consultant", site_engineer: "Site engineer", other: "Other" };

export default function ShareableVisitReport({ visit }) {
  const ref = useRef(null);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState("");

  const fields = visit.is_new_project ? NEW_PROJECT_SUMMARY_FIELDS : RUNNING_PROJECT_SUMMARY_FIELDS;
  const answers = visit.answers || {};

  async function share() {
    setSharing(true); setError("");
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(ref.current, { backgroundColor: "#ffffff", scale: 2 });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const file = new File([blob], `visit-report-${visit.id}.png`, { type: "image/png" });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: "Site visit report" });
        } catch {
          // cancelled by the user — not an error
        }
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `visit-report-${visit.id}.png`;
        a.click();
        URL.revokeObjectURL(url);
        window.alert("Sharing images isn't supported on this browser — the report was downloaded instead. Attach it to WhatsApp or email however you'd like to send it.");
      }
    } catch {
      setError("Couldn't create the report image — try again.");
    } finally {
      setSharing(false);
    }
  }

  return (
    <div style={{ textAlign: "left", fontSize: 12 }}>
      <div ref={ref} style={{ position: "relative", background: "#fff", borderRadius: 10, overflow: "hidden", border: "1px solid #E1DFD7", marginBottom: 8 }}>

        <div style={{ background: "#C75B12", padding: "14px 16px", color: "#fff" }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Our Own Ready Mix</div>
          <div style={{ fontSize: 12, opacity: 0.9 }}>Site visit report</div>
        </div>

        <div style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A" }}>{visit.visited_name}</div>
              {visit.site_name && <div style={{ fontSize: 12, color: "#5B6470" }}>{visit.site_name}</div>}
            </div>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 999,
              background: visit.is_new_project ? "#E3EEF4" : "#E4F2EC",
              color: visit.is_new_project ? "#2A6F97" : "#1D7A55",
            }}>
              {visit.is_new_project ? "New project" : "Existing project"}
            </span>
          </div>

          <div style={{ background: "#FAF8F3", borderRadius: 8, padding: "10px 12px", marginBottom: 12 }}>
            <table style={{ width: "100%", fontSize: 12 }}>
              <tbody>
                <tr><td style={{ color: "#5B6470", padding: "3px 0" }}>Date</td><td style={{ textAlign: "right", padding: "3px 0", fontWeight: 600 }}>{new Date(visit.visit_date).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}{visit.visit_time ? ` · ${visit.visit_time.slice(0, 5)}` : ""}</td></tr>
                <tr><td style={{ color: "#5B6470", padding: "3px 0" }}>Met</td><td style={{ textAlign: "right", padding: "3px 0", fontWeight: 600 }}>{visit.contact_person} ({VISITOR_LABEL[visit.visitor_type] || visit.visitor_type})</td></tr>
                {visit.contact_number && <tr><td style={{ color: "#5B6470", padding: "3px 0" }}>Contact</td><td style={{ textAlign: "right", padding: "3px 0", fontWeight: 600 }}>{visit.contact_number}</td></tr>}
                <tr><td style={{ color: "#5B6470", padding: "3px 0" }}>Location</td><td style={{ textAlign: "right", padding: "3px 0", fontWeight: 600 }}>{visit.at_site === false ? "Not at site" : "At site"}</td></tr>
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 11, color: "#8A8578", marginBottom: 6, fontWeight: 700, textTransform: "uppercase" }}>Visit summary</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
            {fields.map(([key, label]) => {
              const val = answers[key];
              if (val === undefined || val === null || val === "") return null;
              const display = Array.isArray(val) ? val.join(", ") : val;
              const c = pillColor(Array.isArray(val) ? val[0] : val);
              return (
                <span key={key} style={{ fontSize: 11, padding: "5px 10px", borderRadius: 8, background: c.bg, color: c.fg }}>
                  <span style={{ opacity: 0.75 }}>{label}: </span><strong>{display}</strong>
                </span>
              );
            })}
          </div>

          {(answers.technical_visit === "Yes" || answers.owners_meeting === "Yes") && (
            <div style={{ background: "#F5EDDD", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
              {answers.technical_visit === "Yes" && <div style={{ fontSize: 12, color: "#9C6B12", fontWeight: 700 }}>⚑ Technical visit requested</div>}
              {answers.owners_meeting === "Yes" && <div style={{ fontSize: 12, color: "#9C6B12", fontWeight: 700 }}>⚑ Owners' meeting requested</div>}
            </div>
          )}

          {visit.discussion_outcome && (
            <div style={{ fontSize: 12, color: "#5B6470", marginBottom: 12, fontStyle: "italic" }}>"{visit.discussion_outcome}"</div>
          )}

          <div style={{ borderTop: "1px solid #E1DFD7", paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 11, color: "#8A8578" }}>
            <span>Ref: SV-{visit.id}</span>
            <span>{visit.visited_by_name || "Sales Executive"}</span>
          </div>
        </div>
      </div>

      {error && <div style={{ color: "#B3261E", marginBottom: 6 }}>{error}</div>}
      <button onClick={share} disabled={sharing} style={{ width: "100%" }}>{sharing ? "Preparing..." : "Share report"}</button>
    </div>
  );
}
