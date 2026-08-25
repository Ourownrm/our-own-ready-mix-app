import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { BookingsQueue } from "../lib/SalesPanels.jsx";
import { useAuth } from "../lib/AuthContext.jsx";

// Round 100, item 4 — Manager/Admin's console for the customer booking
// feature: generate a per-customer+site booking link, manage which links are
// active and whether live delivery tracking is bundled into them, and review
// incoming requests (the same queue that also shows on the Manager
// Dashboard — reused here rather than duplicated, see lib/SalesPanels.jsx).
//
// Round 115 — the Customer module now also hosts what used to live on the
// Sales Executive's own dashboard: placing a booking on a customer's behalf,
// and browsing after-sales feedback (which is now recorded inline on the
// Visits form, not a standalone entry point — see NewVisitForm). Tabs are
// picked by role, matching what the backend actually lets each role do:
// booking-links management is manager/administrator only; placing a booking
// and adding feedback are sales_executive only (both endpoints are gated
// that way already), so the tab set below just surfaces what each role can
// already do rather than inventing new permission checks.
const BOOKING_STATUS_BADGE = { pending: "badge-warning", converted: "badge-success", declined: "badge-danger" };

export default function CustomerBooking() {
  const { user } = useAuth();
  const isSalesExec = user?.role === "sales_executive";
  const [ctab, setCtab] = useState(isSalesExec ? "place" : "links");

  return (
    <>
      <TopBar title="Customer Booking" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="tabbar" style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
          {!isSalesExec && (
            <button onClick={() => setCtab("links")} className={ctab === "links" ? "btn-primary" : ""} style={{ fontSize: 12.5, padding: "6px 12px" }}>
              Booking Links &amp; Requests
            </button>
          )}
          {!isSalesExec && (
            <button onClick={() => setCtab("portal")} className={ctab === "portal" ? "btn-primary" : ""} style={{ fontSize: 12.5, padding: "6px 12px" }}>
              Portal Access
            </button>
          )}
          {isSalesExec && (
            <button onClick={() => setCtab("place")} className={ctab === "place" ? "btn-primary" : ""} style={{ fontSize: 12.5, padding: "6px 12px" }}>
              Place a Booking
            </button>
          )}
          <button onClick={() => setCtab("feedback")} className={ctab === "feedback" ? "btn-primary" : ""} style={{ fontSize: 12.5, padding: "6px 12px" }}>
            Feedback
          </button>
        </div>

        {ctab === "links" && !isSalesExec && <BookingLinksTab />}
        {ctab === "portal" && !isSalesExec && <PortalAccessTab />}
        {ctab === "place" && isSalesExec && <PlaceBookingTab />}
        {ctab === "feedback" && <FeedbackTab isSalesExec={isSalesExec} />}
      </div>
    </>
  );
}

