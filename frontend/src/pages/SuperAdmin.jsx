// Round 146 — the Super Admin access-control page, built from the approved
// mockup ("Admin Dashboard — Icon View" canvas, SuperAdmin + SuperAdminRoles
// artboards) and claude/super-admin-functions-list.md.
//
// Three tabs: People (per-user matrix), Role defaults (a role's whole set),
// Change log. The matrix is a row per function with View / Create / Edit /
// Delete columns, the role's own default beside them, and a dot on anything
// changed from that default.
//
// Everything the page refuses to do, the API refuses too — editing yourself,
// editing an Administrator, granting a locked function, granting an action
// without View. The page states the reason rather than just disabling a box,
// because a greyed tick with no explanation is how people end up asking.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.jsx";

const ACTION_LABEL = { view: "View", create: "Create", edit: "Edit", delete: "Delete" };
const ROLE_LABEL = {
  super_admin: "Super Admin", administrator: "Administrator", manager: "Manager",
  plant_operator: "Plant Operator", qc_engineer: "QC Engineer", lab_technician: "Lab Technician",
  driver: "Driver", site_supervisor: "Site Supervisor", accountant: "Accountant",
  sales_executive: "Sales Executive", store: "Store", loader_operator: "Loader Operator",
};

export default function SuperAdmin() {
  const { user } = useAuth();
  const [tab, setTab] = useState("people");
  const [catalogue, setCatalogue] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    apiRequest("/super-admin/catalogue").then(setCatalogue).catch((e) => setError(e.message));
  }, []);

  return (
    <>
      <TopBar title="User access control" />
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 10 }}>{notice}</div>}

        {/* Round 148 — a Super Admin now has every Administrator screen too
            (see lib/roles.js), and ROLE_HOME sends them here, so this is the
            way across. Without it the top role could only ever see this one
            page, which is exactly the trap Round 147's first promotion fell
            into. */}
        <div style={{ marginBottom: 12 }}>
          <Link to="/administrator" style={{ fontSize: 12, fontWeight: 600 }}>Administrator dashboard &rarr;</Link>
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
          {[["people", "People"], ["roles", "Role defaults"], ["plugins", "Plugins"], ["log", "Change log"]].map(([k, l]) => (
            <button key={k} type="button" className={`btn-tab${tab === k ? " active" : ""}`}
                    onClick={() => { setTab(k); setError(""); setNotice(""); }}
                    style={{ fontSize: 12, padding: "6px 12px", borderRadius: 999 }}>{l}</button>
          ))}
        </div>

        {!catalogue ? (
          <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading…</div>
        ) : tab === "people" ? (
          <PeopleTab catalogue={catalogue} me={user} setError={setError} setNotice={setNotice} />
        ) : tab === "roles" ? (
          <RolesTab catalogue={catalogue} setError={setError} setNotice={setNotice} />
        ) : tab === "plugins" ? (
          <PluginsTab setError={setError} setNotice={setNotice} />
        ) : (
          <ChangeLogTab />
        )}
      </div>
    </>
  );
}

// ===================== Shared matrix =====================

