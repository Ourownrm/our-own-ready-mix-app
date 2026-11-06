// Round 268 — Team Chat → Settings (function "chat.manage"; Administrator by
// default). Mock-up artboard 8: how often the app asks for new messages,
// phone notifications, photos and how long things are kept — the settings
// that keep the chat inside the existing Render plan — plus the groups.
import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { CHAT, ROLE_NAMES } from "../lib/chatApi.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import { isAdminLevel } from "../lib/roles.js";

const OPEN_CHOICES = [5, 10, 15, 30];
const BADGE_CHOICES = [30, 60, 120, 300];
const PHOTO_DAYS = [30, 60, 90, 180, 365];
const MSG_MONTHS = [3, 6, 12, 24];

function Toggle({ on, onChange, label, disabled }) {
  return (
    <button type="button" aria-pressed={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      style={{ width: 54, height: 30, padding: 0, borderRadius: 15, border: 0, position: "relative", flexShrink: 0,
        background: on ? "var(--signal-green)" : "#B9B3A6" }}>
      <span style={{ position: "absolute", top: 4, left: on ? 28 : 4, width: 22, height: 22, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
    </button>
  );
}

export default function TeamChatSettings({ onBack }) {
  const { user } = useAuth();
  const { can } = usePermissions();
  const canEdit = isAdminLevel(user?.role) || can("chat.manage", "edit");
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState("");

  function load() {
    apiRequest(`${CHAT}/admin/settings`).then(setData).catch((e) => setErr(e.message));
  }
  useEffect(load, []);

  async function save(patch) {
    setErr(""); setSaved("");
    try {
      const r = await apiRequest(`${CHAT}/admin/settings`, { method: "PUT", body: patch });
      setData((d) => ({ ...d, settings: r.settings }));
      setSaved("Saved.");
      setTimeout(() => setSaved(""), 2000);
    } catch (e) { setErr(e.message); }
  }

  const s = data?.settings;
  const u = data?.usage;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <button type="button" onClick={onBack}>← Back to chats</button>
        <h1 style={{ margin: 0, fontSize: 20 }}>Team Chat settings</h1>
        <span className="badge badge-success">Runs on the existing server &amp; database · no extra Render service</span>
        {saved && <span className="badge badge-info">{saved}</span>}
      </div>
      {err && <div className="tc-error" style={{ marginBottom: 12 }}>{err}</div>}
      {!s ? <div className="card">Loading…</div> : (
        <div className="tc-set-grid">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <section className="card">
              <h2 style={{ margin: "0 0 4px", fontSize: 15 }}>Checking for new messages</h2>
              <div className="tc-set-row">
                <div><b>While a chat is open</b><span>The app asks the server "anything new?" — one small request</span></div>
                <select value={s.poll_open_s} disabled={!canEdit} onChange={(e) => save({ poll_open_s: Number(e.target.value) })} aria-label="Check interval while a chat is open">
                  {[...new Set([...OPEN_CHOICES, s.poll_open_s])].sort((a, b) => a - b).map((v) => <option key={v} value={v}>Every {v} s</option>)}
                </select>
              </div>
              <div className="tc-set-row">
                <div><b>On other screens (the Chat badge in the header)</b><span>Unread count only</span></div>
                <select value={s.poll_badge_s} disabled={!canEdit} onChange={(e) => save({ poll_badge_s: Number(e.target.value) })} aria-label="Badge check interval">
                  {[...new Set([...BADGE_CHOICES, s.poll_badge_s])].sort((a, b) => a - b).map((v) => <option key={v} value={v}>{v < 60 ? `Every ${v} s` : `Every ${v / 60} min`}</option>)}
                </select>
              </div>
              <div className="tc-set-row">
                <div><b>Background</b><span>Phone locked or app in the background = no requests at all (always on)</span></div>
                <span className="badge badge-success">On</span>
              </div>
              <div className="tc-set-row">
                <div><b>Phone notifications for new messages</b><span>Free web push. Each person can mute a chat; an @mention still reaches them.</span></div>
                <Toggle on={s.push_enabled} disabled={!canEdit} label="Phone notifications" onChange={(v) => save({ push_enabled: v })} />
              </div>
            </section>

            <section className="card">
              <h2 style={{ margin: "0 0 4px", fontSize: 15 }}>Photos &amp; storage</h2>
              <div className="tc-set-row">
                <div><b>Allow photos</b><span>Shrunk on the phone before upload — max 1280 px, about 150 KB</span></div>
                <Toggle on={s.photos_allowed} disabled={!canEdit} label="Allow photos" onChange={(v) => save({ photos_allowed: v })} />
              </div>
              <div className="tc-set-row">
                <div><b>Delete photos after</b><span>The message stays; the photo shows "Photo expired"</span></div>
                <select value={s.photo_keep_days} disabled={!canEdit} onChange={(e) => save({ photo_keep_days: Number(e.target.value) })} aria-label="Delete photos after">
                  {[...new Set([...PHOTO_DAYS, s.photo_keep_days])].sort((a, b) => a - b).map((v) => <option key={v} value={v}>{v} days</option>)}
                </select>
              </div>
              <div className="tc-set-row">
                <div><b>Keep messages for</b><span>Older messages are removed automatically once a day</span></div>
                <select value={s.message_keep_months} disabled={!canEdit} onChange={(e) => save({ message_keep_months: Number(e.target.value) })} aria-label="Keep messages for">
                  {[...new Set([...MSG_MONTHS, s.message_keep_months])].sort((a, b) => a - b).map((v) => <option key={v} value={v}>{v} months</option>)}
                </select>
              </div>
            </section>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <section className="card">
              <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>Usage</h2>
              <div className="tc-usage">
                <div className="kpi"><div className="kpi-label">Chat storage</div><div className={`kpi-value${u.chat_mb >= s.warn_mb ? " danger" : ""}`}>{u.chat_mb} MB</div></div>
                <div className="kpi"><div className="kpi-label">Photos kept</div><div className="kpi-value">{u.photos}</div></div>
                <div className="kpi"><div className="kpi-label">Messages this month</div><div className="kpi-value">{u.month_messages}</div></div>
                <div className="kpi"><div className="kpi-label">Whole database</div><div className="kpi-value">{u.db_mb} MB</div></div>
              </div>
              <div className="tc-set-row" style={{ borderTop: 0, marginTop: 6 }}>
                <div><b>Warn me at</b><span>A notification goes to the Administrator if chat storage passes this</span></div>
                <WarnInput value={s.warn_mb} disabled={!canEdit} onSave={(v) => save({ warn_mb: v })} />
              </div>
            </section>
            <Groups canEdit={canEdit} />
          </div>
        </div>
      )}
    </>
  );
}

function WarnInput({ value, onSave, disabled }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <input type="number" min={20} max={10000} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} aria-label="Warning level in MB" style={{ minWidth: 0, width: 90 }} />
      MB
      {String(value) !== v && <button type="button" onClick={() => onSave(Number(v))}>Save</button>}
    </span>
  );
}

