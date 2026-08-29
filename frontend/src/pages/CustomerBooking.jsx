import { Fragment, useEffect, useState } from "react";
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
  const [ctab, setCtab] = useState(isSalesExec ? "place" : "access");

  return (
    <>
      <TopBar title="Customer Booking" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="tabbar" style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
          {/* Round 122 — the old separate "Booking Links & Requests" and
              "Portal Access" tabs are merged into one: generating access
              now always produces the sign-in code and the per-site
              shareable link(s) together, instead of two tabs for what was,
              from the business's side, one job — see CustomerAccessTab. */}
          {!isSalesExec && (
            <button onClick={() => setCtab("access")} className={ctab === "access" ? "btn-primary" : ""} style={{ fontSize: 12.5, padding: "6px 12px" }}>
              Customer Access
            </button>
          )}
          {!isSalesExec && (
            <button onClick={() => setCtab("techwritings")} className={ctab === "techwritings" ? "btn-primary" : ""} style={{ fontSize: 12.5, padding: "6px 12px" }}>
              Technical Writings
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

        {ctab === "access" && !isSalesExec && <CustomerAccessTab />}
        {ctab === "techwritings" && !isSalesExec && <TechnicalWritingsTab />}
        {ctab === "place" && isSalesExec && <PlaceBookingTab />}
        {ctab === "feedback" && <FeedbackTab isSalesExec={isSalesExec} />}
      </div>
    </>
  );
}

// ===================== CUSTOMER ACCESS (round 122) =====================
// Replaces the old separate "Booking Links & Requests" and "Portal Access"
// tabs with one flow: pick a customer, pick a scope (every current-and-
// future site, or specific sites), set what the login can see, and Generate
// produces the sign-in code AND that site's/those sites' shareable public
// booking-request link(s) together — instead of one tab for the link and a
// second tab for the code, which is what "unify the booking-link/access-code
// flow" meant in practice: two screens for what is, from the business's
// side, a single "give this customer access" action.
//
// Under the hood nothing about customer_booking_links (the public /book/
// :token link + per-site tracking/QC/tech-writings switches) changed — see
// bookingLinks.js. What's new is customer_access_tokens.covers_all_sites
// (schema.sql): a code can now say "every site this customer has, including
// ones added later" instead of a fixed list checked off once, which is the
// actual fix for a company-level contact who should never need a second
// code just because a new site got added.
function CustomerAccessTab() {
  const [customers, setCustomers] = useState([]);
  const [sites, setSites] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [links, setLinks] = useState([]);
  const [customerId, setCustomerId] = useState("");
  const [scope, setScope] = useState("specific"); // "specific" | "all"
  const [siteIds, setSiteIds] = useState([]);
  const [allTracking, setAllTracking] = useState(false);
  const [allQc, setAllQc] = useState(true);
  const [allWritings, setAllWritings] = useState(true);
  const [label, setLabel] = useState("");
  const [generated, setGenerated] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ensuringSiteId, setEnsuringSiteId] = useState(null);
  const [savingPermId, setSavingPermId] = useState(null);
  const [expandedTokenId, setExpandedTokenId] = useState(null);
  const [ensuringTokenId, setEnsuringTokenId] = useState(null);

  async function loadTokens() {
    try {
      setTokens(await apiRequest("/customer-access"));
    } catch (err) {
      setError(err.message);
    }
  }
  async function loadLinks() {
    try {
      const fresh = await apiRequest("/booking-links");
      setLinks(fresh);
      return fresh;
    } catch (err) {
      setError(err.message);
      return [];
    }
  }

  useEffect(() => {
    Promise.all([apiRequest("/master/customers"), apiRequest("/master/sites")])
      .then(([c, s]) => { setCustomers(c); setSites(s); })
      .catch((err) => setError(err.message));
    loadTokens();
    loadLinks();
  }, []);

  const sitesForCustomer = sites.filter((s) => String(s.customer_id) === String(customerId));

  function linkFor(custId, siteId) {
    return links.find((l) => String(l.customer_id) === String(custId) && String(l.site_id) === String(siteId) && l.is_active);
  }

  // Specific-sites mode only — checking a site guarantees a
  // customer_booking_links row exists for it right away so its own toggles
  // are editable immediately, before "Generate access" is even pressed.
  async function toggleSite(id) {
    setSiteIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    if (siteIds.includes(id) || !customerId) return;
    setEnsuringSiteId(id); setError("");
    try {
      const link = await apiRequest("/booking-links/ensure", { method: "POST", body: { customer_id: customerId, site_id: id } });
      setLinks((prev) => (prev.some((l) => l.id === link.id) ? prev.map((l) => (l.id === link.id ? { ...l, ...link, customer_id: customerId, site_id: id } : l)) : [...prev, { ...link, customer_id: customerId, site_id: id }]));
    } catch (err) {
      setError(err.message);
    } finally {
      setEnsuringSiteId(null);
    }
  }

  // Round 128 — a customer_booking_links row only gets auto-created for the
  // "specific sites" checkbox flow at grant-creation time (toggleSite,
  // above). An "all sites" grant, or a site added to a customer after an
  // existing grant was created, never gets one — so opening "Manage sites"
  // on those used to just dead-end on "No booking-link permissions row yet
  // — reopen this after saving once", with no actual reopen-and-save action
  // available. Ensure a link exists for every site under this token the
  // moment the panel opens, using the same /booking-links/ensure call
  // toggleSite already relies on.
  async function ensureSiteLinks(token) {
    const missing = (token.sites || []).filter((s) => !linkFor(token.customer_id, s.id));
    if (missing.length === 0) return;
    setEnsuringTokenId(token.id); setError("");
    try {
      const created = await Promise.all(
        missing.map((s) => apiRequest("/booking-links/ensure", { method: "POST", body: { customer_id: token.customer_id, site_id: s.id } }))
      );
      setLinks((prev) => {
        let next = prev;
        created.forEach((link, i) => {
          const siteId = missing[i].id;
          next = next.some((l) => l.id === link.id)
            ? next.map((l) => (l.id === link.id ? { ...l, ...link, customer_id: token.customer_id, site_id: siteId } : l))
            : [...next, { ...link, customer_id: token.customer_id, site_id: siteId }];
        });
        return next;
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setEnsuringTokenId(null);
    }
  }

  async function setPermission(link, patch) {
    setSavingPermId(link.id); setError("");
    const next = {
      tracking_enabled: link.tracking_enabled, allow_qc_reports: link.allow_qc_reports,
      allow_technical_writings: link.allow_technical_writings, ...patch,
    };
    setLinks((prev) => prev.map((l) => (l.id === link.id ? { ...l, ...next } : l)));
    try {
      await apiRequest(`/booking-links/${link.id}/permissions`, { method: "PATCH", body: next });
    } catch (err) {
      setError(err.message);
      loadLinks();
    } finally {
      setSavingPermId(null);
    }
  }

  async function generate(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      const body = { customer_id: customerId, label };
      if (scope === "all") {
        body.covers_all_sites = true;
        body.tracking_enabled = allTracking;
        body.allow_qc_reports = allQc;
        body.allow_technical_writings = allWritings;
      } else {
        if (siteIds.length === 0) { setError("Choose at least one site."); setSaving(false); return; }
        body.site_ids = siteIds;
      }
      const created = await apiRequest("/customer-access", { method: "POST", body });
      const freshLinks = await loadLinks();
      const coveredSites = scope === "all" ? sitesForCustomer : sitesForCustomer.filter((s) => siteIds.includes(s.id));
      const resultLinks = coveredSites.map((s) => {
        const l = freshLinks.find((x) => String(x.customer_id) === String(customerId) && String(x.site_id) === String(s.id) && x.is_active);
        return { site_name: s.name, url: l ? `${window.location.origin}/book/${l.token}` : null };
      });
      setGenerated({ token: created.token, coversAllSites: scope === "all", links: resultLinks });
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
    if (!window.confirm(`Revoke access for ${token.customer_name}? They won't be able to sign in with this code any more, and any booking links it created keep working unless revoked separately below.`)) return;
    setError("");
    try {
      await apiRequest(`/customer-access/${token.id}/revoke`, { method: "POST" });
      loadTokens();
    } catch (err) {
      setError(err.message);
    }
  }

  async function revokeLink(link) {
    if (!window.confirm(`Revoke the booking link for ${link.customer_name} — ${link.site_name}? The customer won't be able to open it any more.`)) return;
    setError("");
    try {
      await apiRequest(`/booking-links/${link.id}/revoke`, { method: "POST" });
      loadLinks();
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
  const activeLinks = links.filter((l) => l.is_active);

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
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Grant portal access</div>
        <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12, lineHeight: 1.5 }}>
          Generates the customer's sign-in code (typed into /portal) and that site's shareable booking-request
          link(s) together. Send the code yourself, over your own phone (SMS/WhatsApp/call).
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
            <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>Access scope</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px", ...(scope === "all" ? { borderColor: "var(--rebar)", background: "#FCF3EC" } : {}) }}>
                <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} style={{ marginTop: 2 }} />
                <span>
                  <span style={{ fontWeight: 700, display: "block" }}>All sites for this customer</span>
                  <span style={{ fontSize: 11.5, color: "var(--slate)", lineHeight: 1.45 }}>Covers every current site and any added later — right for an owner, PM, or company-level contact.</span>
                </span>
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px", ...(scope === "specific" ? { borderColor: "var(--rebar)", background: "#FCF3EC" } : {}) }}>
                <input type="radio" checked={scope === "specific"} onChange={() => setScope("specific")} style={{ marginTop: 2 }} />
                <span>
                  <span style={{ fontWeight: 700, display: "block" }}>Choose specific sites</span>
                  <span style={{ fontSize: 11.5, color: "var(--slate)", lineHeight: 1.45 }}>Right for a site engineer or contact who should only see one project.</span>
                </span>
              </label>
            </div>
          </div>

          {scope === "all" ? (
            <div style={{ marginBottom: 14 }}>
              <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>What this login can see</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                  <input type="checkbox" checked={allTracking} onChange={(e) => setAllTracking(e.target.checked)} />
                  Live delivery tracking
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                  <input type="checkbox" checked={allQc} onChange={(e) => setAllQc(e.target.checked)} />
                  QC reports
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                  <input type="checkbox" checked={allWritings} onChange={(e) => setAllWritings(e.target.checked)} />
                  Technical writings
                </label>
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>
                Site(s) this code can see
              </span>
              {!customerId ? (
                <div style={{ fontSize: 12, color: "var(--slate)" }}>Select a customer first</div>
              ) : sitesForCustomer.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--slate)" }}>No sites on file for this customer</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 280, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
                  {sitesForCustomer.map((s) => {
                    const checked = siteIds.includes(s.id);
                    const link = linkFor(customerId, s.id);
                    return (
                      <div key={s.id} style={checked ? { borderBottom: "1px solid var(--border)", paddingBottom: 6, marginBottom: 2 } : undefined}>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                          <input type="checkbox" checked={checked} onChange={() => toggleSite(s.id)} />
                          {s.name}
                        </label>
                        {checked && (
                          !link || ensuringSiteId === s.id ? (
                            <div style={{ fontSize: 11, color: "var(--slate)", marginLeft: 22, marginTop: 4 }}>Setting up permissions…</div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginLeft: 22, marginTop: 4 }}>
                              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                                <ToggleSwitch checked={link.tracking_enabled} disabled={savingPermId === link.id} onChange={(v) => setPermission(link, { tracking_enabled: v })} />
                                Live delivery tracking
                              </label>
                              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                                <ToggleSwitch checked={link.allow_qc_reports} disabled={savingPermId === link.id} onChange={(v) => setPermission(link, { allow_qc_reports: v })} />
                                QC reports
                              </label>
                              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                                <ToggleSwitch checked={link.allow_technical_writings} disabled={savingPermId === link.id} onChange={(v) => setPermission(link, { allow_technical_writings: v })} />
                                Technical writings
                              </label>
                            </div>
                          )
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <label style={{ display: "block", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>Label (optional)</span>
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Owner — Suresh Menon" />
          </label>
          <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={saving || !customerId}>
            {saving ? "Generating..." : "Generate access"}
          </button>
        </form>

        {generated && (
          <div style={{ marginTop: 14, background: "var(--concrete)", borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 11, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>Access code — send this to the customer</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <div style={{
                flex: 1, background: "var(--surface)", border: "1px solid var(--border)",
                borderRadius: 8, padding: "10px 12px", fontSize: 18, fontWeight: 700, letterSpacing: 2,
                fontFamily: "ui-monospace, monospace", color: "var(--info)", textAlign: "center",
              }}>
                {generated.token}
              </div>
              <button type="button" onClick={() => copyText(generated.token)} style={{ fontSize: 12 }}>Copy</button>
            </div>
            {generated.coversAllSites && (
              <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 10 }}>Covers all {generated.links.length} current site(s) for this customer, and any added later.</div>
            )}
            {generated.links.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>Booking-request link{generated.links.length === 1 ? "" : "s"}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {generated.links.map((l) => (
                    <div key={l.site_name} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <div style={{ flex: 1, fontSize: 11.5 }}>
                        <b>{l.site_name}</b>
                        {l.url && <div style={{ fontFamily: "ui-monospace, monospace", color: "var(--info)", wordBreak: "break-all" }}>{l.url}</div>}
                      </div>
                      {l.url && <button type="button" onClick={() => copyText(l.url)} style={{ fontSize: 11, padding: "3px 8px" }}>Copy</button>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Active access grants</div>
      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 24 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th style={th}>Customer</th>
              <th style={th}>Covers</th>
              <th style={th}>Code</th>
              <th style={th}>Last used</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {activeTokens.length === 0 && (
              <tr><td colSpan={5} style={{ ...td, color: "var(--slate)" }}>No active access grants yet.</td></tr>
            )}
            {activeTokens.map((t) => (
              <Fragment key={t.id}>
                <tr>
                  <td style={td}>
                    <b>{t.customer_name}</b>
                    {t.label && <div style={{ color: "var(--slate)", fontSize: 11.5 }}>{t.label}</div>}
                  </td>
                  <td style={{ ...td, fontSize: 11.5 }}>
                    {t.covers_all_sites ? (
                      <span className="badge badge-success">All sites ({(t.sites || []).length})</span>
                    ) : (t.sites || []).length === 1 ? (
                      <span className="badge badge-neutral">{t.sites[0].name}</span>
                    ) : (
                      <span className="badge badge-neutral">{(t.sites || []).length} sites</span>
                    )}
                  </td>
                  <td style={td}>
                    <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5, color: "var(--info)", fontWeight: 700 }}>{t.token}</span>{" "}
                    <button type="button" onClick={() => copyText(t.token)} style={{ fontSize: 11, padding: "3px 8px" }}>Copy</button>
                  </td>
                  <td style={{ ...td, color: "var(--slate)" }}>{t.last_used_at ? new Date(t.last_used_at).toLocaleDateString([], { day: "2-digit", month: "short" }) : "Never"}</td>
                  <td style={td}>
                    <span style={{ display: "flex", gap: 4 }}>
                      <button type="button" onClick={() => {
                        const next = expandedTokenId === t.id ? null : t.id;
                        setExpandedTokenId(next);
                        if (next) ensureSiteLinks(t);
                      }} style={{ fontSize: 11.5, padding: "5px 10px" }}>
                        {expandedTokenId === t.id ? "Hide" : "Manage sites"}
                      </button>
                      <button type="button" className="btn-danger" style={{ fontSize: 11.5, padding: "5px 10px" }} onClick={() => revoke(t)}>
                        Revoke
                      </button>
                    </span>
                  </td>
                </tr>
                {expandedTokenId === t.id && (
                  <tr>
                    <td colSpan={5} style={{ ...td, background: "var(--concrete)" }}>
                      {t.covers_all_sites && (
                        <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 8 }}>
                          Covers every site this customer currently has, and any added later — permissions below apply per site, same as a specific-sites grant.
                        </div>
                      )}
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {(t.sites || []).map((s) => {
                          const link = linkFor(t.customer_id, s.id);
                          return (
                            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
                              <b style={{ fontSize: 12.5, minWidth: 120 }}>{s.name}</b>
                              {!link ? (
                                <span style={{ fontSize: 11.5, color: "var(--slate)" }}>
                                  {ensuringTokenId === t.id ? "Setting up access for this site…" : "Couldn't set up access for this site — try Hide, then Manage sites again."}
                                </span>
                              ) : (
                                <>
                                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                                    <ToggleSwitch checked={link.tracking_enabled} disabled={savingPermId === link.id} onChange={(v) => setPermission(link, { tracking_enabled: v })} />
                                    Live tracking
                                  </label>
                                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                                    <ToggleSwitch checked={link.allow_qc_reports} disabled={savingPermId === link.id} onChange={(v) => setPermission(link, { allow_qc_reports: v })} />
                                    QC reports
                                  </label>
                                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                                    <ToggleSwitch checked={link.allow_technical_writings} disabled={savingPermId === link.id} onChange={(v) => setPermission(link, { allow_technical_writings: v })} />
                                    Technical writings
                                  </label>
                                  {link.token && (
                                    <button type="button" onClick={() => copyText(`${window.location.origin}/book/${link.token}`)} style={{ fontSize: 11, padding: "3px 8px" }}>
                                      Copy booking link
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {revokedTokens.length > 0 && (
        <details style={{ marginBottom: 20 }}>
          <summary style={{ fontSize: 12.5, color: "var(--slate)", cursor: "pointer" }}>
            {revokedTokens.length} revoked grant{revokedTokens.length === 1 ? "" : "s"}
          </summary>
          <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <tbody>
                {revokedTokens.map((t) => (
                  <tr key={t.id}>
                    <td style={td}>
                      <b>{t.customer_name}</b>{" "}
                      <span style={{ color: "var(--slate)" }}>— {t.covers_all_sites ? "All sites" : (t.sites || []).map((s) => s.name).join(", ")}</span>
                    </td>
                    <td style={{ ...td, color: "var(--slate)" }}>Revoked {new Date(t.revoked_at).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Advanced fallback — the raw per-site booking-link records
          (customer_booking_links) underneath every access grant above.
          Normally there's no reason to open this: it exists so a link from
          before this round (created with no access code at all, via the
          old standalone "Generate a booking link" flow) can still be found
          and revoked. */}
      <details style={{ marginBottom: 20 }}>
        <summary style={{ fontSize: 12.5, color: "var(--slate)", cursor: "pointer" }}>
          All site links ({activeLinks.length}) — advanced
        </summary>
        <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={th}>Customer / Site</th>
                <th style={th}>Link</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {activeLinks.length === 0 && (
                <tr><td colSpan={3} style={{ ...td, color: "var(--slate)" }}>No site links yet.</td></tr>
              )}
              {activeLinks.map((l) => (
                <tr key={l.id}>
                  <td style={td}><b>{l.customer_name}</b><div style={{ color: "var(--slate)", fontSize: 11.5 }}>{l.site_name}</div></td>
                  <td style={td}>
                    <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5, color: "var(--info)" }}>.../book/{l.token.slice(0, 8)}…</span>{" "}
                    <button type="button" onClick={() => copyText(`${window.location.origin}/book/${l.token}`)} style={{ fontSize: 11, padding: "3px 8px" }}>Copy</button>
                  </td>
                  <td style={td}>
                    <button type="button" className="btn-danger" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => revokeLink(l)}>Revoke</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Incoming requests</div>
      <BookingsQueue setError={setError} />
    </>
  );
}

// Round 119, post-ship — Manager/Admin's library of PDF guides shown to
// customers at a site whose booking link has "Tech. writings" switched on
// (see the Booking Links tab). Upload reads the file client-side
// via FileReader into base64 rather than a real multipart upload — matches
// routes/technicalWritings.js's header comment: this app has no multipart
// middleware anywhere, and base64-over-JSON is the same convention every
// other endpoint already uses.
function TechnicalWritingsTab() {
  const [docs, setDocs] = useState([]);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [renamingId, setRenamingId] = useState(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameCategory, setRenameCategory] = useState("");

  async function load() {
    try {
      setDocs(await apiRequest("/technical-writings"));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  function fileToBase64(f) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",").pop());
      reader.onerror = () => reject(new Error("Couldn't read that file — please try again."));
      reader.readAsDataURL(f);
    });
  }

  async function upload(e) {
    e.preventDefault();
    if (!file) return;
    setError(""); setUploading(true);
    try {
      const data_base64 = await fileToBase64(file);
      await apiRequest("/technical-writings", {
        method: "POST",
        body: { title, category, filename: file.name, mime_type: file.type || "application/pdf", data_base64 },
      });
      setTitle(""); setCategory(""); setFile(null);
      const input = document.getElementById("techwriting-file-input");
      if (input) input.value = "";
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  function startRename(doc) {
    setRenamingId(doc.id);
    setRenameTitle(doc.title);
    setRenameCategory(doc.category || "");
  }

  async function saveRename(doc) {
    setError("");
    try {
      await apiRequest(`/technical-writings/${doc.id}`, {
        method: "PATCH",
        body: { title: renameTitle, category: renameCategory },
      });
      setRenamingId(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(doc) {
    if (!window.confirm(`Delete "${doc.title}"? Customers with access to it won't be able to see it any more.`)) return;
    setError("");
    try {
      await apiRequest(`/technical-writings/${doc.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  function fmtSize(bytes) {
    if (bytes == null) return "—";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 20, maxWidth: 520 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Upload a guide (PDF)</div>
        <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12, lineHeight: 1.5 }}>
          Shown to customers whose access code has "Tech. writings" switched on — e.g. after-pour care,
          choosing the right grade for slabs vs. footings.
        </div>
        <form onSubmit={upload} style={{ fontSize: 13 }}>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>Title</span>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. After-pour curing care" required />
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>Category (optional)</span>
            <input type="text" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Curing & finishing" />
          </label>
          <label style={{ display: "block", marginBottom: 14 }}>
            <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>PDF file (max 8MB)</span>
            <input id="techwriting-file-input" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} required />
          </label>
          <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={uploading || !file || !title.trim()}>
            {uploading ? "Uploading..." : "Upload"}
          </button>
        </form>
      </div>

      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Library</div>
      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 24 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th style={th}>Title</th>
              <th style={th}>Category</th>
              <th style={th}>Size</th>
              <th style={th}>Uploaded</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 && (
              <tr><td colSpan={5} style={{ ...td, color: "var(--slate)" }}>No documents uploaded yet.</td></tr>
            )}
            {docs.map((d) => (
              <tr key={d.id}>
                {renamingId === d.id ? (
                  <>
                    <td style={td}>
                      <input type="text" value={renameTitle} onChange={(e) => setRenameTitle(e.target.value)} style={{ fontSize: 12.5, width: "100%" }} />
                    </td>
                    <td style={td}>
                      <input type="text" value={renameCategory} onChange={(e) => setRenameCategory(e.target.value)} style={{ fontSize: 12.5, width: "100%" }} />
                    </td>
                    <td style={{ ...td, color: "var(--slate)" }}>{fmtSize(d.size_bytes)}</td>
                    <td style={{ ...td, color: "var(--slate)" }}>{new Date(d.created_at).toLocaleDateString([], { day: "2-digit", month: "short" })}</td>
                    <td style={td}>
                      <button type="button" className="btn-primary" style={{ fontSize: 11, padding: "4px 8px", marginRight: 6 }} onClick={() => saveRename(d)}>Save</button>
                      <button type="button" style={{ fontSize: 11, padding: "4px 8px" }} onClick={() => setRenamingId(null)}>Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td style={td}><b>{d.title}</b></td>
                    <td style={{ ...td, color: "var(--slate)" }}>{d.category || "—"}</td>
                    <td style={{ ...td, color: "var(--slate)" }}>{fmtSize(d.size_bytes)}</td>
                    <td style={{ ...td, color: "var(--slate)" }}>{new Date(d.created_at).toLocaleDateString([], { day: "2-digit", month: "short" })}</td>
                    <td style={td}>
                      <button type="button" style={{ fontSize: 11, padding: "4px 8px", marginRight: 6 }} onClick={() => startRename(d)}>Rename</button>
                      <button type="button" className="btn-danger" style={{ fontSize: 11, padding: "4px 8px" }} onClick={() => remove(d)}>Delete</button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600 }}>{f.customer_name}</span>
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {/* Round 119, post-ship again, item 6 — a customer can now
                      submit their own feedback (with a star rating) from the
                      portal's Feedback screen, not just a rep logging it
                      after a visit — both badges make the source obvious. */}
                  {f.submitted_by_customer && <span className="badge badge-info">From customer</span>}
                  {f.rating && <span style={{ fontSize: 12, color: "var(--amber)" }}>{"★".repeat(f.rating)}{"☆".repeat(5 - f.rating)}</span>}
                  <span className={`badge ${f.feedback_type === "complaint" ? "badge-danger" : "badge-success"}`}>{f.feedback_type}</span>
                </span>
              </div>
              <div style={{ color: "var(--slate)" }}>{f.comment}</div>
              <div style={{ color: "var(--slate)", fontSize: 11 }}>
                {new Date(f.created_at).toLocaleDateString([], { day: "2-digit", month: "short" })}
                {!isSalesExec && !f.submitted_by_customer && f.recorded_by_name && ` · Logged by ${f.recorded_by_name}`}
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

// A small pill on/off switch, matching the mockup's per-feature toggle look
// on the Booking Links table — used wherever a single boolean is flipped
// inline in a table row (no separate "Turn X on/off" button needed).
function ToggleSwitch({ checked, disabled, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: "relative", width: 38, height: 21, borderRadius: 999, border: "none",
        background: checked ? "var(--signal-green)" : "var(--border-strong, #ccc)",
        cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1,
        padding: 0, flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute", top: 2, left: checked ? 19 : 2, width: 17, height: 17,
          borderRadius: "50%", background: "#fff", transition: "left 0.12s ease",
          boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
        }}
      />
    </button>
  );
}
