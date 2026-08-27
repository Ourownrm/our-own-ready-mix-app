import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { APP_VERSION } from "../lib/version.js";
import { generateMixDesignPdf } from "../lib/mixDesignPdf.js";
import { generateCubeTestPdf } from "../lib/cubeTestPdf.js";
import { formatOrderNumber } from "../lib/orderNumber.js";

// Public, no-login page reached only via a shared per-customer+site link
// (see pages/CustomerBooking.jsx for how Manager/Admin generate it, and
// routes/customerBooking.js on the backend for why this is safe to leave
// open). Deliberately doesn't use TopBar/ProtectedRoute — there's no session
// here, same pattern as CustomerTracking.jsx.

const STAGES = [
  { key: "left_plant_at", label: "Left\nPlant" },
  { key: "reached_site_at", label: "At\nSite" },
  { key: "unloading_started_at", label: "Unloading" },
  { key: "unloading_completed_at", label: "Delivered" },
];

function truckStageIndex(t) {
  if (t.status === "rejected") return -1;
  if (t.unloading_completed_at) return 3;
  if (t.unloading_started_at) return 2;
  if (t.reached_site_at) return 1;
  if (t.left_plant_at) return 0;
  return -2;
}

const PUMP_LABELS = { boom_pump: "Boom pump", line_pump: "Line pump", without_pump: "No pump — direct pour" };

const emptyForm = {
  mix_grade_id: "", estimated_qty_m3: "", preferred_date: "", preferred_time: "",
  pump_requirement: "without_pump", casting_location: "", site_contact_name: "", site_contact_number: "", notes: "",
};

