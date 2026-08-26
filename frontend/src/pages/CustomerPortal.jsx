import { useEffect, useState } from "react";
import { customerPortalRequest, getCustomerSession, setCustomerSession, clearCustomerSession } from "../lib/customerPortalApi.js";
import { generateMixDesignPdf } from "../lib/mixDesignPdf.js";
import { generateCubeTestPdf } from "../lib/cubeTestPdf.js";
import { APP_VERSION } from "../lib/version.js";
import { TruckCard } from "../lib/DeliveryTrackingView.jsx";

// Round 119, post-ship — full mockup-fidelity rebuild of the customer
// portal (/portal): bottom tab nav (Home/Orders/Track/More), a Home
// dashboard tile grid, grouped "My Orders", a richer order detail screen
// (4-stage status stepper + "Your team on this order" contacts card), a
// dedicated Track tab, a cross-order "QC & Mix Designs" screen, and the new
// "Order Concrete" self-service request form (named "Request Concrete" in
// the business's own mockup — renamed to "Order Concrete" per explicit
// instruction; everything else about that screen matches the mockup).
//
// Sign-in stays exactly what the business already decided on and had
// working: an access code an existing customer types in (see
// pages/CustomerBooking.jsx's "Portal Access" tab) — NOT the mockup's
// phone+OTP flow. The mockup's other login-screen elements (guest links to
// the public marketing pages, the "Request a free quote" / "Free technical
// assistance" strips) are kept, since those aren't part of the phone/OTP
// question at all.
//
// Deliberately doesn't use TopBar/ProtectedRoute — there's no staff session
// here, same pattern as CustomerTracking.jsx and CustomerBookingForm.jsx —
// and doesn't use react-router sub-routes either: this is one mobile-shell
// SPA with its own tiny internal navigation stack (see PortalShell below),
// matching how the business's own mockup is one continuous phone-screen flow
// rather than a set of browser-addressable pages.

// ===================== small inline icon set (mirrors the mockup's SVGs) =====================
function Icon({ path, size = 18, color = "currentColor", fill = "none", strokeWidth = 2, children }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {children || <path d={path} />}
    </svg>
  );
}
const IconHome = (p) => <Icon {...p}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Icon>;
const IconOrders = (p) => <Icon {...p}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></Icon>;
const IconTrack = (p) => <Icon {...p}><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></Icon>;
const IconMore = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Icon>
);
const IconBack = (p) => <Icon {...p}><polyline points="15 18 9 12 15 6" /></Icon>;
const IconPlus = (p) => <Icon {...p}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></Icon>;
const IconQc = (p) => <Icon {...p}><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></Icon>;
const IconDoc = (p) => <Icon {...p}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></Icon>;
const IconInfo = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></Icon>;
const IconPhone = (p) => (
  <Icon {...p} color="#fff" fill="none">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
  </Icon>
);
const IconChevron = (p) => <Icon {...p}><polyline points="9 18 15 12 9 6" /></Icon>;
const IconBuilding = (p) => <Icon {...p}><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></Icon>;
const IconWritings = (p) => <Icon {...p}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></Icon>;

function initialsOf(name) {
  return (name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}
function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }) : "—";
}
function fmtDateShort(d) {
  return d ? new Date(d).toLocaleDateString([], { day: "2-digit", month: "short" }) : "—";
}
function fmtTime5(t) {
  return t ? String(t).slice(0, 5) : "";
}
function fmtDateTime(ts) {
  return ts ? new Date(ts).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
}
const PUMP_LABELS = { without_pump: "No pump", boom_pump: "Boom pump", line_pump: "Line pump" };

export default function CustomerPortal() {
  const [checking, setChecking] = useState(true);
  const [me, setMe] = useState(null); // { customer_name, sites, permissions }

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

  function onSignedIn(data) { setMe(data); }
  function signOut() { clearCustomerSession(); setMe(null); }

  if (checking) return <CenterMessage>Loading...</CenterMessage>;
  if (!me) return <LoginForm onSignedIn={onSignedIn} />;
  return <PortalShell me={me} onSignOut={signOut} onRefreshMe={() => customerPortalRequest("/me").then(setMe)} />;
}