// ---------- groups ----------
function Groups({ canEdit }) {
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null); // group object being edited, or {} for new
  const [err, setErr] = useState("");
  function load() { apiRequest(`${CHAT}/admin/groups`).then(setData).catch((e) => setErr(e.message)); }
  useEffect(load, []);

  async function archive(g, archived) {
    try { await apiRequest(`${CHAT}/admin/groups/${g.id}`, { method: "PUT", body: { archived } }); load(); }
    catch (e) { setErr(e.message); }
  }

  const roleText = (roles) => (roles.includes("*") ? "Everyone" : roles.map((r) => ROLE_NAMES[r] || r).join(", ") || "—");

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Groups</h2>
        {canEdit && <button type="button" onClick={() => setEdit({ name: "", member_roles: [], post_policy: "all", extra: [], excluded: [] })}>New group</button>}
      </div>
      <p style={{ fontSize: 12.5, color: "var(--slate)", margin: "0 0 8px" }}>Members follow the roles you tick. Administrator and Super Admin are in every group. Add or take out individual people below the roles.</p>
      {err && <div className="tc-error">{err}</div>}
      {!data ? <p>Loading…</p> : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Group</th><th>Members (by role)</th><th>Who can post</th><th /></tr></thead>
            <tbody>
              {data.groups.map((g) => (
                <tr key={g.id} style={g.archived_at ? { opacity: 0.55 } : undefined}>
                  <td><b>{g.name}</b><br /><small style={{ color: "var(--slate)" }}>{g.member_count} people{g.archived_at ? " · archived" : ""}</small></td>
                  <td style={{ fontSize: 12.5 }}>
                    {roleText(g.member_roles)}
                    {g.extra.length > 0 && <><br /><span style={{ color: "var(--signal-green)" }}>+ {g.extra.map((p) => p.name).join(", ")}</span></>}
                    {g.excluded.length > 0 && <><br /><span style={{ color: "var(--alert-red)" }}>− {g.excluded.map((p) => p.name).join(", ")}</span></>}
                  </td>
                  <td>{g.post_policy === "admins" ? "Admin only" : "All"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {canEdit && !g.archived_at && <button type="button" onClick={() => setEdit(g)}>Edit</button>}
                    {canEdit && (g.archived_at
                      ? <button type="button" onClick={() => archive(g, false)}>Restore</button>
                      : null)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && data && (
        <GroupEditor group={edit} roles={data.roles} onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); load(); }} onArchive={edit.id ? () => { archive(edit, true); setEdit(null); } : null} />
      )}
    </section>
  );
}