export default function CustomerBookingForm() {
  const { token } = useParams();
  const [data, setData] = useState(undefined); // undefined = loading, null = expired
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function load() {
    apiRequest(`/customer-booking/${token}`)
      .then((d) => { setData(d); })
      .catch(() => setData(null));
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (data === undefined) return <CenterMessage>Loading...</CenterMessage>;

  if (data === null) {
    return (
      <Shell>
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🔒</div>
          <h2 style={{ fontSize: 16, marginBottom: 6 }}>This booking link is no longer active</h2>
          <p style={{ fontSize: 13, color: "var(--slate)", lineHeight: 1.6 }}>
            It may have been turned off, or unable to connect to Our Own RMC Server. Please contact your Our Own
            Ready Mix representative for a fresh link.
          </p>
        </div>
      </Shell>
    );
  }

  const {
    customer_name, site_name, mix_grades, requests, tracking, tracking_enabled,
    allow_qc_reports, allow_technical_writings, qc_reports, technical_writings,
  } = data;
  // Round 116 fix: this used to gate purely on "has any request ever been
  // submitted through this exact link" — so a link generated for a
  // customer/site that already had an ongoing order (created directly by
  // Manager, never as a booking request through this link) showed nothing
  // but the bare request form, even with tracking turned on and trucks
  // actually moving. Showing the status view whenever there's tracking to
  // show fixes that; the plain request form is now only the true first-run
  // state — no requests AND nothing currently being tracked.
  // Round 119, post-ship again, item 4 — QC Reports and Technical Writings
  // are now also reasons to land on the status screen instead of straight on
  // the bare request form, same as tracking already was, since there can be
  // something worth showing there even before any booking request exists.
  const displayForm = (requests.length === 0 && !tracking && !allow_qc_reports && !allow_technical_writings) || showForm;

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await apiRequest(`/customer-booking/${token}`, { method: "POST", body: form });
      setForm(emptyForm);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // Round 119, post-ship again, item 4 — same client-side PDF generation the
  // authenticated /portal side already uses (mixDesignPdf.js/cubeTestPdf.js),
  // just fetching the raw data from this link's own token-scoped routes
  // instead of an auth'd session.
  const [busy, setBusy] = useState(false);
  const [busyErr, setBusyErr] = useState("");
  async function viewMixDesign(orderId) {
    setBusyErr(""); setBusy(true);
    try {
      const d = await apiRequest(`/customer-booking/${token}/orders/${orderId}/mix-design-pdf-data`);
      await generateMixDesignPdf(d);
    } catch (err) {
      setBusyErr(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function viewCubeTest(resultId) {
    setBusyErr(""); setBusy(true);
    try {
      const d = await apiRequest(`/customer-booking/${token}/cube-tests/${resultId}/pdf-data`);
      await generateCubeTestPdf(d);
    } catch (err) {
      setBusyErr(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function openTechDoc(doc) {
    setBusyErr(""); setBusy(true);
    try {
      const file = await apiRequest(`/customer-booking/${token}/technical-writings/${doc.id}/file`);
      const bytes = Uint8Array.from(atob(file.data_base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: file.mime_type || "application/pdf" });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank");
      if (!win) window.location.assign(url);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setBusyErr(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (displayForm) {
    return (
      <Shell>
        <CustomerHeading customerName={customer_name} siteName={site_name} />
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Request concrete</div>
        </div>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
        <form onSubmit={submit} className="card" style={{ marginBottom: 20 }}>
          <Field label="Date required">
            <input type="date" value={form.preferred_date} onChange={(e) => setForm({ ...form, preferred_date: e.target.value })} required />
          </Field>
          <Field label="Preferred time">
            <input type="time" value={form.preferred_time} onChange={(e) => setForm({ ...form, preferred_time: e.target.value })} required />
          </Field>
          <Field label="Grade of concrete">
            <select value={form.mix_grade_id} onChange={(e) => setForm({ ...form, mix_grade_id: e.target.value })} required>
              <option value="">Select</option>
              {mix_grades.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Quantity (m³)">
            <input type="number" min="0" step="0.5" value={form.estimated_qty_m3} onChange={(e) => setForm({ ...form, estimated_qty_m3: e.target.value })} required />
          </Field>
          <Field label="Pump required?">
            <select value={form.pump_requirement} onChange={(e) => setForm({ ...form, pump_requirement: e.target.value })}>
              <option value="without_pump">No pump — direct pour</option>
              <option value="boom_pump">Boom pump</option>
              <option value="line_pump">Line pump</option>
            </select>
          </Field>
          <Field label="Structure / casting location">
            <input type="text" value={form.casting_location} onChange={(e) => setForm({ ...form, casting_location: e.target.value })} placeholder="e.g. Column & slab — Block A, 2nd floor" />
          </Field>
          <Field label="Site contact name">
            <input type="text" value={form.site_contact_name} onChange={(e) => setForm({ ...form, site_contact_name: e.target.value })} />
          </Field>
          <Field label="Site contact phone">
            <input type="tel" value={form.site_contact_number} onChange={(e) => setForm({ ...form, site_contact_number: e.target.value })} required />
          </Field>
          <Field label="Special instructions (optional)">
            <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
          <div style={{ fontSize: 11, color: "var(--slate)", lineHeight: 1.5, margin: "2px 0 14px" }}>
            This order will be governed by the Terms &amp; Conditions of your existing Supply Agreement with Our Own
            Ready Mix.
          </div>
          <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={saving}>
            {saving ? "Sending..." : "Send booking request"}
          </button>
          {requests.length > 0 && (
            <button type="button" style={{ width: "100%", marginTop: 8 }} onClick={() => setShowForm(false)}>
              ← Back to my requests
            </button>
          )}
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      <CustomerHeading customerName={customer_name} siteName={site_name} />
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Booking status</div>
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, margin: "4px 0 8px" }}>Your booking requests</div>
      {requests.length === 0 ? (
        <div className="card" style={{ marginBottom: 14, fontSize: 12, color: "var(--slate)" }}>
          No booking requests submitted through this link yet — your current order's status is shown below.
        </div>
      ) : (
        requests.map((r) => <RequestStatusCard key={r.id} request={r} />)
      )}

      {tracking_enabled && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, margin: "16px 0 8px" }}>Live delivery status</div>
          {tracking ? (
            <>
              {tracking.trucks.filter((t) => t.status !== "rejected").map((t) => (
                <TruckCard key={t.ticket_number} truck={t} />
              ))}
              {tracking.trucks.length === 0 && (
                <div className="card" style={{ marginBottom: 14, fontSize: 12, color: "var(--slate)" }}>
                  No trucks dispatched yet — this will update automatically once one leaves the plant.
                </div>
              )}
            </>
          ) : (
            // Round 119, post-ship again, item 4 — this section used to
            // render nothing at all here (not even this line) when tracking
            // was switched on but there was no live/recent order yet, which
            // read as "tracking is broken" rather than "nothing to track
            // right now."
            <div className="card" style={{ marginBottom: 14, fontSize: 12, color: "var(--slate)" }}>
              No delivery in progress for this site right now — this will update automatically once an order is scheduled.
            </div>
          )}
        </>
      )}

      {allow_qc_reports && qc_reports && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, margin: "16px 0 8px" }}>QC reports</div>
          {busyErr && <div style={{ color: "var(--alert-red)", fontSize: 12, marginBottom: 8 }}>{busyErr}</div>}
          {qc_reports.cube_tests.length === 0 && qc_reports.mix_designs.length === 0 ? (
            <div className="card" style={{ marginBottom: 14, fontSize: 12, color: "var(--slate)" }}>
              No cube test results or approved mix designs on file yet for this site.
            </div>
          ) : (
            <>
              {qc_reports.mix_designs.map((m) => (
                <div key={m.order_id} className="card" style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <div style={{ fontWeight: 700, fontSize: 12.5 }}>{m.mix_grade_name}{m.design_ref_code ? ` · ${m.design_ref_code}` : ""}</div>
                    <span className="badge badge-success">Approved mix design</span>
                  </div>
                  <button type="button" onClick={() => viewMixDesign(m.order_id)} disabled={busy} style={{ fontSize: 11.5, padding: "5px 10px", marginTop: 8 }}>View PDF</button>
                </div>
              ))}
              {qc_reports.cube_tests.map((t) => (
                <div key={t.id} className="card" style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <div style={{ fontWeight: 700, fontSize: 12.5 }}>{formatOrderNumber(t.order_id)} · {t.mix_grade_name}</div>
                    <span style={{ fontSize: 11, color: "var(--slate)" }}>
                      {t.tested_at ? new Date(t.tested_at).toLocaleDateString([], { day: "2-digit", month: "short" }) : ""}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 4 }}>
                    {t.testing_age_days}-day{t.average_strength_mpa ? ` · ${t.average_strength_mpa} N/mm²` : ""}
                  </div>
                  <button type="button" onClick={() => viewCubeTest(t.id)} disabled={busy} style={{ fontSize: 11.5, padding: "5px 10px", marginTop: 8 }}>View PDF</button>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {allow_technical_writings && technical_writings && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, margin: "16px 0 8px" }}>Technical writings</div>
          {technical_writings.length === 0 ? (
            <div className="card" style={{ marginBottom: 14, fontSize: 12, color: "var(--slate)" }}>
              No documents uploaded yet.
            </div>
          ) : (
            technical_writings.map((doc) => (
              <button
                key={doc.id} type="button" onClick={() => openTechDoc(doc)} disabled={busy}
                className="card" style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 10, cursor: "pointer", fontFamily: "inherit" }}
              >
                <div style={{ fontWeight: 700, fontSize: 12.5 }}>{doc.title}</div>
                <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>{doc.category || "General"}</div>
              </button>
            ))
          )}
        </>
      )}

      <button className="btn-primary" style={{ width: "100%", marginBottom: 6, marginTop: 4 }} onClick={() => setShowForm(true)}>
        + New booking request
      </button>
      <div style={{ fontSize: 10.5, color: "var(--slate)", textAlign: "center", marginBottom: 10 }}>
        Always available — you can request more than one booking for this site at a time.
      </div>

      <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center", padding: "6px 16px 22px", lineHeight: 1.6 }}>
        This link shows only your own bookings and site. It doesn't show any other customer's data.<br />
        Shared by Our Own Ready Mix.
      </div>
    </Shell>
  );
}

// Round 115 — customer name is now the big, bold heading; site name moves
// underneath as the smaller label. Reversed from before, per feedback that
// the customer's own identity should be the prominent thing they see, not
// the site name.
function CustomerHeading({ customerName, siteName }) {
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.2 }}>{customerName}</div>
      <div style={{ fontSize: 12, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4, marginTop: 2 }}>{siteName}</div>
    </div>
  );
}

// Round 116 fix: once a request was accepted and converted to an order, this
// card used to freeze at "Accepted — scheduled" forever — it never looked at
// what actually happened to the order afterward (delivery started, finished,
// or the order got closed/cancelled). The backend now also sends the linked
// order's own status (`order_status`), so a converted request tracks the
// real thing all the way through, the same status vocabulary as the round-91
// tracking link uses.
const ORDER_STATUS_MAP = {
  planned: { bg: "var(--signal-green-bg)", color: "var(--signal-green)", title: "Accepted — scheduled", body: "Please ensure the site is ready to receive concrete at the scheduled time." },
  in_progress: { bg: "var(--info-bg)", color: "var(--info)", title: "Delivery in progress", body: "Trucks are on the move — see live delivery status below." },
  partially_completed: { bg: "var(--amber-bg)", color: "var(--amber)", title: "Partially delivered", body: "Part of this order has been delivered; the rest is still on its way." },
  completed: { bg: "var(--signal-green-bg)", color: "var(--signal-green)", title: "Completed", body: "This order has been fully delivered." },
  closed: { bg: "var(--concrete)", color: "var(--slate)", title: "Closed", body: "This order has been closed." },
  cancelled: { bg: "var(--alert-red-bg)", color: "var(--alert-red)", title: "Cancelled", body: "This order was cancelled — please contact us if you still need this delivery." },
};

function RequestStatusCard({ request }) {
  const map = {
    pending: { bg: "var(--amber-bg)", color: "var(--amber)", title: "Under review", body: "We've received your request. You'll be notified here once it's confirmed." },
    declined: { bg: "var(--alert-red-bg)", color: "var(--alert-red)", title: "Not accepted this time", body: request.declined_reason || "Please contact us, or submit a new request with different details." },
  };
  const isConverted = request.status === "converted";
  const s = isConverted ? (ORDER_STATUS_MAP[request.order_status] || ORDER_STATUS_MAP.planned) : (map[request.status] || map.pending);

  // Round 116 fix: once converted, whatever Manager actually scheduled (via
  // Convert, or a later Correct Order edit) can differ from the customer's
  // original ask — prefer the live order's date/time/grade/qty so this
  // reflects reality, falling back to the original request fields only if
  // the order fields aren't present for some reason.
  const gradeName = isConverted ? (request.order_mix_grade_name || request.mix_grade_name) : request.mix_grade_name;
  const qty = isConverted ? (request.order_order_quantity_m3 ?? request.estimated_qty_m3) : request.estimated_qty_m3;
  const date = isConverted ? (request.order_order_date || request.preferred_date) : request.preferred_date;
  const time = isConverted ? (request.order_scheduled_batching_time || request.preferred_time) : request.preferred_time;

  return (
    <div className="card" style={{ marginBottom: 10, background: s.bg, borderColor: "transparent" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 700 }}>{gradeName || "Grade TBD"}{qty ? ` · ${qty} m³` : ""}</div>
        <div style={{ fontWeight: 700, color: s.color, fontSize: 12.5 }}>{s.title}</div>
      </div>
      <div style={{ fontSize: 12, color: "var(--charcoal)", marginTop: 4 }}>
        {date
          ? `${isConverted ? "Scheduled for" : "Requested for"} ${new Date(date).toLocaleDateString([], { day: "2-digit", month: "short" })}${time ? `, ${time.slice(0, 5)}` : ""}`
          : s.body}
        {request.pump_requirement && request.pump_requirement !== "without_pump" && ` · ${PUMP_LABELS[request.pump_requirement]}`}
      </div>
      {isConverted && date && <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>{s.body}</div>}
      {request.status === "declined" && request.declined_reason && (
        <div style={{ fontSize: 12, color: "var(--alert-red)", marginTop: 4 }}>{request.declined_reason}</div>
      )}
    </div>
  );
}

function TruckCard({ truck }) {
  const stage = truckStageIndex(truck);
  const done = stage === 3;
  return (
    <div className="card" style={{ marginBottom: 12, opacity: done ? 0.9 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>🚚 {truck.truck_number || "Truck"}</div>
          <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>{truck.quantity_m3} m³ · DC #{truck.ticket_number}</div>
        </div>
      </div>
      {stage >= -1 && (
        <div style={{ display: "flex", alignItems: "center", marginTop: 14 }}>
          {STAGES.map((s, i) => (
            <div key={s.key} style={{ flex: 1, textAlign: "center", position: "relative" }}>
              {i > 0 && (
                <div style={{ position: "absolute", top: 11, left: "-50%", width: "100%", height: 2, background: i <= stage ? "var(--signal-green)" : "#ECEAE4", zIndex: -1 }} />
              )}
              <div style={{
                width: 22, height: 22, borderRadius: "50%", margin: "0 auto 6px", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 700,
                background: i < stage || (i === stage && done) ? "var(--signal-green)" : i === stage ? "var(--rebar)" : "#ECEAE4",
                color: i <= stage ? "#fff" : "var(--slate)",
                boxShadow: i === stage && !done ? "0 0 0 4px rgba(199,91,18,0.15)" : "none",
              }}>
                {i < stage || (i === stage && done) ? "✓" : i === stage ? "●" : ""}
              </div>
              <div style={{ fontSize: 10, color: i <= stage ? (i === stage && !done ? "var(--rebar)" : "var(--signal-green)") : "var(--slate)", fontWeight: i === stage ? 700 : 500, whiteSpace: "pre-line", lineHeight: 1.2 }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ fontSize: 12, color: "var(--slate)", marginBottom: 4, display: "block" }}>{label}</span>
      {children}
    </label>
  );
}

function Shell({ children }) {
  // Round 119, post-ship again, item 5 — a booking link is opened directly
  // (WhatsApp/SMS), not from within /portal, so — same reasoning as
  // PublicInquiry.jsx's Shell — only show Back when there's actually
  // somewhere in this tab's own history to go back to.
  const canGoBack = typeof window !== "undefined" && window.history.length > 1;
  return (
    <div style={{ maxWidth: 460, margin: "0 auto", minHeight: "100vh", background: "var(--concrete)" }}>
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="topbar-title">
          Our Own Ready Mix <span style={{ opacity: 0.6, fontSize: "0.85em" }}>Ver. {APP_VERSION}</span>
          <div style={{ color: "#B8BFC7", fontWeight: 400, fontSize: 12, marginTop: 2 }}>
            Concrete booking
          </div>
        </div>
      </div>
      <div style={{ padding: "0 16px" }}>
        {canGoBack && (
          <button type="button" onClick={() => window.history.back()} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, background: "none", border: "none", padding: "6px 0 10px", color: "var(--rebar)", cursor: "pointer", fontWeight: 600 }}>
            ← Back
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

function CenterMessage({ children }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--slate)", fontSize: 13 }}>
      {children}
    </div>
  );
}
