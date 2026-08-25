import { useEffect, useState } from "react";
import { customerPortalRequest, getCustomerSession, setCustomerSession, clearCustomerSession } from "../lib/customerPortalApi.js";
import { generateMixDesignPdf } from "../lib/mixDesignPdf.js";
import { generateCubeTestPdf } from "../lib/cubeTestPdf.js";
import { APP_VERSION } from "../lib/version.js";

// Round 119 — the customer portal (/portal). An EXISTING customer with an
// access code issued by Manager/Admin (see pages/CustomerBooking.jsx's
// "Portal Access" tab) signs in here to see their own orders and QC
// reports (mix design / cube test PDFs, generated with the exact same
// jsPDF code the internal Lab Technician screens use — see
// lib/mixDesignPdf.js / lib/cubeTestPdf.js). Deliberately doesn't use
// TopBar/ProtectedRoute — there's no staff session here, same pattern as
// CustomerTracking.jsx and CustomerBookingForm.jsx, but this one keeps its
// OWN persisted session (see lib/customerPortalApi.js) so "save it for
// auto login next time" (the business's own words) actually works — a
// returning visit re-verifies the stored session token against the server
// on load rather than just trusting it's still good, so a revoked code
// stops working immediately instead of the next time it happens to expire.

const ORDER_STATUS_MAP = {
  planned: { bg: "var(--signal-green-bg)", color: "var(--signal-green)", label: "Scheduled" },
  in_progress: { bg: "var(--info-bg)", color: "var(--info)", label: "Delivery in progress" },
  partially_completed: { bg: "var(--amber-bg)", color: "var(--amber)", label: "Partially delivered" },
  completed: { bg: "var(--signal-green-bg)", color: "var(--signal-green)", label: "Completed" },
  closed: { bg: "var(--concrete)", color: "var(--slate)", label: "Closed" },
  cancelled: { bg: "var(--alert-red-bg)", color: "var(--alert-red)", label: "Cancelled" },
};

export default function CustomerPortal() {
  const [checking, setChecking] = useState(true);
  const [me, setMe] = useState(null); // { customer_name, sites }

  async function verifySession() {
    if (!getCustomerSession()) { setChecking(false); return; }
    try {
      setMe(await customerPortalRequest("/me"));
    } catch {
      clearCustomerSession();
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => { verifySession(); }, []);

  function onSignedIn(data) {
    setMe(data);
  }
  function signOut() {
    clearCustomerSession();
    setMe(null);
  }

  if (checking) return <CenterMessage>Loading...</CenterMessage>;
  if (!me) return <LoginForm onSignedIn={onSignedIn} />;
  return <Dashboard me={me} onSignOut={signOut} />;
}

function LoginForm({ onSignedIn }) {
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      const res = await customerPortalRequest("/login", { method: "POST", body: { token: code } });
      setCustomerSession(res.session_token);
      const me = await customerPortalRequest("/me");
      onSignedIn(me);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell>
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Customer sign-in</div>
        <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4, lineHeight: 1.5 }}>
          Enter the access code your Our Own Ready Mix contact gave you to see your orders and QC reports.
        </div>
      </div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      <form onSubmit={submit} className="card" style={{ marginBottom: 20 }}>
        <label style={{ display: "block", marginBottom: 14 }}>
          <span style={{ fontSize: 12, color: "var(--slate)", marginBottom: 4, display: "block" }}>Access code</span>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            required
            autoCapitalize="characters"
            autoComplete="off"
            placeholder="e.g. K7P2X9QT"
            style={{ fontSize: 18, letterSpacing: 2, textAlign: "center", fontFamily: "ui-monospace, monospace" }}
          />
        </label>
        <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={saving}>
          {saving ? "Signing in..." : "Sign in"}
        </button>
      </form>
      <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center", padding: "0 16px 22px" }}>
        Don't have an account yet? <a href="/inquiry">Request a quote</a> and we'll get in touch.
      </div>
    </Shell>
  );
}

