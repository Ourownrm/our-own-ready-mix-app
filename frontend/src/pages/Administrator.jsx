// Round 143 — the Administrator dashboard rebuilt as an icon view, from the
// approved "Admin Dashboard — Icon View" mockup and
// claude/admin-dashboard-icon-view-notes.md.
//
// What it replaces: five `GroupedMenu` dropdowns plus a "Users and roles" tab,
// where every screen was two clicks and you had to remember which menu held
// which. Now: KPIs, a pinned row, then eight module tiles; a module either
// opens its screen directly or opens a sub-grid, and every sub-level has a
// visible Back.
//
// Three levels, all driven by the URL rather than local state, so the
// browser's back button, a refresh and a bookmarked link all behave:
//   /administrator                      home (KPIs, pinned, modules)
//   /administrator?module=production    that module's sub-grid
//   /administrator?view=customers       a panel rendered in place
// A screen in the registry carries EITHER `to` (navigate away) or `view` (one
// of the panels below) — never both.
//
// The labels, icons, colours and destinations all live in
// lib/adminScreens.js. Nothing here hard-codes a screen: the same registry is
// what the Super Admin per-user permission work will switch tiles on and off
// from, and keeping it in one place is how three screens that were reachable
// by route but missing from the old menu (Cube Test Report, the Manager
// dashboard, the Lab Technician screen) stop happening again.
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { CustomersPanel, SitesPanel, RatesPanel, FleetPanel, SalespersonsPanel, FuelStationsAndEquipmentPanel, PlantLocationsPanel, SiteGeofenceReportPanel, SiteContactsPanel, ProductionTargetPanel, MixDesignAssignmentsPanel, MixDesignsPanel, MaintenanceActionPointsPanel, OrdersPanel as SharedOrdersPanel, TicketsPanel as SharedTicketsPanel } from "../lib/MasterDataPanels.jsx";
import { CreateLeadForm } from "../lib/SalesPanels.jsx";
import { ADMIN_MODULES, ALL_SCREENS, SCREEN_BY_KEY, GLYPHS, DEFAULT_PINS, moduleByKey, moduleBadge } from "../lib/adminScreens.js";

const ROLES = ["administrator", "manager", "plant_operator", "qc_engineer", "lab_technician", "driver", "site_supervisor", "accountant", "sales_executive", "store", "loader_operator"];
const MAX_PINS = 8;

// ===================== Small shared pieces =====================

// The glyph bodies in adminScreens.js are static authored markup — no user
// input reaches them — so setting them as inner SVG is safe and saves ~35
// hand-written components.
function Glyph({ name, size = 24 }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: GLYPHS[name] || "" }}
    />
  );
}

function Badge({ count, ring = "var(--concrete)" }) {
  if (!count) return null;
  return (
    <span style={{
      position: "absolute", top: -6, right: -6, minWidth: 20, height: 20, padding: "0 5px",
      boxSizing: "border-box", borderRadius: 10, background: "var(--alert-red)", color: "#fff",
      fontSize: 11, fontWeight: 700, lineHeight: "20px", textAlign: "center", border: `2px solid ${ring}`,
    }}>{count}</span>
  );
}