function BookingLinksTab() {
  const [customers, setCustomers] = useState([]);
  const [sites, setSites] = useState([]);
  const [links, setLinks] = useState([]);
  const [customerId, setCustomerId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const [generated, setGenerated] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function loadLinks() {
    try {
      setLinks(await apiRequest("/booking-links"));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    Promise.all([apiRequest("/master/customers"), apiRequest("/master/sites")])
      .then(([c, s]) => { setCustomers(c); setSites(s); })
      .catch((err) => setError(err.message));
    loadLinks();
  }, []);

  const sitesForCustomer = sites.filter((s) => String(s.customer_id) === String(customerId));

  async function generate(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      const link = await apiRequest("/booking-links", {
        method: "POST",
        body: { customer_id: customerId, site_id: siteId, tracking_enabled: trackingEnabled },
      });
      setGenerated(link);
      loadLinks();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleTracking(link) {
    setError("");
    try {
      await apiRequest(`/booking-links/${link.id}/tracking`, { method: "PATCH", body: { tracking_enabled: !link.tracking_enabled } });
      loadLinks();
    } catch (err) {
      setError(err.message);
    }
  }

  async function revoke(link) {
    if (!window.confirm(`Revoke the booking link for ${link.customer_name} — ${link.site_name}? The customer won't be able to open it any more.`)) return;
    setError("");
    try {
      await apiRequest(`/booking-links/${link.id}/revoke`, { method: "POST" });
      loadLinks();
    } catch (err) {
      setError(err.message);
    }
  }

  function linkUrl(token) {
    return `${window.location.origin}/book/${token}`;
  }

  async function copyLink(token) {
    try {
      await navigator.clipboard.writeText(linkUrl(token));
    } catch {
      /* clipboard may be unavailable — the URL is still shown on screen */
    }
  }

  const activeLinks = links.filter((l) => l.is_active);
  const revokedLinks = links.filter((l) => !l.is_active);

  return (
    <>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 20, maxWidth: 480 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Generate a booking link</div>
        <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12, lineHeight: 1.5 }}>
          An unguessable link scoped to exactly one customer + one site, no login required — same pattern as the
          customer delivery-tracking link. Share it with a customer who already has a signed supply agreement, over
          WhatsApp/SMS.
        </div>
        <form onSubmit={generate} style={{ fontSize: 13 }}>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>Customer</span>
            <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setSiteId(""); }} required>
              <option value="">Select</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>Site / project</span>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)} required disabled={!customerId}>
              <option value="">{customerId ? "Select" : "Select a customer first"}</option>
              {sitesForCustomer.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 14, fontSize: 12 }}>
            <input type="checkbox" checked={trackingEnabled} onChange={(e) => setTrackingEnabled(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              Also let this customer see live delivery status on this same link, once an order is created from it.
              Off by default — you can turn it on or off later without touching the link itself.
            </span>
          </label>
          <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={saving}>
            {saving ? "Generating..." : "Generate link"}
          </button>
        </form>
        {generated && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 6 }}>Generated link:</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{
                flex: 1, background: "var(--concrete)", border: "1px dashed var(--border-strong, #ccc)",
                borderRadius: 8, padding: "8px 10px", fontSize: 12, fontFamily: "ui-monospace, monospace",
                color: "var(--info)", wordBreak: "break-all",
              }}>
                {linkUrl(generated.token)}
              </div>
              <button type="button" onClick={() => copyLink(generated.token)} style={{ fontSize: 12 }}>Copy</button>
            </div>
          </div>
        )}
      </div>

      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Active links</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10, lineHeight: 1.5 }}>
        The booking link and the delivery-status view are two separate switches — turning tracking off (or back on)
        never touches the link itself. Revoke kills both, since without the link there's nothing to show.
      </div>
      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 24 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th style={th}>Customer / Site</th>
              <th style={th}>Link</th>
              <th style={th}>Tracking</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {activeLinks.length === 0 && (
              <tr><td colSpan={4} style={{ ...td, color: "var(--slate)" }}>No active booking links yet.</td></tr>
            )}
            {activeLinks.map((l) => (
              <tr key={l.id}>
                <td style={td}>
                  <b>{l.customer_name}</b>
                  <div style={{ color: "var(--slate)", fontSize: 11.5 }}>{l.site_name}</div>
                </td>
                <td style={td}>
                  <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5, color: "var(--info)" }}>
                    .../book/{l.token.slice(0, 8)}…
                  </span>{" "}
                  <button type="button" onClick={() => copyLink(l.token)} style={{ fontSize: 11, padding: "3px 8px" }}>Copy</button>
                </td>
                <td style={td}>
                  <span className="badge" style={{
                    background: l.tracking_enabled ? "var(--signal-green-bg)" : "var(--concrete)",
                    color: l.tracking_enabled ? "var(--signal-green)" : "var(--slate)",
                  }}>
                    {l.tracking_enabled ? "Tracking ON" : "Tracking OFF"}
                  </span>
                </td>
                <td style={td}>
                  <button type="button" style={{ fontSize: 11.5, padding: "5px 10px", marginRight: 6 }} onClick={() => toggleTracking(l)}>
                    {l.tracking_enabled ? "Turn tracking off" : "Turn tracking on"}
                  </button>
                  <button type="button" className="btn-danger" style={{ fontSize: 11.5, padding: "5px 10px" }} onClick={() => revoke(l)}>
                    Revoke link
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {revokedLinks.length > 0 && (
        <details style={{ marginBottom: 20 }}>
          <summary style={{ fontSize: 12.5, color: "var(--slate)", cursor: "pointer" }}>
            {revokedLinks.length} revoked link{revokedLinks.length === 1 ? "" : "s"}
          </summary>
          <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <tbody>
                {revokedLinks.map((l) => (
                  <tr key={l.id}>
                    <td style={td}><b>{l.customer_name}</b> <span style={{ color: "var(--slate)" }}>— {l.site_name}</span></td>
                    <td style={{ ...td, color: "var(--slate)" }}>Revoked {new Date(l.revoked_at).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Incoming requests</div>
      <BookingsQueue setError={setError} />
    </>
  );
}

// ===================== PORTAL ACCESS CODES (round 119) =====================
// Manager/Admin's console for the customer portal (/portal) — an existing
// customer signs in there with a short access code, not a shareable link.
// Per explicit business decision: a link means "anyone who has the URL can
// see everything," so a customer here instead gets a short code they type
// in themselves, scoped to one customer and one or more of their sites, and
// Manager sends it over their OWN phone (SMS/WhatsApp/call) — there's no
// in-app SMS/WhatsApp sending here, this just generates the code.
function PortalAccessTab() {
  const [customers, setCustomers] = useState([]);
  const [sites, setSites] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [customerId, setCustomerId] = useState("");
  const [siteIds, setSiteIds] = useState([]);
  const [label, setLabel] = useState("");
  const [generated, setGenerated] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function loadTokens() {
    try {
      setTokens(await apiRequest("/customer-access"));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    Promise.all([apiRequest("/master/customers"), apiRequest("/master/sites")])
      .then(([c, s]) => { setCustomers(c); setSites(s); })
      .catch((err) => setError(err.message));
    loadTokens();
  }, []);

  const sitesForCustomer = sites.filter((s) => String(s.customer_id) === String(customerId));

  function toggleSite(id) {
    setSiteIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function generate(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      const token = await apiRequest("/customer-access", {
        method: "POST",
        body: { customer_id: customerId, site_ids: siteIds, label },
      });
      setGenerated(token);
      setSiteIds([]);
      setLabel("");
      loadTokens();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function revoke(token) {
    if (!window.confirm(`Revoke the access code for ${token.customer_name}? They won't be able to sign in with it any more.`)) return;
    setError("");
    try {
      await apiRequest(`/customer-access/${token.id}/revoke`, { method: "POST" });
      loadTokens();
    } catch (err) {
      setError(err.message);
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be unavailable — the value is still shown on screen */
    }
  }

  const inquiryUrl = `${window.location.origin}/inquiry`;
  const activeTokens = tokens.filter((t) => t.is_active);
  const revokedTokens = tokens.filter((t) => !t.is_active);

  return (
    <>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 20, maxWidth: 520 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Public inquiry form</div>
        <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 8, lineHeight: 1.5 }}>
          Share this link anywhere (website, social media) for potential customers to request a quote — it feeds
          straight into Browse Leads, no account needed.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{
            flex: 1, background: "var(--concrete)", border: "1px dashed var(--border-strong, #ccc)",
            borderRadius: 8, padding: "8px 10px", fontSize: 12, fontFamily: "ui-monospace, monospace",
            color: "var(--info)", wordBreak: "break-all",
          }}>
            {inquiryUrl}
          </div>
          <button type="button" onClick={() => copyText(inquiryUrl)} style={{ fontSize: 12 }}>Copy</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20, maxWidth: 520 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Generate a customer access code</div>
        <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12, lineHeight: 1.5 }}>
          A short code (not a link) an existing customer types into /portal to see their own orders and QC reports.
          Covers one or more of their sites — send it to them yourself, by phone/SMS/WhatsApp.
        </div>
        <form onSubmit={generate} style={{ fontSize: 13 }}>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>Customer</span>
            <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setSiteIds([]); }} required>
              <option value="">Select</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <div style={{ marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>
              Site(s) this code can see
            </span>
            {!customerId ? (
              <div style={{ fontSize: 12, color: "var(--slate)" }}>Select a customer first</div>
            ) : sitesForCustomer.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--slate)" }}>No sites on file for this customer</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 140, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
                {sitesForCustomer.map((s) => (
                  <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                    <input type="checkbox" checked={siteIds.includes(s.id)} onChange={() => toggleSite(s.id)} />
                    {s.name}
                  </label>
                ))}
              </div>
            )}
          </div>
          <label style={{ display: "block", marginBottom: 14 }}>
            <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>Label (optional)</span>
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Site engineer — Ravi" />
          </label>
          <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={saving || siteIds.length === 0}>
            {saving ? "Generating..." : "Generate access code"}
          </button>
        </form>
        {generated && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 6 }}>Generated code — send this to the customer:</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{
                flex: 1, background: "var(--concrete)", border: "1px dashed var(--border-strong, #ccc)",
                borderRadius: 8, padding: "10px 12px", fontSize: 18, fontWeight: 700, letterSpacing: 2,
                fontFamily: "ui-monospace, monospace", color: "var(--info)", textAlign: "center",
              }}>
                {generated.token}
              </div>
              <button type="button" onClick={() => copyText(generated.token)} style={{ fontSize: 12 }}>Copy</button>
            </div>
          </div>
        )}
      </div>

      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Active access codes</div>
      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 24 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th style={th}>Customer</th>
              <th style={th}>Sites</th>
              <th style={th}>Code</th>
              <th style={th}>Last used</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {activeTokens.length === 0 && (
              <tr><td colSpan={5} style={{ ...td, color: "var(--slate)" }}>No active access codes yet.</td></tr>
            )}
            {activeTokens.map((t) => (
              <tr key={t.id}>
                <td style={td}>
                  <b>{t.customer_name}</b>
                  {t.label && <div style={{ color: "var(--slate)", fontSize: 11.5 }}>{t.label}</div>}
                </td>
                <td style={{ ...td, color: "var(--slate)", fontSize: 11.5 }}>{(t.site_names || []).join(", ") || "—"}</td>
                <td style={td}>
                  <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5, color: "var(--info)", fontWeight: 700 }}>{t.token}</span>{" "}
                  <button type="button" onClick={() => copyText(t.token)} style={{ fontSize: 11, padding: "3px 8px" }}>Copy</button>
                </td>
                <td style={{ ...td, color: "var(--slate)" }}>{t.last_used_at ? new Date(t.last_used_at).toLocaleDateString([], { day: "2-digit", month: "short" }) : "Never"}</td>
                <td style={td}>
                  <button type="button" className="btn-danger" style={{ fontSize: 11.5, padding: "5px 10px" }} onClick={() => revoke(t)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {revokedTokens.length > 0 && (
        <details style={{ marginBottom: 20 }}>
          <summary style={{ fontSize: 12.5, color: "var(--slate)", cursor: "pointer" }}>
            {revokedTokens.length} revoked code{revokedTokens.length === 1 ? "" : "s"}
          </summary>
          <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <tbody>
                {revokedTokens.map((t) => (
                  <tr key={t.id}>
                    <td style={td}><b>{t.customer_name}</b> <span style={{ color: "var(--slate)" }}>— {(t.site_names || []).join(", ")}</span></td>
                    <td style={{ ...td, color: "var(--slate)" }}>Revoked {new Date(t.revoked_at).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}

// ===================== PLACE A BOOKING (moved from the Sales Executive's own dashboard) =====================

function PlaceBookingTab() {
  const [onDuty, setOnDuty] = useState(false);
  const [bookings, setBookings] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [status, b] = await Promise.all([apiRequest("/sales/duty-status"), apiRequest("/sales/bookings")]);
      setOnDuty(status.on_duty);
      setBookings(b);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  if (showForm) {
    return <NewBookingForm onDone={() => { setShowForm(false); load(); }} onCancel={() => setShowForm(false)} />;
  }

  return (
    <>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {!onDuty && (
        <div style={{ fontSize: 12, color: "var(--slate)", background: "var(--concrete)", borderRadius: 8, padding: "8px 10px", marginBottom: 12 }}>
          Clock in from your own dashboard first — placing a booking is a field action, same as logging a visit.
        </div>
      )}
      <BookingsList bookings={bookings} onNew={() => setShowForm(true)} onDuty={onDuty} />
    </>
  );
}

function BookingsList({ bookings, onNew, onDuty }) {
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>My bookings</div>
        <button onClick={onNew} disabled={!onDuty} title={!onDuty ? "Clock in first" : ""} style={{ fontSize: 12, padding: "5px 10px" }}>+ New booking</button>
      </div>
      {bookings.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No bookings placed yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {bookings.map((b) => (
            <div key={b.id} style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600 }}>{b.customer_name}</span>
                <span className={`badge ${BOOKING_STATUS_BADGE[b.status]}`}>{b.status}</span>
              </div>
              <div style={{ color: "var(--slate)" }}>{b.site_name || "Site TBD"} · {b.mix_grade_name || "Grade TBD"} · {b.estimated_qty_m3 ? `${b.estimated_qty_m3} m³` : ""}</div>
              {b.status === "declined" && b.declined_reason && <div style={{ color: "var(--alert-red)" }}>Declined — {b.declined_reason}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewBookingForm({ onDone, onCancel }) {
  const [customers, setCustomers] = useState([]);
  const [sites, setSites] = useState([]);
  const [mixGrades, setMixGrades] = useState([]);
  const [form, setForm] = useState({ customer_id: "", site_id: "", mix_grade_id: "", estimated_qty_m3: "", preferred_date: "", preferred_time: "", notes: "", site_latitude: "", site_longitude: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    Promise.all([apiRequest("/master/customers"), apiRequest("/master/sites"), apiRequest("/master/mix-grades")])
      .then(([c, s, m]) => { setCustomers(c); setSites(s); setMixGrades(m); })
      .catch((err) => setError(err.message));
  }, []);

  const sitesForCustomer = form.customer_id ? sites.filter((s) => String(s.customer_id) === String(form.customer_id)) : sites;

  async function addCustomer() {
    const name = window.prompt("New customer name:");
    if (!name || !name.trim()) return;
    setError("");
    try {
      const created = await apiRequest("/sales/quick-customer", { method: "POST", body: { name } });
      setCustomers((prev) => [...prev, created]);
      setForm((f) => ({ ...f, customer_id: created.id, site_id: "" }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function addSite() {
    if (!form.customer_id) { setError("Select a customer first."); return; }
    const name = window.prompt("New site/project name:");
    if (!name || !name.trim()) return;
    setError("");
    try {
      const created = await apiRequest("/sales/quick-site", { method: "POST", body: { customer_id: form.customer_id, name } });
      setSites((prev) => [...prev, created]);
      setForm((f) => ({ ...f, site_id: created.id }));
    } catch (err) {
      if (err.status === 409 && window.confirm(`${err.message}\n\nCreate it anyway?`)) {
        try {
          const created = await apiRequest("/sales/quick-site", { method: "POST", body: { customer_id: form.customer_id, name, force: true } });
          setSites((prev) => [...prev, created]);
          setForm((f) => ({ ...f, site_id: created.id }));
        } catch (err2) { setError(err2.message); }
      } else if (err.status !== 409) {
        setError(err.message);
      }
    }
  }

  function useCurrentLocation() {
    setLocating(true);
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, site_latitude: pos.coords.latitude.toFixed(7), site_longitude: pos.coords.longitude.toFixed(7) }));
        setLocating(false);
      },
      () => { setError("Couldn't get current location — enter coordinates manually if you have them."); setLocating(false); }
    );
  }

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await apiRequest("/sales/bookings", { method: "POST", body: form });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <button onClick={onCancel} style={{ marginBottom: 16 }}>← Back</button>
      <div style={{ fontWeight: 600, marginBottom: 10 }}>Place a booking</div>
      <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
        <div>
          <div style={{ color: "var(--slate)" }}>Customer</div>
          <div style={{ display: "flex", gap: 6 }}>
            <select value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value, site_id: "" })} required style={{ flex: 1 }}>
              <option value="">Select</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button type="button" onClick={addCustomer} style={{ fontSize: 12, padding: "4px 10px" }}>+ New</button>
          </div>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Site (if known)</div>
          <div style={{ display: "flex", gap: 6 }}>
            <select value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })} style={{ flex: 1 }}>
              <option value="">Not decided yet</option>
              {sitesForCustomer.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button type="button" onClick={addSite} disabled={!form.customer_id} style={{ fontSize: 12, padding: "4px 10px" }}>+ New</button>
          </div>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Site location (GPS)</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 6 }}>
            <input type="number" step="any" value={form.site_latitude} onChange={(e) => setForm({ ...form, site_latitude: e.target.value })} placeholder="Latitude" />
            <input type="number" step="any" value={form.site_longitude} onChange={(e) => setForm({ ...form, site_longitude: e.target.value })} placeholder="Longitude" />
          </div>
          <button type="button" onClick={useCurrentLocation} disabled={locating} style={{ fontSize: 12, padding: "5px 10px" }}>
            {locating ? "Getting location..." : "Use my current location"}
          </button>
          <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>
            If this is a new site, this carries through automatically once Manager converts the booking — drivers can navigate there from the first delivery.
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <div style={{ color: "var(--slate)" }}>Grade</div>
            <select value={form.mix_grade_id} onChange={(e) => setForm({ ...form, mix_grade_id: e.target.value })}>
              <option value="">Select</option>
              {mixGrades.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>Est. quantity (m³)</div>
            <input type="number" value={form.estimated_qty_m3} onChange={(e) => setForm({ ...form, estimated_qty_m3: e.target.value })} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <div style={{ color: "var(--slate)" }}>Preferred date</div>
            <input type="date" value={form.preferred_date} onChange={(e) => setForm({ ...form, preferred_date: e.target.value })} />
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>Preferred time</div>
            <input type="time" value={form.preferred_time} onChange={(e) => setForm({ ...form, preferred_time: e.target.value })} />
          </div>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Notes for manager</div>
          <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Site plan pending, payment terms 15 days" />
        </div>
        {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
        <button type="submit" disabled={saving}>{saving ? "Submitting..." : "Submit booking"}</button>
        <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center" }}>
          Manager confirms site readiness and payment terms before converting this to an order.
        </div>
      </form>
    </div>
  );
}

// ===================== FEEDBACK (read-only — now fed by the Visits form, round 115) =====================

function FeedbackTab({ isSalesExec }) {
  const [feedback, setFeedback] = useState([]);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/sales/feedback").then(setFeedback).catch((err) => setError(err.message));
  }, []);

  const filtered = filter === "all" ? feedback : feedback.filter((f) => f.feedback_type === filter);

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {isSalesExec ? "My after-sales feedback" : "After-sales feedback — all reps"}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {[["all", "All"], ["compliment", "Compliments"], ["complaint", "Complaints"]].map(([key, label]) => (
            <button key={key} onClick={() => setFilter(key)} className={filter === key ? "btn-primary" : ""} style={{ fontSize: 11, padding: "4px 9px" }}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 10 }}>
        Recorded inline when a rep logs a customer visit that follows a delivery — no separate entry needed.
      </div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {filtered.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>None recorded yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((f) => (
            <div key={f.id} style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 600 }}>{f.customer_name}</span>
                <span className={`badge ${f.feedback_type === "complaint" ? "badge-danger" : "badge-success"}`}>{f.feedback_type}</span>
              </div>
              <div style={{ color: "var(--slate)" }}>{f.comment}</div>
              <div style={{ color: "var(--slate)", fontSize: 11 }}>
                {new Date(f.created_at).toLocaleDateString([], { day: "2-digit", month: "short" })}
                {!isSalesExec && f.recorded_by_name && ` · Logged by ${f.recorded_by_name}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const th = { padding: "9px 10px", borderBottom: "1px solid var(--border)", color: "var(--slate)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 };
const td = { padding: "9px 10px", borderBottom: "1px solid var(--border)" };