function Dashboard({ me, onSignOut }) {
  const [orders, setOrders] = useState(undefined); // undefined = loading
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState(null);

  async function loadOrders() {
    try {
      setOrders(await customerPortalRequest("/orders"));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { loadOrders(); }, []);

  return (
    <Shell>
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.2 }}>{me.customer_name}</div>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 4 }}>
              {me.sites.map((s) => s.name).join(", ") || "No sites on this code"}
            </div>
          </div>
          <button type="button" onClick={onSignOut} style={{ fontSize: 11.5, padding: "5px 10px" }}>Sign out</button>
        </div>
      </div>

      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}

      <div style={{ fontSize: 14, fontWeight: 700, margin: "4px 0 8px" }}>My orders</div>
      {orders === undefined ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>
      ) : orders.length === 0 ? (
        <div className="card" style={{ marginBottom: 14, fontSize: 12, color: "var(--slate)" }}>
          No orders on file yet for these sites.
        </div>
      ) : (
        orders.map((o) => (
          <OrderCard
            key={o.id}
            order={o}
            expanded={expandedId === o.id}
            onToggle={() => setExpandedId(expandedId === o.id ? null : o.id)}
          />
        ))
      )}

      <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center", padding: "16px 16px 22px", lineHeight: 1.6 }}>
        This sign-in shows only your own orders, for the site(s) your access code covers.<br />
        Shared by Our Own Ready Mix.
      </div>
    </Shell>
  );
}

function OrderCard({ order, expanded, onToggle }) {
  const s = ORDER_STATUS_MAP[order.status] || ORDER_STATUS_MAP.planned;
  const [cubeTests, setCubeTests] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (expanded && cubeTests === undefined) {
      customerPortalRequest(`/orders/${order.id}/cube-tests`)
        .then(setCubeTests)
        .catch((e) => setErr(e.message));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  async function viewMixDesign() {
    setErr(""); setBusy(true);
    try {
      const data = await customerPortalRequest(`/orders/${order.id}/mix-design-pdf-data`);
      await generateMixDesignPdf(data);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function viewCubeTest(resultId) {
    setErr(""); setBusy(true);
    try {
      const data = await customerPortalRequest(`/cube-tests/${resultId}/pdf-data`);
      await generateCubeTestPdf(data);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const canShowMixDesign = order.resolved_mix_design_id && order.mix_design_status === "approved";

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 700 }}>{order.mix_grade_name} · {order.order_quantity_m3} m³</div>
        <span style={{ fontWeight: 700, color: s.color, fontSize: 12 }}>{s.label}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--charcoal)", marginTop: 4 }}>
        {order.site_name} — {new Date(order.order_date).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>
        Delivered so far: {order.delivered_qty_m3} m³
      </div>

      <button type="button" onClick={onToggle} style={{ fontSize: 11.5, padding: "5px 10px", marginTop: 10 }}>
        {expanded ? "Hide QC reports" : "QC reports"}
      </button>

      {expanded && (
        <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          {err && <div style={{ color: "var(--alert-red)", fontSize: 12, marginBottom: 8 }}>{err}</div>}
          <button type="button" onClick={viewMixDesign} disabled={!canShowMixDesign || busy} style={{ fontSize: 12, padding: "6px 10px", marginBottom: 10, width: "100%" }}>
            {canShowMixDesign ? (busy ? "Generating..." : "Download mix design PDF") : "Mix design not available yet"}
          </button>

          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Cube test results</div>
          {cubeTests === undefined ? (
            <div style={{ fontSize: 12, color: "var(--slate)" }}>Loading...</div>
          ) : cubeTests.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--slate)" }}>No cube test results yet for this order.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {cubeTests.map((t) => (
                <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--concrete)", borderRadius: 6, padding: "6px 8px", fontSize: 12 }}>
                  <span>
                    {t.testing_age_days}-day{t.average_strength_mpa ? ` · ${t.average_strength_mpa} N/mm2` : ""}
                    {t.tested_at ? ` · ${new Date(t.tested_at).toLocaleDateString([], { day: "2-digit", month: "short" })}` : ""}
                  </span>
                  <button type="button" onClick={() => viewCubeTest(t.id)} disabled={busy} style={{ fontSize: 11, padding: "3px 8px" }}>PDF</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Shell({ children }) {
  return (
    <div style={{ maxWidth: 460, margin: "0 auto", minHeight: "100vh", background: "var(--concrete)" }}>
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="topbar-title">
          Our Own Ready Mix <span style={{ opacity: 0.6, fontSize: "0.85em" }}>Ver. {APP_VERSION}</span>
          <div style={{ color: "#B8BFC7", fontWeight: 400, fontSize: 12, marginTop: 2 }}>
            Customer portal
          </div>
        </div>
      </div>
      <div style={{ padding: "0 16px" }}>{children}</div>
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