function GroupEditor({ group, roles, onClose, onSaved, onArchive }) {
  const [name, setName] = useState(group.name || "");
  const [everyone, setEveryone] = useState((group.member_roles || []).includes("*"));
  const [picked, setPicked] = useState(new Set((group.member_roles || []).filter((r) => r !== "*")));
  const [post, setPost] = useState(group.post_policy || "all");
  const [extra, setExtra] = useState(group.extra || []);
  const [excluded, setExcluded] = useState(group.excluded || []);
  const [people, setPeople] = useState([]);
  const [addWho, setAddWho] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { apiRequest(`${CHAT}/people`).then(setPeople).catch(() => {}); }, []);

  function toggleRole(r) {
    setPicked((s) => { const n = new Set(s); if (n.has(r)) n.delete(r); else n.add(r); return n; });
  }
  const chosen = new Set([...extra, ...excluded].map((p) => p.id));
  const options = people.filter((p) => !chosen.has(p.id));

  function addPerson(kind) {
    const p = people.find((x) => String(x.id) === addWho);
    if (!p) return;
    if (kind === "add") setExtra((l) => [...l, p]); else setExcluded((l) => [...l, p]);
    setAddWho("");
  }

  async function save() {
    setBusy(true); setErr("");
    const body = {
      name, post_policy: post,
      member_roles: everyone ? ["*"] : [...picked],
      extra_user_ids: extra.map((p) => p.id), excluded_user_ids: excluded.map((p) => p.id),
    };
    try {
      if (group.id) await apiRequest(`${CHAT}/admin/groups/${group.id}`, { method: "PUT", body });
      else await apiRequest(`${CHAT}/admin/groups`, { method: "POST", body });
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="tc-overlay" onClick={onClose} role="presentation">
      <div className="tc-dialog" style={{ width: "min(560px, 100%)" }} role="dialog" aria-label={group.id ? "Edit group" : "New group"} onClick={(e) => e.stopPropagation()}>
        <div className="tc-dialog-head"><h2>{group.id ? `Edit ${group.name}` : "New group"}</h2><button type="button" onClick={onClose}>Close</button></div>
        <div className="tc-dialog-body">
          {err && <div className="tc-error">{err}</div>}
          <label style={{ fontSize: 12.5, color: "var(--slate)" }}>Group name
            <input type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 4 }}>Members by role</div>
          <div className="tc-roles">
            <label><input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} /> Everyone</label>
            {!everyone && roles.filter((r) => !["administrator", "super_admin"].includes(r)).map((r) => (
              <label key={r}><input type="checkbox" checked={picked.has(r)} onChange={() => toggleRole(r)} /> {ROLE_NAMES[r] || r}</label>
            ))}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Individual people</div>
          <div className="tc-people">
            {extra.map((p) => <span key={`a${p.id}`} style={{ background: "var(--signal-green-bg)" }}>+ {p.name}<button type="button" onClick={() => setExtra((l) => l.filter((x) => x.id !== p.id))} aria-label={`Remove ${p.name}`}>×</button></span>)}
            {excluded.map((p) => <span key={`x${p.id}`} style={{ background: "var(--alert-red-bg)" }}>− {p.name}<button type="button" onClick={() => setExcluded((l) => l.filter((x) => x.id !== p.id))} aria-label={`Undo taking out ${p.name}`}>×</button></span>)}
            {!extra.length && !excluded.length && <small style={{ color: "var(--slate)" }}>None — membership is by role only.</small>}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <select value={addWho} onChange={(e) => setAddWho(e.target.value)} aria-label="Pick a person" style={{ height: 38, borderRadius: 7, border: "1px solid var(--border-strong)", padding: "0 8px", minWidth: 180, flex: 1 }}>
              <option value="">Pick a person…</option>
              {options.map((p) => <option key={p.id} value={p.id}>{p.name} — {ROLE_NAMES[p.role] || p.role}</option>)}
            </select>
            <button type="button" disabled={!addWho} onClick={() => addPerson("add")}>Add to group</button>
            <button type="button" disabled={!addWho} onClick={() => addPerson("out")}>Take out</button>
          </div>
          <label style={{ fontSize: 12.5, color: "var(--slate)", display: "block", marginBottom: 14 }}>Who can post
            <select value={post} onChange={(e) => setPost(e.target.value)} style={{ display: "block", height: 38, borderRadius: 7, border: "1px solid var(--border-strong)", padding: "0 8px", marginTop: 4 }}>
              <option value="all">Every member</option>
              <option value="admins">Administrator only (announcements)</option>
            </select>
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn-primary" disabled={busy || !name.trim()} onClick={save}>{busy ? "Saving…" : "Save group"}</button>
            {onArchive && <button type="button" onClick={() => { if (window.confirm("Archive this group? Its members will no longer see it.")) onArchive(); }}>Archive group</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