function Matrix({ catalogue, has, isDefault, locked, onToggle, lockReason }) {
  const [filter, setFilter] = useState("");
  const [only, setOnly] = useState("all"); // all | on | changed

  const byGroup = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out = [];
    for (const g of catalogue.groups) {
      const fns = catalogue.functions.filter((f) => {
        if (f.group !== g.key) return false;
        if (q && !f.label.toLowerCase().includes(q)) return false;
        if (only === "on" && !f.actions.some((a) => has(f.key, a))) return false;
        if (only === "changed" && !f.actions.some((a) => !isDefault(f.key, a))) return false;
        return true;
      });
      if (fns.length) out.push({ group: g, fns });
    }
    return out;
  }, [catalogue, filter, only, has, isDefault]);

  const total = catalogue.functions.reduce((s, f) => s + f.actions.length, 0);
  const on = catalogue.functions.reduce((s, f) => s + f.actions.filter((a) => has(f.key, a)).length, 0);

  return (
    <>
      <div className="card" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12, padding: 10 }}>
        <input placeholder="Search functions" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: "1 1 180px", fontSize: 12.5 }} />
        {[["all", "All"], ["on", "Only what they can use"], ["changed", "Only changed"]].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setOnly(k)}
                  style={{ fontSize: 11.5, padding: "5px 10px", background: only === k ? "var(--charcoal)" : undefined, color: only === k ? "#fff" : undefined }}>{l}</button>
        ))}
        <span style={{ fontSize: 11.5, color: "var(--slate)", marginLeft: "auto" }}>{on} of {total} permissions</span>
      </div>

      {byGroup.length === 0 && <div className="card" style={{ fontSize: 12.5, color: "var(--slate)" }}>Nothing matches.</div>}

      {byGroup.map(({ group, fns }) => (
        <div key={group.key} className="card" style={{ marginBottom: 12, overflowX: "auto" }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, color: "var(--slate)", marginBottom: 8 }}>
            {group.label} · {fns.length}
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 190 }}>Function</th>
                {["view", "create", "edit", "delete"].map((a) => (
                  <th key={a} style={{ textAlign: "center", width: 64 }}>{ACTION_LABEL[a]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fns.map((f) => (
                <tr key={f.key}>
                  <td>
                    {f.label}
                    {f.locked && <span className="badge badge-danger" style={{ marginLeft: 6, fontSize: 9.5, padding: "1px 6px" }}>Super Admin only</span>}
                  </td>
                  {["view", "create", "edit", "delete"].map((a) => {
                    if (!f.actions.includes(a)) {
                      return <td key={a} style={{ textAlign: "center", color: "var(--concrete)" }}>—</td>;
                    }
                    const disabled = locked || f.locked;
                    return (
                      <td key={a} style={{ textAlign: "center" }}>
                        <span style={{ position: "relative", display: "inline-block" }}>
                          <input
                            type="checkbox"
                            checked={has(f.key, a)}
                            disabled={disabled}
                            title={disabled ? lockReason : undefined}
                            aria-label={`${f.label} — ${ACTION_LABEL[a]}`}
                            onChange={(e) => onToggle(f, a, e.target.checked)}
                            style={{ width: 18, height: 18, accentColor: "var(--rebar)" }}
                          />
                          {!isDefault(f.key, a) && (
                            <span title="changed from the role default"
                                  style={{ position: "absolute", top: -2, right: -7, width: 6, height: 6, borderRadius: 3, background: "var(--rebar)" }} />
                          )}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

// ===================== People =====================

function PeopleTab({ catalogue, me, setError, setNotice }) {
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);

  async function loadUsers() {
    try { setUsers(await apiRequest("/super-admin/users")); } catch (e) { setError(e.message); }
  }
  useEffect(() => { loadUsers(); }, []);

  async function open(u) {
    setSelected(u.id); setDetail(null); setError(""); setNotice("");
    try { setDetail(await apiRequest(`/super-admin/users/${u.id}/permissions`)); }
    catch (e) { setError(e.message); }
  }

  const effective = useMemo(() => new Set(detail ? detail.effective : []), [detail]);
  const defaults = useMemo(() => new Set(detail ? detail.role_defaults : []), [detail]);
  const overrides = useMemo(
    () => new Map(detail ? detail.overrides.map((o) => [`${o.key}:${o.action}`, o.granted]) : []),
    [detail]
  );

  async function toggle(f, action, on) {
    setBusy(true); setError(""); setNotice("");
    try {
      // Back to the role default when the new state matches it, otherwise an
      // explicit grant or revoke — so the "changed" dots mean something.
      const isDefaultNow = defaults.has(`${f.key}:${action}`);
      const state = on === isDefaultNow ? "default" : on ? "grant" : "revoke";
      const res = await apiRequest(`/super-admin/users/${selected}/permissions`, {
        method: "PUT", body: { key: f.key, action, state },
      });
      if (res.cascaded) setNotice(`View off also turned off ${res.cascaded} other action${res.cascaded === 1 ? "" : "s"} on "${f.label}".`);
      setDetail(await apiRequest(`/super-admin/users/${selected}/permissions`));
      loadUsers();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  // Round 148 — Round 146 shipped POST /users, POST /users/:id/role and
  // PATCH /users/:id/status but no way to reach them, so the only Super Admin
  // in a live system had no way to create a second one or hand the role back.
  // That is the whole recovery path, so it belongs on the page, not in curl.
  async function createPerson(form) {
    setBusy(true); setError(""); setNotice("");
    try {
      const created = await apiRequest("/super-admin/users", { method: "POST", body: form });
      setNotice(`Created ${created.name} as ${ROLE_LABEL[created.role] || created.role}.`);
      await loadUsers();
      return true;
    } catch (e) { setError(e.message); return false; } finally { setBusy(false); }
  }

  async function changeRole(role) {
    if (!window.confirm(`Change ${detail.user.name} to ${ROLE_LABEL[role] || role}?`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest(`/super-admin/users/${selected}/role`, { method: "POST", body: { role } });
      setNotice(`${detail.user.name} is now ${ROLE_LABEL[role] || role}.`);
      setDetail(await apiRequest(`/super-admin/users/${selected}/permissions`));
      loadUsers();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function setActive(isActive) {
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest(`/super-admin/users/${selected}/status`, { method: "PATCH", body: { is_active: isActive } });
      setNotice(`${detail.user.name} ${isActive ? "can sign in again" : "can no longer sign in"}.`);
      setDetail(await apiRequest(`/super-admin/users/${selected}/permissions`));
      loadUsers();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function resetToDefault() {
    if (!window.confirm(`Put ${detail.user.name} back on the ${ROLE_LABEL[detail.user.role]} defaults? Every change made for them is removed.`)) return;
    setBusy(true);
    try {
      const r = await apiRequest(`/super-admin/users/${selected}/permissions`, { method: "DELETE" });
      setNotice(`Removed ${r.removed} change${r.removed === 1 ? "" : "s"}.`);
      setDetail(await apiRequest(`/super-admin/users/${selected}/permissions`));
      loadUsers();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, alignItems: "start" }}>
      <div className="card" style={{ maxWidth: 320 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 8 }}>People</div>
        {users.map((u) => (
          <button key={u.id} type="button" onClick={() => open(u)}
                  style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 6, fontSize: 12.5,
                           border: selected === u.id ? "2px solid var(--rebar)" : "1px solid var(--concrete)",
                           background: selected === u.id ? "#FBF6F0" : "#fff" }}>
            <b>{u.name}</b>
            {!u.is_active && <span className="badge badge-neutral" style={{ marginLeft: 6, fontSize: 9.5 }}>Disabled</span>}
            <div style={{ fontSize: 10.5, color: "var(--slate)" }}>
              {ROLE_LABEL[u.role] || u.role}
              {u.is_self ? " · you" : u.override_count ? ` · ${u.override_count} changed` : " · role default"}
            </div>
          </button>
        ))}
        <AddPerson onCreate={createPerson} busy={busy} />

        <div style={{ fontSize: 10.5, color: "var(--slate)", lineHeight: 1.5, marginTop: 8 }}>
          Every role starts from a saved default set. Anything changed for one person is marked “changed”, and an
          individual change always wins over a later change to their role.
        </div>
      </div>

      <div style={{ gridColumn: "1 / -1" }}>
        {!selected && <div className="card" style={{ fontSize: 12.5, color: "var(--slate)" }}>Pick somebody to see what they can do.</div>}
        {selected && !detail && <div className="card" style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading…</div>}
        {detail && (
          <>
            <div className="card" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>
                  {detail.user.name} <span className="badge badge-info" style={{ fontSize: 10 }}>{ROLE_LABEL[detail.user.role] || detail.user.role}</span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 3 }}>
                  {detail.user.is_self
                    ? "This is you. You can't change your own access — ask another Super Admin."
                    : detail.computed
                      ? detail.user.role === "administrator"
                        ? "Administrator keeps every function by design. To give someone less, change their role."
                        : "A Super Admin has everything, including the three functions nobody else can be given."
                      : "Anything switched off disappears from their menus and is refused by the server."}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {!detail.computed && !detail.user.is_self && (
                  <button type="button" onClick={resetToDefault} disabled={busy} style={{ fontSize: 11.5 }}>
                    Reset to {ROLE_LABEL[detail.user.role]} default
                  </button>
                )}
                {!detail.user.is_self && (
                  <>
                    <label style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 5 }}>
                      Role
                      <select value={detail.user.role} disabled={busy}
                              onChange={(e) => e.target.value !== detail.user.role && changeRole(e.target.value)}
                              style={{ fontSize: 11.5, padding: "3px 6px" }}>
                        {Object.keys(ROLE_LABEL).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    </label>
                    <button type="button" onClick={() => setActive(!detail.user.is_active)} disabled={busy} style={{ fontSize: 11.5 }}>
                      {detail.user.is_active ? "Disable sign-in" : "Enable sign-in"}
                    </button>
                  </>
                )}
              </div>
            </div>

            <Matrix
              catalogue={catalogue}
              has={(k, a) => effective.has(`${k}:${a}`)}
              isDefault={(k, a) => !overrides.has(`${k}:${a}`)}
              locked={detail.computed || detail.user.is_self || busy}
              lockReason={detail.user.is_self ? "You can't change your own access." : "This role's access is fixed in code."}
              onToggle={toggle}
            />
          </>
        )}
      </div>
    </div>
  );
}

// Round 148 — creating an account from here, which is the only way to make a
// SECOND Super Admin. It matters more than it looks: nobody can change their
// own role or their own access, and the API refuses to leave zero active Super
// Admins, so a system with exactly one Super Admin has no way back if that
// account is lost. This form is what turns that from a database problem into a
// two-minute one.
function AddPerson({ onCreate, busy }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", password: "", role: "administrator" });

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ fontSize: 11.5, width: "100%", marginTop: 4 }}>
        + Add person
      </button>
    );
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <form
      style={{ marginTop: 8, padding: 10, border: "1px solid var(--concrete)", borderRadius: 8, display: "grid", gap: 6 }}
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await onCreate(form);
        if (ok) { setForm({ name: "", phone: "", password: "", role: "administrator" }); setOpen(false); }
      }}
    >
      <input value={form.name} onChange={set("name")} placeholder="Name" required style={{ fontSize: 12 }} />
      <input value={form.phone} onChange={set("phone")} placeholder="Phone (this is their login)" required style={{ fontSize: 12 }} />
      <input value={form.password} onChange={set("password")} placeholder="Password" type="text" required minLength={6} style={{ fontSize: 12 }} />
      <select value={form.role} onChange={set("role")} style={{ fontSize: 12 }}>
        {Object.keys(ROLE_LABEL).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
      </select>
      <div style={{ fontSize: 10.5, color: "var(--slate)", lineHeight: 1.45 }}>
        The phone number is the login and cannot be changed afterwards — there is no rename anywhere in the app, so a
        different number means a different account. The password is shown as you type it, on purpose: you have to be
        able to pass it on.
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="submit" disabled={busy} style={{ fontSize: 11.5 }}>Create</button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy} style={{ fontSize: 11.5 }}>Cancel</button>
      </div>
    </form>
  );
}

// ===================== Plugins (Round 149) =====================
// A plugin is a whole optional module — the first is the Delivery Challan
// (Solitaire) batching-docket screen. This tab does two separate things for
// it, and the distinction matters:
//
//   The switch decides whether the module EXISTS. Off means every one of its
//   API routes answers 404 for everybody, including its own login, and the
//   Plant Operator icon disappears. Nothing is deleted — accounts, devices,
//   master data and printed dockets all survive being switched off and come
//   back untouched.
//
//   The access list decides WHO may use it while it is on. Each person gets
//   their own Solitaire username, password and module role, separate from
//   their main app login by design: the module is a different trust boundary.
//
// Both live here rather than on the Administrator screen because the user's
// instruction was that an Administrator has no access to this module at all.
// The catalogue function behind it (admin.plugins) is locked, so there is no
// permission an Administrator could be granted that would reach this.
function PluginsTab({ setError, setNotice }) {
  const [plugins, setPlugins] = useState([]);
  const [people, setPeople] = useState(null);
  const [busy, setBusy] = useState(false);
  const [granting, setGranting] = useState(null); // user id being granted
  const [form, setForm] = useState({ username: "", password: "", role: "operator" });

  const solitaire = plugins.find((p) => p.key === "solitaire");

  async function load() {
    try { setPlugins(await apiRequest("/super-admin/plugins")); }
    catch (e) { setError(e.message); }
  }
  async function loadPeople() {
    // 404 here is not an error to shout about — it is what a disabled plugin
    // answers, and the list is genuinely unavailable then.
    try { setPeople(await apiRequest("/solitaire-access")); }
    catch { setPeople(null); }
  }
  useEffect(() => { load().then(loadPeople); }, []);

  async function toggle(key, on) {
    if (!on && !window.confirm(
      "Switch the Delivery Challan module off?\n\n" +
      "It disappears from the Plant Operator screen and every one of its screens stops " +
      "working, including for anyone signed into it right now. Nothing is deleted — " +
      "switching it back on restores it exactly as it was."
    )) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await apiRequest(`/super-admin/plugins/${key}`, { method: "PATCH", body: { is_enabled: on } });
      setNotice(`${r.label} is now ${r.is_enabled ? "ON" : "OFF"}.`);
      await load(); await loadPeople();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function grant(userId) {
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest(`/solitaire-access/${userId}/grant`, { method: "POST", body: form });
      setNotice("Access granted. Give them that username and password — the module has its own login.");
      setGranting(null); setForm({ username: "", password: "", role: "operator" });
      loadPeople();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function revoke(u) {
    if (!window.confirm(`Revoke ${u.name}'s Delivery Challan access?`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest(`/solitaire-access/${u.id}/revoke`, { method: "POST" });
      setNotice(`${u.name} can no longer open the module.`);
      loadPeople();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="card">
        <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 8 }}>Modules</div>
        {!plugins.length && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>No plugins registered. Run /setup once.</div>}
        {plugins.map((p) => (
          <div key={p.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", paddingBottom: 8 }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                {p.label}{" "}
                <span className={`badge ${p.is_enabled ? "badge-success" : "badge-neutral"}`} style={{ fontSize: 10 }}>
                  {p.is_enabled ? "On" : "Off"}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 2 }}>
                {p.updated_by_name ? `Last changed by ${p.updated_by_name}` : "Never changed"}
              </div>
            </div>
            <button type="button" disabled={busy} onClick={() => toggle(p.key, !p.is_enabled)} style={{ fontSize: 11.5 }}>
              {p.is_enabled ? "Switch off" : "Switch on"}
            </button>
          </div>
        ))}
        <div style={{ fontSize: 10.5, color: "var(--slate)", lineHeight: 1.5, marginTop: 4 }}>
          Switching a module off takes it away from everyone at once and nothing is deleted. An Administrator
          cannot see or change any of this.
        </div>
      </div>

      <div className="card">
        <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 8 }}>Who can open the Delivery Challan module</div>
        {!solitaire?.is_enabled ? (
          <div style={{ fontSize: 12.5, color: "var(--slate)" }}>
            The module is switched off, so there is nobody to list. Switch it on to manage access.
          </div>
        ) : !people ? (
          <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading…</div>
        ) : (
          <>
            <div style={{ fontSize: 10.5, color: "var(--slate)", lineHeight: 1.5, marginBottom: 8 }}>
              The module has its own login — the username and password you set here are NOT their main app
              ones. Its icon appears only on the Plant Operator screen, only for the people listed as having
              access. Re-granting somebody who already has access is also how you reset their password.
            </div>
            {people.map((u) => (
              <div key={u.id} style={{ borderTop: "1px solid var(--concrete)", padding: "7px 0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{u.name}</span>
                    <span style={{ fontSize: 10.5, color: "var(--slate)" }}> · {String(u.role).replace("_", " ")}</span>
                    {u.solitaire_username && u.solitaire_is_active && (
                      <div style={{ fontSize: 10.5, color: "var(--signal-green)" }}>
                        Has access as “{u.solitaire_username}” ({u.solitaire_role})
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button type="button" disabled={busy} style={{ fontSize: 11 }}
                            onClick={() => { setGranting(granting === u.id ? null : u.id); setForm({ username: u.solitaire_username || "", password: "", role: u.solitaire_role || "operator" }); }}>
                      {u.solitaire_is_active ? "Change" : "Grant access"}
                    </button>
                    {u.solitaire_is_active && (
                      <button type="button" disabled={busy} style={{ fontSize: 11 }} onClick={() => revoke(u)}>Revoke</button>
                    )}
                  </div>
                </div>
                {granting === u.id && (
                  <form style={{ display: "grid", gap: 6, marginTop: 7, maxWidth: 320 }}
                        onSubmit={(e) => { e.preventDefault(); grant(u.id); }}>
                    <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}
                           placeholder="Solitaire username" required style={{ fontSize: 12 }} />
                    <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
                           placeholder="Password for the module" required style={{ fontSize: 12 }} />
                    <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={{ fontSize: 12 }}>
                      <option value="operator">Operator — data entry and printing</option>
                      <option value="qc">QC — also edits mix designs</option>
                      <option value="admin">Admin — also devices and settings</option>
                    </select>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button type="submit" disabled={busy} style={{ fontSize: 11.5 }}>Save</button>
                      <button type="button" disabled={busy} style={{ fontSize: 11.5 }} onClick={() => setGranting(null)}>Cancel</button>
                    </div>
                  </form>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ===================== Role defaults =====================

function RolesTab({ catalogue, setError, setNotice }) {
  const editable = catalogue.roles.filter((r) => !catalogue.computed_roles.includes(r));
  const [role, setRole] = useState(editable[0]);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load(r) {
    setData(null);
    try { setData(await apiRequest(`/super-admin/roles/${r}/permissions`)); }
    catch (e) { setError(e.message); }
  }
  useEffect(() => { load(role); }, [role]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = useMemo(() => new Set(data ? data.defaults : []), [data]);

  async function toggle(f, action, on) {
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await apiRequest(`/super-admin/roles/${role}/permissions`, { method: "PUT", body: { key: f.key, action, on } });
      if (res.unaffected_because_overridden && res.unaffected_because_overridden.length) {
        setNotice(
          `${res.unaffected_because_overridden.map((u) => u.name).join(", ")} ` +
          `${res.unaffected_because_overridden.length === 1 ? "has" : "have"} their own setting for this and ${res.unaffected_because_overridden.length === 1 ? "is" : "are"} unchanged.`
        );
      }
      await load(role);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "var(--slate)" }}>
          Role{" "}
          <select value={role} onChange={(e) => setRole(e.target.value)} style={{ fontSize: 12.5 }}>
            {editable.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] || r}</option>)}
          </select>
        </label>
        {data && !data.computed && (
          <span style={{ fontSize: 11.5, color: "var(--slate)" }}>{data.active_users} active {data.active_users === 1 ? "person" : "people"} on this role</span>
        )}
        <span style={{ fontSize: 11.5, color: "var(--slate)", marginLeft: "auto", maxWidth: 520, lineHeight: 1.5 }}>
          Changing a default reaches everyone on this role <b>except</b> anyone given their own setting for that
          function — an individual change always wins. Administrator and Super Admin are fixed in code and not listed.
        </span>
      </div>

      {!data ? <div className="card" style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading…</div> : (
        <Matrix
          catalogue={catalogue}
          has={(k, a) => set.has(`${k}:${a}`)}
          isDefault={() => true /* this IS the default — nothing to mark as changed */}
          locked={busy}
          lockReason=""
          onToggle={toggle}
        />
      )}
    </>
  );
}

// ===================== Change log =====================

function ChangeLogTab() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    apiRequest("/super-admin/change-log").then(setRows).catch((e) => setError(e.message));
  }, []);

  if (error) return <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!rows) return <div className="card" style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading…</div>;
  if (!rows.length) return <div className="card" style={{ fontSize: 12.5, color: "var(--slate)" }}>Nothing has been changed yet.</div>;

  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <table>
        <thead><tr><th>When</th><th>Who changed it</th><th>For</th><th>Function</th><th>Action</th><th>From</th><th>To</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ whiteSpace: "nowrap" }}>{new Date(r.changed_at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
              <td>{r.changed_by_name}</td>
              <td>{r.target_user_name || <span style={{ color: "var(--slate)" }}>{ROLE_LABEL[r.target_role] || r.target_role} defaults</span>}</td>
              <td>{r.label}</td>
              <td>{ACTION_LABEL[r.action] || r.action}</td>
              <td style={{ color: "var(--slate)" }}>{r.previous_state}</td>
              <td><span className={`badge ${r.granted ? "badge-success" : "badge-neutral"}`} style={{ fontSize: 9.5 }}>{r.granted ? "granted" : "revoked"}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 10.5, color: "var(--slate)", marginTop: 8 }}>
        Newest first, last 200 changes. This log is append-only — nothing in the app edits or clears it.
      </div>
    </div>
  );
}