// ===================== Sign-in =====================
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
    <div className="portal-shell">
      <div className="portal-content" style={{ paddingTop: 26 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 20 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--rebar)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 14, letterSpacing: 0.3, marginBottom: 12 }}>
            OORM
          </div>
          <div style={{ fontSize: 19, fontWeight: 800, textAlign: "center", lineHeight: 1.3 }}>Welcome to OORM</div>
          <div style={{ fontSize: 12.5, color: "var(--slate)", textAlign: "center", marginTop: 6, maxWidth: 280, lineHeight: 1.5 }}>
            Orders, live tracking, QC reports and more — all in one place.
          </div>
        </div>

        <div className="card">
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 9 }}>
            Existing customer
          </div>
          {error && <div style={{ color: "var(--alert-red)", fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
          <form onSubmit={submit}>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              required
              autoCapitalize="characters"
              autoComplete="off"
              placeholder="e.g. K7P2X9QT"
              style={{ width: "100%", fontSize: 17, letterSpacing: 2, textAlign: "center", fontFamily: "ui-monospace, monospace", padding: "12px 13px", border: "1px solid var(--border-strong)", borderRadius: 8, marginBottom: 10, boxSizing: "border-box" }}
            />
            <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={saving}>
              {saving ? "Signing in..." : "Sign in"}
            </button>
          </form>
          <div style={{ fontSize: 10.5, color: "var(--slate)", marginTop: 9, lineHeight: 1.5 }}>
            Your OORM contact gives you this code — it covers your own orders, delivery tracking, and QC reports for
            the site(s) it's set up for.
          </div>
        </div>

        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.4, margin: "20px 0 3px" }}>
          New here? No sign-in needed
        </div>
        <div className="card" style={{ padding: "2px 14px" }}>
          <a href="/services" className="portal-guest-row">
            <div className="portal-guest-ic"><IconBuilding color="#C75B12" /></div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Our services, products &amp; equipment</div>
              <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 1 }}>What we mix, pump and deliver</div>
            </div>
            <IconChevron size={16} color="#C8C2B5" />
          </a>
          <a href="/rmc-vs-sitemix" className="portal-guest-row">
            <div className="portal-guest-ic"><IconInfo color="#C75B12" /></div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Ready-mix vs. site-mix concrete</div>
              <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 1 }}>Why contractors are switching</div>
            </div>
            <IconChevron size={16} color="#C8C2B5" />
          </a>
        </div>

        <a href="/inquiry" className="card" style={{ marginTop: 12, padding: "14px 15px", display: "flex", alignItems: "center", gap: 12, border: "1.5px solid var(--rebar)", background: "#FFF6EF", textDecoration: "none", color: "inherit" }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--rebar)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
            <IconDoc size={20} color="#fff" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800 }}>Request a free quote →</div>
            <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 1 }}>Tell us your project, we'll call you back — usually the same day</div>
          </div>
        </a>

        <a href="/technical-assistance" className="card" style={{ marginTop: 10, padding: "14px 15px", display: "block", textDecoration: "none", color: "inherit" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: "var(--signal-green-bg)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
              <Icon size={18} color="#1D7A55"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></Icon>
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 800 }}>Need free technical assistance?</div>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 6, lineHeight: 1.5 }}>
            Not sure which grade, mix or pumping setup fits your pour? Our team calls you back with a recommendation, no charge.
          </div>
        </a>
      </div>
      <div style={{ textAlign: "center", fontSize: 10.5, color: "var(--slate)", padding: "8px 16px 22px" }}>
        Our Own Ready Mix · Ver. {APP_VERSION}
      </div>
    </div>
  );
}

