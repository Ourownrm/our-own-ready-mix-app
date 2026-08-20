import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { BookingsQueue } from "../lib/SalesPanels.jsx";

// Round 100, item 4 — Manager/Admin's console for the customer booking
// feature: generate a per-customer+site booking link, manage which links are
// active and whether live delivery tracking is bundled into them, and review
// incoming requests (the same queue that also shows on the Manager
// Dashboard — reused here rather than duplicated, see lib/SalesPanels.jsx).
export default function CustomerBooking() {
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
      <TopBar title="Customer Booking" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
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
      </div>
    </>
  );
}

const th = { padding: "9px 10px", borderBottom: "1px solid var(--border)", color: "var(--slate)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 };
const td = { padding: "9px 10px", borderBottom: "1px solid var(--border)" };
