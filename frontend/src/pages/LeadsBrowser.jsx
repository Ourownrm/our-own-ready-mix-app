import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.jsx";

const LEAD_STATUS_BADGE = {
  new: "badge-neutral", contacted: "badge-info", quoted: "badge-progress",
  won: "badge-success", lost: "badge-danger",
};
const ACTIVITY_LABEL = {
  note: "Note", quotation_issued: "Quotation issued", quotation_followup: "Quotation follow-up",
  quotation_revised: "Quotation revised", meeting: "Meeting", site_visit: "Site visit",
};

// Round 119, post-ship again, item 7 — "type of enquiry" (quote request vs.
// free technical assistance) has no column of its own; publicInquiry.js
// already tags a technical-assistance lead's notes with this exact prefix
// at submission time, so it's derived here rather than adding a new column
// for something already distinguishable.
function enquiryType(l) {
  return l.notes?.startsWith("[Free Technical Assistance") ? "Technical assistance" : "Request for quote";
}

export default function LeadsBrowser() {
  const { user } = useAuth();
  const [leads, setLeads] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    try {
      setLeads(await apiRequest("/sales/leads"));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  if (selectedId) {
    return (
      <LeadDetailAdmin
        leadId={selectedId}
        canMarkWon={user?.role === "administrator"}
        onBack={() => { setSelectedId(null); load(); }}
      />
    );
  }

  return (
    <>
      <TopBar title="Leads" />
      <div style={{ maxWidth: 700, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>All leads</div>
          {leads.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>No leads yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {leads.map((l) => (
                <div key={l.id} onClick={() => setSelectedId(l.id)} style={{ cursor: "pointer", background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 13 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: 600 }}>
                      {l.prospect_name}
                      {l.source === "public_inquiry" && (
                        <>
                          <span className="badge badge-info" style={{ marginLeft: 6, fontSize: 10 }}>Public inquiry</span>
                          <span className="badge badge-neutral" style={{ marginLeft: 4, fontSize: 10 }}>{enquiryType(l)}</span>
                        </>
                      )}
                    </span>
                    <span className={`badge ${LEAD_STATUS_BADGE[l.status]}`}>{l.status}</span>
                  </div>
                  <div style={{ color: "var(--slate)" }}>
                    Assigned to {l.assigned_to_name || "— unassigned"} {l.quotation_issued ? `· Quoted ₹${l.latest_quotation_amount ?? ""}` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function LeadDetailAdmin({ leadId, canMarkWon, onBack }) {
  const [lead, setLead] = useState(null);
  const [error, setError] = useState("");
  const [attribution, setAttribution] = useState("salesperson");
  const [saving, setSaving] = useState(false);
  const [executives, setExecutives] = useState([]);
  const [assignTo, setAssignTo] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [closing, setClosing] = useState(false);

  async function load() {
    try {
      setLead(await apiRequest(`/sales/leads/${leadId}`));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, [leadId]);
  useEffect(() => {
    apiRequest("/sales/executives").then(setExecutives).catch(() => {});
  }, []);

  async function assign() {
    if (!assignTo) return;
    setAssigning(true); setError("");
    try {
      await apiRequest(`/sales/leads/${leadId}/assign`, { method: "PATCH", body: { assigned_to: assignTo } });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setAssigning(false);
    }
  }

  async function markWon() {
    setSaving(true); setError("");
    try {
      await apiRequest(`/sales/leads/${leadId}/won`, { method: "POST", body: { attribution } });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // Round 119, post-ship again, item 7 — "how do I close this lead?" This
  // was the missing action: the only options were assign and (Administrator
  // only) mark won. Reuses the existing POST /sales/leads/:id/lost, which
  // already allows sales_executive/manager/administrator — same role gate
  // this whole page already assumes.
  async function closeLead() {
    if (!closeReason.trim()) return;
    setClosing(true); setError("");
    try {
      await apiRequest(`/sales/leads/${leadId}/lost`, { method: "POST", body: { lost_reason: closeReason.trim() } });
      setCloseReason("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setClosing(false);
    }
  }

  if (!lead) {
    return (
      <>
        <TopBar title="Leads" />
        <div style={{ maxWidth: 500, margin: "0 auto", padding: "0 16px 32px" }}>
          {error ? <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div> : <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>}
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar title="Leads" />
      <div style={{ maxWidth: 500, margin: "0 auto", padding: "0 16px 32px" }}>
        <button onClick={onBack} style={{ marginBottom: 16 }}>← Back to leads</button>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}

        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>
              {lead.prospect_name}
              {lead.source === "public_inquiry" && (
                <>
                  <span className="badge badge-info" style={{ marginLeft: 6, fontSize: 10 }}>Public inquiry</span>
                  <span className="badge badge-neutral" style={{ marginLeft: 4, fontSize: 10 }}>{enquiryType(lead)}</span>
                </>
              )}
            </div>
            <span className={`badge ${LEAD_STATUS_BADGE[lead.status]}`}>{lead.status}</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--slate)" }}>
            <div>Assigned to: {lead.assigned_to_name || "— unassigned"}</div>
            {lead.contact_person && <div>Contact: {lead.contact_person} {lead.contact_phone ? `· ${lead.contact_phone}` : ""}</div>}
            {lead.site_location && <div>Location: {lead.site_location}</div>}
            {lead.mix_grade_interest && <div>Grade of interest: {lead.mix_grade_interest}</div>}
            {lead.estimated_qty_m3 && <div>Estimated quantity: {lead.estimated_qty_m3} m³</div>}
            {lead.notes && <div style={{ marginTop: 4, fontStyle: "italic" }}>"{lead.notes}"</div>}
            {lead.quotation_issued && <div>Latest quotation: ₹{lead.latest_quotation_amount}</div>}
            <div>
              {lead.at_site && lead.latitude ? (
                <>Added from site — <a href={`https://maps.google.com/?q=${lead.latitude},${lead.longitude}`} target="_blank" rel="noreferrer">view location</a></>
              ) : lead.at_site === false ? (
                "Added: not updated from site"
              ) : ""}
            </div>
            {lead.status === "lost" && lead.lost_reason && <div style={{ color: "var(--alert-red)" }}>Lost — {lead.lost_reason}</div>}
            {lead.status === "won" && <div style={{ color: "var(--signal-green)" }}>Won — counted as {lead.attribution === "salesperson" ? "salesperson's sale" : "company sale"}</div>}
          </div>
          {lead.site_latitude && lead.site_longitude && (
            <a
              href={`https://maps.google.com/?q=${lead.site_latitude},${lead.site_longitude}`}
              target="_blank" rel="noreferrer"
              style={{ display: "block", textAlign: "center", marginTop: 10, padding: 10, background: "var(--rebar)", color: "#fff", borderRadius: 8, fontWeight: 600, textDecoration: "none", fontSize: 13 }}
            >
              View site location
            </a>
          )}
        </div>

        {!lead.assigned_to && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Assign to a salesperson</div>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 8 }}>
              {lead.source === "public_inquiry" ? "Submitted directly by a potential customer — nobody's on this yet." : "No salesperson assigned yet."}
            </div>
            <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} style={{ width: "100%", marginBottom: 8 }}>
              <option value="">Select</option>
              {executives.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <button className="btn-primary" onClick={assign} disabled={assigning || !assignTo} style={{ width: "100%" }}>
              {assigning ? "Assigning..." : "Assign"}
            </button>
          </div>
        )}

        {canMarkWon && lead.status !== "won" && lead.status !== "lost" && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Mark this lead won</div>
            <select value={attribution} onChange={(e) => setAttribution(e.target.value)} style={{ width: "100%", marginBottom: 8 }}>
              <option value="salesperson">Counts as salesperson's own sale</option>
              <option value="company">Goes to the company directly</option>
            </select>
            <button className="btn-primary" onClick={markWon} disabled={saving} style={{ width: "100%" }}>
              {saving ? "Saving..." : "Confirm won"}
            </button>
          </div>
        )}

        {lead.status !== "won" && lead.status !== "lost" && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Close this lead</div>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 8 }}>
              Didn't go anywhere? Close it with a reason — it moves to "lost" and stops showing as open.
            </div>
            <input
              type="text" value={closeReason} onChange={(e) => setCloseReason(e.target.value)}
              placeholder="Reason (e.g. went with another supplier)" style={{ width: "100%", marginBottom: 8 }}
            />
            <button className="btn-danger" onClick={closeLead} disabled={closing || !closeReason.trim()} style={{ width: "100%" }}>
              {closing ? "Closing..." : "Close lead"}
            </button>
          </div>
        )}

        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Activity trail</div>
          {(!lead.followups || lead.followups.length === 0) ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>No activity logged yet.</div>
          ) : (
            lead.followups.map((f) => (
              <div key={f.id} style={{ fontSize: 12, padding: "8px 0", borderBottom: "1px solid var(--concrete)" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 600 }}>{ACTIVITY_LABEL[f.activity_type] || "Note"}</span>
                  <span style={{ color: "var(--slate)" }}>{new Date(f.created_at).toLocaleDateString([], { day: "2-digit", month: "short" })}</span>
                </div>
                <div>{f.note}</div>
                {f.quotation_amount && <div style={{ color: "var(--slate)" }}>Amount: ₹{f.quotation_amount}</div>}
                {f.revision_reason && <div style={{ color: "var(--slate)" }}>Reason: {f.revision_reason}</div>}
                {f.persons_met && <div style={{ color: "var(--slate)" }}>Met: {f.persons_met}</div>}
                <div style={{ color: "var(--slate)" }}>
                  {f.at_site && f.latitude ? (
                    <a href={`https://maps.google.com/?q=${f.latitude},${f.longitude}`} target="_blank" rel="noreferrer">At site — view location</a>
                  ) : f.at_site === false ? (
                    "Not updated from site"
                  ) : (
                    "—"
                  )}
                  {" · "}{f.created_by_name}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