// ===================== Authenticated shell: tabs + a tiny nav stack =====================
function PortalShell({ me, onSignOut, onRefreshMe }) {
  const [tab, setTab] = useState("home"); // home | orders | track | more
  const [stack, setStack] = useState([{ name: "root" }]); // drill-down screens on top of the current tab's root

  function goTab(t) {
    setTab(t);
    setStack([{ name: "root" }]);
  }
  function push(screen) { setStack((s) => [...s, screen]); }
  function pop() { setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)); }

  const top = stack[stack.length - 1];
  const showBack = stack.length > 1;

  let title = "Our Own Ready Mix";
  let subtitle = me.customer_name;
  if (tab === "orders" && top.name === "root") { title = "My Orders"; subtitle = null; }
  if (tab === "track" && top.name === "root") { title = "Track"; subtitle = null; }
  if (tab === "more" && top.name === "root") { title = "More"; subtitle = null; }
  if (top.name === "order-detail") { title = `Order #${top.id}`; subtitle = top.siteName || null; }
  if (top.name === "booking-detail") { title = `Request #${top.id}`; subtitle = null; }
  if (top.name === "order-tracking") { title = "Live delivery status"; subtitle = top.siteName ? `Order #${top.id} · ${top.siteName}` : `Order #${top.id}`; }
  if (top.name === "order-concrete") { title = "Order Concrete"; subtitle = null; }
  if (top.name === "qc-reports") { title = "QC & Mix Designs"; subtitle = null; }
  if (top.name === "technical-writings") { title = "Technical Writings"; subtitle = null; }

  return (
    <div className="portal-shell">
      <div className="topbar">
        {showBack && (
          <button type="button" className="portal-topbar-back" onClick={pop} aria-label="Back">
            <IconBack color="#fff" />
          </button>
        )}
        <div>
          <div className="topbar-title">{title}</div>
          {subtitle && <div style={{ color: "#B8BFC7", fontWeight: 400, fontSize: 11.5, marginTop: 1 }}>{subtitle}</div>}
        </div>
        {!showBack && tab === "home" && (
          <div className="portal-avatar" style={{ marginLeft: "auto" }}>{initialsOf(me.customer_name)}</div>
        )}
      </div>

      <div className="portal-content">
        {tab === "home" && top.name === "root" && (
          <HomeScreen me={me} onGoTab={goTab} onPush={push} />
        )}
        {tab === "orders" && top.name === "root" && (
          <OrdersScreen onOpenOrder={(id, siteName) => push({ name: "order-detail", id, siteName })} onOpenBooking={(id) => push({ name: "booking-detail", id })} />
        )}
        {tab === "track" && top.name === "root" && (
          <TrackRootScreen onOpenTracking={(id, siteName) => push({ name: "order-tracking", id, siteName })} />
        )}
        {tab === "more" && top.name === "root" && (
          <MoreScreen me={me} onSignOut={onSignOut} onPush={push} />
        )}
        {top.name === "order-detail" && (
          <OrderDetailScreen
            orderId={top.id}
            onOpenTracking={(id, siteName) => push({ name: "order-tracking", id, siteName })}
          />
        )}
        {top.name === "booking-detail" && <BookingDetailScreen bookingId={top.id} />}
        {top.name === "order-tracking" && <OrderTrackingScreen orderId={top.id} />}
        {top.name === "order-concrete" && (
          <OrderConcreteScreen
            me={me}
            onDone={() => { setTab("orders"); setStack([{ name: "root" }]); onRefreshMe(); }}
            onCancel={pop}
          />
        )}
        {top.name === "qc-reports" && <QcReportsScreen />}
        {top.name === "technical-writings" && <TechnicalWritingsScreen />}
      </div>

      <div className="portal-bottomnav">
        <button type="button" className={`portal-navitem${tab === "home" ? " active" : ""}`} onClick={() => goTab("home")}>
          <IconHome size={19} /> Home
        </button>
        <button type="button" className={`portal-navitem${tab === "orders" ? " active" : ""}`} onClick={() => goTab("orders")}>
          <IconOrders size={19} /> Orders
        </button>
        <button type="button" className={`portal-navitem${tab === "track" ? " active" : ""}`} onClick={() => goTab("track")}>
          <IconTrack size={19} /> Track
        </button>
        <button type="button" className={`portal-navitem${tab === "more" ? " active" : ""}`} onClick={() => goTab("more")}>
          <IconMore size={19} /> More
        </button>
      </div>
    </div>
  );
}

// ===================== Home =====================
function HomeScreen({ me, onGoTab, onPush }) {
  const [orders, setOrders] = useState(undefined);
  useEffect(() => { customerPortalRequest("/orders").then(setOrders).catch(() => setOrders([])); }, []);

  const activeCount = orders === undefined ? null : orders.filter((o) => o.group === "active").length;
  const attentionCount = orders === undefined ? null : orders.filter((o) => o.group === "attention").length;
  const totalCount = orders === undefined ? null : orders.length;

  const showTracking = me.permissions?.tracking;
  const showQc = me.permissions?.qc_reports;
  const showWritings = me.permissions?.technical_writings;

  let heroSub = "Sign in any time to check your orders, tracking, and QC reports.";
  if (totalCount) {
    const bits = [];
    if (activeCount) bits.push(`${activeCount} order${activeCount === 1 ? "" : "s"} in progress`);
    if (attentionCount) bits.push(`${attentionCount} need${attentionCount === 1 ? "s" : ""} your attention`);
    if (bits.length) heroSub = bits.join(" · ");
    else heroSub = `${totalCount} order${totalCount === 1 ? "" : "s"} on file with us`;
  }

  return (
    <>
      <div className="portal-hero">
        <div style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.35 }}>Building strong,<br />on schedule.</div>
        <div style={{ fontSize: 11.5, color: "#C9CDD2", marginTop: 6, lineHeight: 1.5 }}>{heroSub}</div>
      </div>

      <div className="portal-tiles">
        <button type="button" className="portal-tile" onClick={() => onGoTab("orders")}>
          <div className="portal-tile-ic"><IconOrders color="#C75B12" size={17} /></div>
          <div className="portal-tile-title">My Orders</div>
          <div className="portal-tile-sub">{totalCount === null ? "Loading..." : `${totalCount} total${activeCount ? ` · ${activeCount} active` : ""}`}</div>
        </button>
        <button type="button" className="portal-tile" onClick={() => onGoTab("track")}>
          <div className="portal-tile-ic"><IconTrack color="#C75B12" size={17} /></div>
          <div className="portal-tile-title">Live Tracking</div>
          <div className="portal-tile-sub">{showTracking ? "See trucks en route" : "Not enabled for your sites"}</div>
        </button>
        <button type="button" className="portal-tile cta" onClick={() => onPush({ name: "order-concrete" })}>
          <div className="portal-tile-ic"><IconPlus color="#fff" size={17} /></div>
          <div className="portal-tile-title">New Order</div>
          <div className="portal-tile-sub">Order concrete</div>
        </button>
        {showQc && (
          <button type="button" className="portal-tile" onClick={() => onPush({ name: "qc-reports" })}>
            <div className="portal-tile-ic"><IconQc color="#C75B12" size={17} /></div>
            <div className="portal-tile-title">QC Reports</div>
            <div className="portal-tile-sub">Test results &amp; mix designs</div>
          </button>
        )}
        {showWritings && (
          <button type="button" className="portal-tile" onClick={() => onPush({ name: "technical-writings" })}>
            <div className="portal-tile-ic"><IconWritings color="#C75B12" size={17} /></div>
            <div className="portal-tile-title">Technical Writings</div>
            <div className="portal-tile-sub">Guides &amp; know-how</div>
          </button>
        )}
      </div>

      <a href="/rmc-vs-sitemix" className="portal-strip">
        <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--concrete)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
          <IconInfo color="#C75B12" size={17} />
        </div>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>Why ready-mix beats site-mix</div>
          <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 1 }}>2-minute read →</div>
        </div>
      </a>
    </>
  );
}

