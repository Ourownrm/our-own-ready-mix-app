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

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
          {[["people", "People"], ["roles", "Role defaults"], ["log", "Change log"]].map(([k, l]) => (
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
              {!detail.computed && !detail.user.is_self && (
                <button type="button" onClick={resetToDefault} disabled={busy} style={{ fontSize: 11.5 }}>
                  Reset to {ROLE_LABEL[detail.user.role]} default
                </button>
              )}
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