function fmtM3(n) {
  if (n === null || n === undefined) return "–";
  return `${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 1 })} m³`;
}
function fmtMoney(n) {
  if (n === null || n === undefined) return "–";
  const v = Number(n);
  // Lakhs/crores, the way the plant actually talks about a collection figure.
  if (Math.abs(v) >= 10000000) return `${v < 0 ? "-" : ""}₹${(Math.abs(v) / 10000000).toFixed(2)} Cr`;
  if (Math.abs(v) >= 100000) return `${v < 0 ? "-" : ""}₹${(Math.abs(v) / 100000).toFixed(2)} L`;
  return `${v < 0 ? "-" : ""}₹${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function KpiTile({ label, value, sub, colour }) {
  return (
    <div style={{ background: colour, color: "#fff", borderRadius: 12, padding: "12px 15px" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, opacity: 0.85 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 3, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 10.5, opacity: 0.85, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

function KpiRow({ kpis }) {
  const k = kpis || {};
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 18 }}>
      <KpiTile
        label="Today's Order"
        value={kpis ? fmtM3(k.orders_today_m3) : "…"}
        sub={kpis ? `${k.orders_today_count} order${k.orders_today_count === 1 ? "" : "s"} booked` : ""}
        colour="#1F6FB2"
      />
      <KpiTile
        label="Today's Production"
        value={kpis ? fmtM3(k.production_today_m3) : "…"}
        sub={kpis
          ? `${k.challan_today_tickets} challan${k.challan_today_tickets === 1 ? "" : "s"}${k.rejected_today_m3 ? ` · ${fmtM3(k.rejected_today_m3)} rejected` : ""}`
          : ""}
        colour="var(--rebar)"
      />
      <KpiTile
        label="Monthly Achieved"
        value={kpis ? fmtM3(k.month_production_m3) : "…"}
        sub={kpis ? (k.month_target_m3 ? `of ${fmtM3(k.month_target_m3)} target · ${Math.round(k.month_target_pct)}%` : "no target set this month") : ""}
        colour="#2F7D6E"
      />
      <KpiTile
        label="Outstanding Collection"
        value={kpis ? fmtMoney(k.outstanding_total) : "…"}
        sub={kpis ? `${k.outstanding_overdue_30_plus} over 30 days` : ""}
        colour="var(--alert-red)"
      />
    </div>
  );
}

// ===================== Tiles =====================

function ModuleTile({ module, badge, onOpen }) {
  const sub = module.screens.length ? `${module.screens.length} screens` : "opens straight away";
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ background: "none", border: "none", padding: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, cursor: "pointer", font: "inherit", color: "var(--charcoal)" }}
    >
      <span style={{ position: "relative", display: "block" }}>
        <span style={{ width: 72, height: 72, borderRadius: 19, background: module.colour, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
          <Glyph name={module.icon} size={34} />
        </span>
        <Badge count={badge} />
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 600, textAlign: "center", lineHeight: 1.25 }}>{module.label}</span>
      <span style={{ fontSize: 10, color: "var(--slate)", textAlign: "center" }}>{sub}</span>
    </button>
  );
}

function ScreenTile({ screen, badge, onOpen, size = 58, ring = "#fff" }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ background: "none", border: "none", padding: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, cursor: "pointer", font: "inherit", color: "var(--charcoal)" }}
    >
      <span style={{ position: "relative", display: "block" }}>
        <span style={{ width: size, height: size, borderRadius: Math.round(size / 4), background: screen.tint, border: `1px solid ${screen.colour}33`, display: "flex", alignItems: "center", justifyContent: "center", color: screen.colour }}>
          <Glyph name={screen.icon} size={Math.round(size * 0.44)} />
        </span>
        <Badge count={badge} ring={ring} />
      </span>
      <span style={{ fontSize: 11, lineHeight: 1.25, textAlign: "center" }}>{screen.label}</span>
    </button>
  );
}

const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: "18px 8px", alignItems: "start" };

function BackBar({ trail, onBack }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
      <button type="button" onClick={onBack} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        Back
      </button>
      <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{trail}</div>
    </div>
  );
}

// ===================== Page =====================

export default function Administrator() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("view");
  const moduleKey = searchParams.get("module");
  const [error, setError] = useState("");

  const [summary, setSummary] = useState(null);
  const [pins, setPins] = useState(DEFAULT_PINS);
  const [editingPins, setEditingPins] = useState(false);

  useEffect(() => {
    apiRequest("/admin-dashboard/summary").then(setSummary).catch((err) => setError(err.message));
    apiRequest("/admin-dashboard/pins")
      // A user who has never changed their pins has no row — fall back to the
      // default set rather than showing an empty strip.
      .then((d) => setPins(d.keys && d.keys.length ? d.keys : DEFAULT_PINS))
      .catch(() => {});
  }, []);

  function openScreen(screen) {
    if (screen.to) { navigate(screen.to); return; }
    setSearchParams({ view: screen.view }, { replace: false });
  }
  function openModule(module) {
    if (!module.screens.length) { openScreen(module); return; }
    setSearchParams({ module: module.key }, { replace: false });
  }
  function goHome() { setSearchParams({}, { replace: false }); }

  const badges = summary ? summary.badges : null;
  const activeModule = moduleKey ? moduleByKey(moduleKey) : null;
  // A panel's Back goes to the module it was opened from, not blindly home —
  // an Administrator correcting three tickets in a row should land back in
  // Production each time.
  const viewScreen = view ? ALL_SCREENS.find((s) => s.view === view) : null;
  const viewModule = viewScreen ? moduleByKey(viewScreen.moduleKey) : null;

  // Keys a screen key can be pinned under, for the picker.
  const pinnedScreens = pins.map((k) => SCREEN_BY_KEY[k]).filter(Boolean);

  return (
    <>
      <TopBar title="Administrator" />
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}

        {/* ---------- a panel, rendered in place ---------- */}
        {view && (
          <>
            <BackBar
              trail={<>Dashboard {viewModule && viewModule.screens.length ? <>&rsaquo; {viewModule.label} </> : null}&rsaquo; <b style={{ color: "var(--charcoal)" }}>{viewScreen ? viewScreen.label : view}</b></>}
              onBack={() => (viewModule && viewModule.screens.length ? setSearchParams({ module: viewModule.key }) : goHome())}
            />
            {view === "users" && <UsersPanel setError={setError} />}
            {view === "customers" && <CustomersPanel setError={setError} />}
            {view === "sites" && <SitesPanel setError={setError} />}
            {view === "fleet" && <FleetPanel setError={setError} />}
            {view === "fuel" && <FuelStationsAndEquipmentPanel setError={setError} />}
            {view === "plant-locations" && (
              <>
                <PlantLocationsPanel setError={setError} />
                <SiteGeofenceReportPanel setError={setError} />
              </>
            )}
            {view === "site-contacts" && <SiteContactsPanel setError={setError} />}
            {view === "production-target" && <ProductionTargetPanel setError={setError} />}
            {view === "mix-assignments" && <MixDesignAssignmentsPanel setError={setError} />}
            {view === "mix-designs" && <MixDesignsPanel setError={setError} />}
            {view === "maintenance-action-points" && <MaintenanceActionPointsPanel setError={setError} />}
            {view === "salespersons" && <SalespersonsPanel setError={setError} />}
            {view === "rates" && <RatesPanel setError={setError} />}
            {view === "orders" && <SharedOrdersPanel setError={setError} />}
            {view === "tickets" && <SharedTicketsPanel setError={setError} showChallan />}
            {view === "assign-lead" && (
              <div className="card" style={{ maxWidth: 480 }}>
                <div style={{ fontWeight: 600, marginBottom: 10 }}>Assign a lead</div>
                <CreateLeadForm setError={setError} onDone={goHome} />
              </div>
            )}
          </>
        )}

        {/* ---------- a module's sub-grid ---------- */}
        {!view && activeModule && (
          <>
            <BackBar
              trail={<>Dashboard &rsaquo; <b style={{ color: "var(--charcoal)" }}>{activeModule.label}</b></>}
              onBack={goHome}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <span style={{ width: 48, height: 48, borderRadius: 13, background: activeModule.colour, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", flex: "none" }}>
                <Glyph name={activeModule.icon} size={24} />
              </span>
              <div>
                <div style={{ fontSize: 19, fontWeight: 700 }}>{activeModule.label}</div>
                <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{activeModule.screens.length} screens</div>
              </div>
            </div>
            <KpiRow kpis={summary && summary.kpis} />
            <div className="card">
              <div style={GRID}>
                {activeModule.screens.map((s) => (
                  <ScreenTile
                    key={s.key}
                    screen={{ ...s, colour: activeModule.colour, tint: activeModule.tint }}
                    badge={badges && badges[s.key]}
                    onOpen={() => openScreen(s)}
                  />
                ))}
              </div>
            </div>
          </>
        )}

        {/* ---------- home ---------- */}
        {!view && !activeModule && (
          <>
            <KpiRow kpis={summary && summary.kpis} />

            <div className="card" style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, color: "var(--slate)" }}>Pinned</div>
                <button type="button" onClick={() => setEditingPins(true)} style={{ fontSize: 11, padding: "4px 9px" }}>Rearrange</button>
              </div>
              {pinnedScreens.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--slate)" }}>Nothing pinned. Use Rearrange to choose what sits here.</div>
              ) : (
                <div style={GRID}>
                  {pinnedScreens.map((s) => (
                    <ScreenTile key={s.key} screen={s} badge={badges && badges[s.key]} onOpen={() => openScreen(s)} />
                  ))}
                </div>
              )}
            </div>

            <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, color: "var(--slate)", marginBottom: 12 }}>Modules</div>
            {/* 112px, not 118: at a 390px phone that is the difference between
                three module tiles across and two, which halves the scroll. */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))", gap: "22px 8px", alignItems: "start" }}>
              {ADMIN_MODULES.map((m) => (
                <ModuleTile key={m.key} module={m} badge={moduleBadge(m, badges)} onOpen={() => openModule(m)} />
              ))}
            </div>
          </>
        )}

        {editingPins && (
          <PinPicker
            pins={pins}
            onClose={() => setEditingPins(false)}
            onSaved={(keys) => { setPins(keys.length ? keys : DEFAULT_PINS); setEditingPins(false); }}
            setError={setError}
          />
        )}
      </div>
    </>
  );
}

// ===================== Pin picker =====================
// Deliberately a checklist, not drag-and-drop: this app is used on a phone in
// the plant as much as at a desk, and dragging a 58px tile with gloves on is
// not a thing anyone should have to do. Order follows the registry.

function PinPicker({ pins, onClose, onSaved, setError }) {
  const [selected, setSelected] = useState(pins);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  function toggle(key) {
    setNotice("");
    setSelected((cur) => {
      if (cur.includes(key)) return cur.filter((k) => k !== key);
      if (cur.length >= MAX_PINS) { setNotice(`You can pin at most ${MAX_PINS} screens — unpin one first.`); return cur; }
      return [...cur, key];
    });
  }

  async function save() {
    setSaving(true);
    try {
      // Saved in registry order, not click order, so the strip reads the same
      // way every time no matter how it was built up.
      const ordered = ALL_SCREENS.filter((s) => selected.includes(s.key)).map((s) => s.key);
      const res = await apiRequest("/admin-dashboard/pins", { method: "PUT", body: { keys: ordered } });
      onSaved(res.keys);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: "#fff", borderRadius: "14px 14px 0 0", padding: 18, width: "100%", maxWidth: 560, maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Pinned screens</div>
          <button type="button" onClick={onClose} style={{ border: "none", background: "none", fontSize: 18, lineHeight: 1, padding: 0, color: "var(--slate)" }}>&times;</button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 10 }}>
          {selected.length} of {MAX_PINS} chosen. These are yours alone — nobody else's dashboard changes.
        </div>
        {notice && <div style={{ fontSize: 12, color: "var(--amber)", marginBottom: 8 }}>{notice}</div>}

        {ADMIN_MODULES.map((m) => {
          const rows = m.screens.length ? m.screens : [{ key: m.key, label: m.label }];
          return (
            <div key={m.key} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700, color: m.colour, marginBottom: 5 }}>{m.label}</div>
              {rows.map((s) => (
                <label key={s.key} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12.5, padding: "5px 0", cursor: "pointer" }}>
                  <input type="checkbox" checked={selected.includes(s.key)} onChange={() => toggle(s.key)} style={{ width: 18, height: 18, accentColor: "var(--rebar)" }} />
                  {s.label}
                </label>
              ))}
            </div>
          );
        })}

        <div style={{ display: "flex", gap: 8, position: "sticky", bottom: 0, background: "#fff", paddingTop: 10 }}>
          <button type="button" onClick={() => setSelected(DEFAULT_PINS)} style={{ flex: 1 }}>Reset to default</button>
          <button type="button" onClick={save} disabled={saving} style={{ flex: 1 }}>{saving ? "Saving..." : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

// ===================== Users panel =====================

function UsersPanel({ setError }) {
  const [users, setUsers] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "", password: "", role: "driver" });
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setUsers(await apiRequest("/administrator/users")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function addUser(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest("/administrator/users", { method: "POST", body: form });
      setForm({ name: "", phone: "", email: "", password: "", role: "driver" });
      setShowAdd(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(u) {
    try {
      await apiRequest(`/administrator/users/${u.id}/status`, { method: "PATCH", body: { is_active: !u.is_active } });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function resetPassword(u) {
    const newPassword = window.prompt(`New password for ${u.name} (at least 6 characters):`);
    if (!newPassword) return; // cancelled
    try {
      await apiRequest(`/administrator/users/${u.id}/reset-password`, { method: "POST", body: { new_password: newPassword } });
      window.alert(`Password updated for ${u.name}. Tell them the new password directly — it isn't emailed or shown anywhere else.`);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Phone</th>
            <th>Role</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.phone}</td>
              <td>{u.role.replace("_", " ")}</td>
              <td><span className={`badge ${u.is_active ? "badge-success" : "badge-neutral"}`}>{u.is_active ? "Active" : "Disabled"}</span></td>
              <td style={{ display: "flex", gap: 6 }}>
                <button onClick={() => toggleStatus(u)}>{u.is_active ? "Disable" : "Enable"}</button>
                <button onClick={() => resetPassword(u)}>Reset password</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!showAdd ? (
        <button onClick={() => setShowAdd(true)}>Add user</button>
      ) : (
        <form onSubmit={addUser} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
          <div><div style={{ color: "var(--slate)" }}>Name</div><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Phone</div><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Email (optional)</div><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div><div style={{ color: "var(--slate)" }}>Temporary password</div><input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></div>
          <div>
            <div style={{ color: "var(--slate)" }}>Role</div>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => <option key={r} value={r}>{r.replace("_", " ")}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
            <button type="submit" disabled={saving}>{saving ? "Saving..." : "Create user"}</button>
            <button type="button" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