// ===================== Orders (grouped list) =====================
function OrdersScreen({ onOpenOrder, onOpenBooking }) {
  const [orders, setOrders] = useState(undefined);
  const [error, setError] = useState("");
  useEffect(() => { customerPortalRequest("/orders").then(setOrders).catch((e) => setError(e.message)); }, []);

  if (error) return <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (orders === undefined) return <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>;
  if (orders.length === 0) {
    return <div className="card" style={{ fontSize: 12.5, color: "var(--slate)" }}>No orders on file yet for your sites.</div>;
  }

  const groups = [
    { key: "active", label: "In progress" },
    { key: "attention", label: "Needs your attention" },
    { key: "earlier", label: "Earlier" },
  ];

  return (
    <>
      {groups.map((g) => {
        const rows = orders.filter((o) => o.group === g.key);
        if (!rows.length) return null;
        return (
          <div key={g.key}>
            <div className="portal-group-label">{g.label}</div>
            {rows.map((o) => (
              <button
                key={`${o.kind}-${o.id}`}
                type="button"
                className="card portal-order-card"
                onClick={() => (o.kind === "order" ? onOpenOrder(o.id, o.site_name) : onOpenBooking(o.id))}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{o.kind === "order" ? `Order #${o.id}` : `Request #${o.id}`}</div>
                    <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>{o.site_name || "Site not yet set"}</div>
                  </div>
                  <span className={`badge badge-${o.tone}`}>{o.label}</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 8 }}>
                  {o.mix_grade_name || "Grade TBD"} · {o.qty_m3 ? `${o.qty_m3} m³` : "Qty TBD"} · {fmtDate(o.order_date)}
                  {o.scheduled_batching_time ? `, ${fmtTime5(o.scheduled_batching_time)}` : ""}
                </div>
                {o.kind === "booking" && o.declined_reason && (
                  <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 4 }}>Reason: {o.declined_reason}</div>
                )}
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
}

// ===================== Booking (pre-order) detail =====================
function BookingDetailScreen({ bookingId }) {
  const [b, setB] = useState(undefined);
  const [error, setError] = useState("");
  useEffect(() => { customerPortalRequest(`/booking-requests/${bookingId}`).then(setB).catch((e) => setError(e.message)); }, [bookingId]);

  if (error) return <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (b === undefined) return <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>;

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--slate)" }}>{b.mix_grade_name || "Grade TBD"} · {b.estimated_qty_m3 ? `${b.estimated_qty_m3} m³` : "Qty TBD"}</div>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 2 }}>{b.site_name || "Site not yet set"}</div>
        </div>
        <span className={`badge badge-${b.status === "declined" ? "danger" : "warning"}`}>{b.status === "declined" ? "Declined" : "Under Review"}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--slate)", lineHeight: 1.8 }}>
        {b.preferred_date && <div>Preferred: {fmtDate(b.preferred_date)}{b.preferred_time ? `, ${fmtTime5(b.preferred_time)}` : ""}</div>}
        {b.pump_requirement && <div>Pump: {PUMP_LABELS[b.pump_requirement] || b.pump_requirement}</div>}
        {b.casting_location && <div>Casting location: {b.casting_location}</div>}
        {b.notes && <div>Notes: "{b.notes}"</div>}
        <div>Submitted: {fmtDateTime(b.created_at)}</div>
      </div>
      {b.status === "declined" && b.declined_reason && (
        <div style={{ marginTop: 10, background: "var(--alert-red-bg)", color: "var(--alert-red)", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>
          {b.declined_reason}
        </div>
      )}
      {b.status === "pending" && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--slate)", lineHeight: 1.5 }}>
          We'll notify you here once this is scheduled — it'll then show up as a full order with live tracking (if enabled for this site).
        </div>
      )}
    </div>
  );
}

// ===================== Order detail =====================
function OrderDetailScreen({ orderId, onOpenTracking }) {
  const [order, setOrder] = useState(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cubeTests, setCubeTests] = useState(undefined);

  function load() {
    customerPortalRequest(`/orders/${orderId}`).then(setOrder).catch((e) => setError(e.message));
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [orderId]);
  useEffect(() => {
    if (order?.qc_allowed && cubeTests === undefined) {
      customerPortalRequest(`/orders/${orderId}/cube-tests`).then(setCubeTests).catch(() => setCubeTests([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order]);

  if (error) return <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (order === undefined) return <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>;

  async function viewMixDesign() {
    setError(""); setBusy(true);
    try {
      const data = await customerPortalRequest(`/orders/${orderId}/mix-design-pdf-data`);
      await generateMixDesignPdf(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function viewCubeTest(resultId) {
    setError(""); setBusy(true);
    try {
      const data = await customerPortalRequest(`/cube-tests/${resultId}/pdf-data`);
      await generateCubeTestPdf(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // 4-stage status stepper: Under Review -> Accepted & Scheduled -> In
  // Progress -> Completed/Closed. A cancelled order doesn't map cleanly
  // onto this progression, so it gets its own simple banner instead.
  const currentStepIndex =
    order.status === "in_progress" || order.status === "partially_completed" ? 2 :
    order.status === "completed" || order.status === "closed" ? 3 : 1;

  const canShowMixDesign = order.resolved_mix_design_id && order.qc_allowed;

  return (
    <>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 12.5, marginBottom: 10 }}>{error}</div>}

      <div className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--slate)" }}>{order.mix_grade_name} · {order.order_quantity_m3} m³</div>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 2 }}>Scheduled {fmtDate(order.order_date)}, {fmtTime5(order.scheduled_batching_time)}</div>
          <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>Delivered so far: {order.delivered_qty_m3} m³</div>
        </div>
        <span className={`badge badge-${order.status_tone}`}>{order.display_status}</span>
      </div>

      {order.status !== "cancelled" ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="portal-sec-title">Order status</div>
          <div className="portal-step">
            <div className="portal-step-dot done"><IconCheck /></div>
            <div className="portal-step-label">Under Review</div>
            <div className="portal-step-meta">Reviewed {fmtDateTime(order.reviewed_at)}</div>
          </div>
          <div className="portal-step">
            <div className={`portal-step-dot ${currentStepIndex > 1 ? "done" : "current"}`}>{currentStepIndex > 1 ? <IconCheck /> : "●"}</div>
            <div className="portal-step-label">Accepted &amp; Scheduled</div>
            <div className="portal-step-meta">Confirmed for {fmtDate(order.order_date)}, {fmtTime5(order.scheduled_batching_time)}</div>
          </div>
          <div className="portal-step">
            <div className={`portal-step-dot ${currentStepIndex > 2 ? "done" : currentStepIndex === 2 ? "current" : "future"}`}>
              {currentStepIndex > 2 ? <IconCheck /> : currentStepIndex === 2 ? "●" : ""}
            </div>
            <div className={`portal-step-label${currentStepIndex < 2 ? " future" : ""}`}>In Progress</div>
            {currentStepIndex === 2 && <div className="portal-step-meta">Delivery underway{order.tracking_allowed ? " — see live tracking below" : ""}</div>}
          </div>
          <div className="portal-step">
            <div className={`portal-step-dot ${currentStepIndex > 3 ? "done" : currentStepIndex === 3 ? "done" : "future"}`}>
              {currentStepIndex >= 3 ? <IconCheck /> : ""}
            </div>
            <div className={`portal-step-label${currentStepIndex < 3 ? " future" : ""}`}>Completed / Closed</div>
            {currentStepIndex === 3 && order.terminal_at && <div className="portal-step-meta">{fmtDateTime(order.terminal_at)}</div>}
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 12, background: "var(--alert-red-bg)" }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--alert-red)" }}>Cancelled</div>
        </div>
      )}

      {order.is_rescheduled && (
        <div className="card" style={{ marginBottom: 12, background: "var(--amber-bg)", borderColor: "#E8D8AE" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span className="badge badge-warning" style={{ flex: "none" }}>Rescheduled</span>
            <div style={{ fontSize: 12, color: "#6B4C0C", lineHeight: 1.5 }}>
              Originally {fmtDate(order.original_order_date)}{order.original_scheduled_batching_time ? `, ${fmtTime5(order.original_scheduled_batching_time)}` : ""} → moved to {fmtDate(order.order_date)}, {fmtTime5(order.scheduled_batching_time)}.
              {order.reschedule_reason ? ` Reason: ${order.reschedule_reason}.` : ""}
            </div>
          </div>
        </div>
      )}

      {order.tracking_allowed && (order.status === "in_progress" || order.status === "partially_completed") && (
        <button type="button" className="btn-primary" style={{ width: "100%", marginBottom: 12 }} onClick={() => onOpenTracking(order.id, order.site_name)}>
          Track this delivery
        </button>
      )}

      {order.contacts?.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="portal-sec-title">Your team on this order</div>
          {order.contacts.map((c, i) => (
            <div key={i} className={`portal-contact-row${c.highlight ? " highlight" : ""}`}>
              <div className="portal-contact-avatar">{initialsOf(c.name)}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{c.name}</div>
                <div style={{ fontSize: 11.5, color: c.highlight ? "var(--signal-green)" : "var(--slate)", fontWeight: c.highlight ? 700 : 400 }}>{c.role}</div>
              </div>
              {c.phone && (
                <a href={`tel:${c.phone}`} className="portal-callbtn"><IconPhone size={15} /></a>
              )}
            </div>
          ))}
        </div>
      )}

      {order.qc_allowed && (
        <div className="card">
          <div className="portal-sec-title">QC reports for this order</div>
          <button type="button" onClick={viewMixDesign} disabled={!canShowMixDesign || busy} style={{ fontSize: 12, padding: "8px 10px", marginBottom: 10, width: "100%" }}>
            {canShowMixDesign ? (busy ? "Generating..." : "View approved mix design PDF") : "Mix design not available yet"}
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
                    {t.testing_age_days}-day{t.average_strength_mpa ? ` · ${t.average_strength_mpa} N/mm²` : ""}
                    {t.tested_at ? ` · ${fmtDateShort(t.tested_at)}` : ""}
                  </span>
                  <button type="button" onClick={() => viewCubeTest(t.id)} disabled={busy} style={{ fontSize: 11, padding: "3px 8px" }}>PDF</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function IconCheck() {
  return <Icon size={12} color="#fff" strokeWidth={3}><polyline points="20 6 9 17 4 12" /></Icon>;
}

// ===================== Track =====================
function TrackRootScreen({ onOpenTracking }) {
  const [orders, setOrders] = useState(undefined);
  useEffect(() => { customerPortalRequest("/orders").then(setOrders).catch(() => setOrders([])); }, []);

  if (orders === undefined) return <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>;

  const trackable = orders.filter((o) => o.kind === "order" && (o.raw_status === "in_progress" || o.raw_status === "partially_completed"));

  if (trackable.length === 0) {
    return (
      <div className="card" style={{ fontSize: 12.5, color: "var(--slate)", textAlign: "center", padding: "24px 16px" }}>
        No deliveries in progress right now. Once an order is on its way, it'll show up here with live truck status.
      </div>
    );
  }

  return (
    <>
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 12, lineHeight: 1.5 }}>Tap an order to see live truck-by-truck status.</div>
      {trackable.map((o) => (
        <button key={o.id} type="button" className="card portal-order-card" onClick={() => onOpenTracking(o.id, o.site_name)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Order #{o.id}</div>
              <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 2 }}>{o.site_name}</div>
            </div>
            <span className={`badge badge-${o.tone}`}>{o.label}</span>
          </div>
        </button>
      ))}
    </>
  );
}

function OrderTrackingScreen({ orderId }) {
  const [tracking, setTracking] = useState(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    function load() {
      customerPortalRequest(`/orders/${orderId}/tracking`)
        .then((d) => { if (!cancelled) { setTracking(d); setError(""); } })
        .catch((e) => { if (!cancelled) setError(e.message); });
    }
    load();
    const t = setInterval(load, 20000);
    return () => { cancelled = true; clearInterval(t); };
  }, [orderId]);

  if (error) {
    return (
      <div className="card" style={{ fontSize: 12.5, color: "var(--slate)", textAlign: "center", padding: "20px 16px" }}>
        {error === "No live tracking available for this order right now." ? "No live tracking to show yet for this order." : error}
      </div>
    );
  }
  if (tracking === undefined) return <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>;

  const trucks = tracking.trucks.filter((t) => t.status !== "rejected");
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11, color: "var(--slate)", marginBottom: 12 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--signal-green)" }} /> Updates automatically
      </div>
      {trucks.length === 0 ? (
        <div className="card" style={{ fontSize: 12.5, color: "var(--slate)" }}>No trucks dispatched on this order yet.</div>
      ) : (
        trucks.map((t) => <TruckCard key={t.ticket_number} truck={t} />)
      )}
    </>
  );
}

// ===================== More =====================
function MoreScreen({ me, onSignOut, onPush }) {
  const showQc = me.permissions?.qc_reports;
  const showWritings = me.permissions?.technical_writings;
  return (
    <>
      <div className="card" style={{ padding: "2px 14px", marginBottom: 16 }}>
        {showQc && (
          <button type="button" className="portal-more-row" onClick={() => onPush({ name: "qc-reports" })}>
            <div className="portal-more-ic"><IconQc color="#C75B12" size={17} /></div>
            <div style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>QC &amp; Mix Designs</div>
            <IconChevron size={16} color="#C8C2B5" />
          </button>
        )}
        {showWritings && (
          <button type="button" className="portal-more-row" onClick={() => onPush({ name: "technical-writings" })}>
            <div className="portal-more-ic"><IconWritings color="#C75B12" size={17} /></div>
            <div style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>Technical Writings</div>
            <IconChevron size={16} color="#C8C2B5" />
          </button>
        )}
        <a href="/services" className="portal-more-row" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="portal-more-ic"><IconBuilding color="#C75B12" size={17} /></div>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>Services, Products &amp; Equipment</div>
          <IconChevron size={16} color="#C8C2B5" />
        </a>
        <a href="/rmc-vs-sitemix" className="portal-more-row" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="portal-more-ic"><IconInfo color="#C75B12" size={17} /></div>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>Ready-mix vs. Site-mix</div>
          <IconChevron size={16} color="#C8C2B5" />
        </a>
        <a href="/technical-assistance" className="portal-more-row" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="portal-more-ic">
            <Icon size={17} color="#C75B12"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></Icon>
          </div>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>Free Technical Assistance</div>
          <IconChevron size={16} color="#C8C2B5" />
        </a>
        <a href="/inquiry" className="portal-more-row" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="portal-more-ic"><IconDoc color="#C75B12" size={17} /></div>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>Request a Quote</div>
          <IconChevron size={16} color="#C8C2B5" />
        </a>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{me.customer_name}</div>
        <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 4 }}>{me.sites.map((s) => s.name).join(", ") || "No sites on this code"}</div>
        <button type="button" onClick={onSignOut} style={{ marginTop: 12, width: "100%", fontSize: 12.5 }}>Sign out</button>
      </div>

      <div style={{ textAlign: "center", fontSize: 10.5, color: "var(--slate)" }}>Our Own Ready Mix · Ver. {APP_VERSION}</div>
    </>
  );
}

// ===================== QC & Mix Designs (cross-order) =====================
function QcReportsScreen() {
  const [data, setData] = useState(undefined);
  const [tab, setTabState] = useState("tests");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { customerPortalRequest("/qc-reports").then(setData).catch((e) => setError(e.message)); }, []);

  async function viewCubeTest(resultId) {
    setError(""); setBusy(true);
    try {
      const d = await customerPortalRequest(`/cube-tests/${resultId}/pdf-data`);
      await generateCubeTestPdf(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function viewMixDesign(orderId) {
    setError(""); setBusy(true);
    try {
      const d = await customerPortalRequest(`/orders/${orderId}/mix-design-pdf-data`);
      await generateMixDesignPdf(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (data === undefined) return <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>;

  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button type="button" className={`btn-tab${tab === "tests" ? " active" : ""}`} style={{ flex: 1, fontSize: 12 }} onClick={() => setTabState("tests")}>Test Results</button>
        <button type="button" className={`btn-tab${tab === "designs" ? " active" : ""}`} style={{ flex: 1, fontSize: 12 }} onClick={() => setTabState("designs")}>Approved Mix Designs</button>
      </div>

      {tab === "tests" ? (
        data.cube_tests.length === 0 ? (
          <div className="card" style={{ fontSize: 12.5, color: "var(--slate)" }}>No cube test results yet.</div>
        ) : (
          data.cube_tests.map((t) => (
            <div key={t.id} className="card" style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontWeight: 700, fontSize: 12.5 }}>Order #{t.order_id} · {t.site_name}</div>
                <span style={{ fontSize: 11, color: "var(--slate)" }}>{fmtDateShort(t.tested_at)}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 4 }}>
                {t.mix_grade_name} · {t.testing_age_days}-day{t.average_strength_mpa ? ` · ${t.average_strength_mpa} N/mm²` : ""}
              </div>
              <button type="button" onClick={() => viewCubeTest(t.id)} disabled={busy} style={{ fontSize: 11.5, padding: "5px 10px", marginTop: 8 }}>View PDF</button>
            </div>
          ))
        )
      ) : (
        data.mix_designs.length === 0 ? (
          <div className="card" style={{ fontSize: 12.5, color: "var(--slate)" }}>No approved mix designs on file yet.</div>
        ) : (
          data.mix_designs.map((m) => (
            <div key={m.order_id} className="card" style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontWeight: 700, fontSize: 12.5 }}>{m.mix_grade_name}{m.design_ref_code ? ` · ${m.design_ref_code}` : ""}</div>
                <span className="badge badge-success">Approved</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 4 }}>{m.site_name}</div>
              <button type="button" onClick={() => viewMixDesign(m.order_id)} disabled={busy} style={{ fontSize: 11.5, padding: "5px 10px", marginTop: 8 }}>View PDF</button>
            </div>
          ))
        )
      )}
    </>
  );
}

// ===================== Technical Writings (full screen) =====================
function TechnicalWritingsScreen() {
  const [docs, setDocs] = useState(undefined);
  const [error, setError] = useState("");
  const [openingId, setOpeningId] = useState(null);

  useEffect(() => { customerPortalRequest("/technical-writings").then(setDocs).catch((e) => setError(e.message)); }, []);

  async function openDoc(doc) {
    setError(""); setOpeningId(doc.id);
    try {
      const file = await customerPortalRequest(`/technical-writings/${doc.id}/file`);
      const bytes = Uint8Array.from(atob(file.data_base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: file.mime_type || "application/pdf" });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank");
      if (!win) window.location.assign(url);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(err.message);
    } finally {
      setOpeningId(null);
    }
  }

  if (error) return <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (docs === undefined) return <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>;

  return (
    <>
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 14, lineHeight: 1.5 }}>Documents uploaded by our QC &amp; engineering team — tap any to view the PDF.</div>
      {docs.length === 0 ? (
        <div className="card" style={{ fontSize: 12.5, color: "var(--slate)" }}>No guides available yet.</div>
      ) : (
        docs.map((d) => (
          <button key={d.id} type="button" className="card" style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10, width: "100%", textAlign: "left" }} onClick={() => openDoc(d)} disabled={openingId === d.id}>
            <div style={{ width: 40, height: 48, borderRadius: 5, background: "var(--alert-red-bg)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
              <IconDoc color="#B03A2E" size={18} />
            </div>
            <div style={{ flex: 1 }}>
              {d.category && <span style={{ fontSize: 10.5, fontWeight: 700, background: "var(--concrete)", color: "var(--slate)", padding: "2px 8px", borderRadius: 10 }}>{d.category}</span>}
              <div style={{ fontWeight: 700, fontSize: 13.5, marginTop: 5 }}>{d.title}</div>
              <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 3 }}>{openingId === d.id ? "Opening..." : (d.filename || "")}</div>
            </div>
          </button>
        ))
      )}
    </>
  );
}

// ===================== Order Concrete (self-service request) =====================
function OrderConcreteScreen({ me, onDone, onCancel }) {
  const [mixGrades, setMixGrades] = useState([]);
  const [siteId, setSiteId] = useState(me.sites[0]?.id || "");
  const [mixGradeId, setMixGradeId] = useState("");
  const [qty, setQty] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [pump, setPump] = useState("without_pump");
  const [castingLocation, setCastingLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { customerPortalRequest("/mix-grades").then(setMixGrades).catch(() => setMixGrades([])); }, []);

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await customerPortalRequest("/orders", {
        method: "POST",
        body: {
          site_id: siteId, mix_grade_id: mixGradeId, estimated_qty_m3: qty,
          preferred_date: date, preferred_time: time, pump_requirement: pump,
          casting_location: castingLocation || null, notes: notes || null,
        },
      });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      {error && <div style={{ color: "var(--alert-red)", fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
      <form onSubmit={submit}>
        <label className="portal-field-label">Site</label>
        <select value={siteId} onChange={(e) => setSiteId(e.target.value)} required style={{ width: "100%" }}>
          <option value="">Select</option>
          {me.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 13 }}>
          <div>
            <label className="portal-field-label" style={{ marginTop: 0 }}>Mix grade</label>
            <select value={mixGradeId} onChange={(e) => setMixGradeId(e.target.value)} required style={{ width: "100%" }}>
              <option value="">Select</option>
              {mixGrades.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <label className="portal-field-label" style={{ marginTop: 0 }}>Quantity (m³)</label>
            <input type="number" min="0.5" step="0.5" value={qty} onChange={(e) => setQty(e.target.value)} required placeholder="e.g. 20" style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
        </div>
        <div style={{ fontSize: 10.5, color: "var(--slate)", marginTop: 6, lineHeight: 1.5 }}>
          We'll batch to your standard approved mix on file for this grade.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 13 }}>
          <div>
            <label className="portal-field-label" style={{ marginTop: 0 }}>Date needed</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
          <div>
            <label className="portal-field-label" style={{ marginTop: 0 }}>Time</label>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
        </div>

        <label className="portal-field-label">Pump required?</label>
        <div className="portal-seg">
          {[["without_pump", "No pump"], ["boom_pump", "Boom pump"], ["line_pump", "Line pump"]].map(([val, lbl]) => (
            <button key={val} type="button" className={`portal-segopt${pump === val ? " selected" : ""}`} onClick={() => setPump(val)}>{lbl}</button>
          ))}
        </div>

        <label className="portal-field-label">Casting location on site</label>
        <input type="text" value={castingLocation} onChange={(e) => setCastingLocation(e.target.value)} placeholder="e.g. 3rd floor slab, block B" style={{ width: "100%", boxSizing: "border-box" }} />

        <label className="portal-field-label">Notes (optional)</label>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: "100%", boxSizing: "border-box", padding: "9px 10px", fontFamily: "inherit", fontSize: 13, border: "1px solid var(--border-strong)", borderRadius: 8 }} />

        <button type="submit" className="btn-primary" style={{ width: "100%", marginTop: 18 }} disabled={saving}>
          {saving ? "Submitting..." : "Submit request"}
        </button>
        <button type="button" onClick={onCancel} style={{ width: "100%", marginTop: 8 }} disabled={saving}>Cancel</button>
        <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center", marginTop: 9, lineHeight: 1.5 }}>
          Goes to our team as "Under Review" — you'll see it in My Orders and get updates as it's scheduled.
        </div>
      </form>
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
