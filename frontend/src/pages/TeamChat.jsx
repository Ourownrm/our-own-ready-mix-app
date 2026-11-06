// Round 268 — Team Chat (owner, 1 Nov 2026: "possible to create a chat page
// like whatsapp in app? So small communications with in the team will happen
// in app"; 6 Nov: "code team chat", after "chat i want without costing
// anything extra in render"). Mock-up: claude/customer-feedback-team-chat-
// mockup-v1.md, artboards 5–8.
//
// One page for phone and computer. On a computer the chat list and the open
// chat sit side by side; on a phone it is one or the other, like WhatsApp.
//
// No live connection: while a chat is open the page asks for new messages
// every poll_open_s seconds (10 by default, set in Settings); the list is
// asked less often; nothing is asked while the app is in the background.
// Server side: backend/src/routes/chat.js (under /api/notifications/chat).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { CHAT, ROLE_NAMES, usePolling, loadChatPhoto, shrinkPhoto, bumpChatBadge } from "../lib/chatApi.js";
import { formatOrderNumber } from "../lib/orderNumber.js";
import OrderDetailModal from "../lib/OrderDetailModal.jsx";
import TeamChatSettings from "./TeamChatSettings.jsx";
import "./teamChat.css";


// ---------- small helpers ----------
function useWide(px) {
  const q = `(min-width: ${px}px)`;
  const [wide, setWide] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setWide(mq.matches);
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => (mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on));
  }, [q]);
  return wide;
}

// The chat fills the screen between the header and the fixed footer.
function useFillHeight(ref) {
  const [h, setH] = useState(520);
  useLayoutEffect(() => {
    const calc = () => {
      if (!ref.current) return;
      const top = ref.current.getBoundingClientRect().top + window.scrollY;
      const footer = document.querySelector(".app-footer")?.offsetHeight || 60;
      setH(Math.max(420, window.innerHeight - top - footer - 12));
    };
    calc();
    window.addEventListener("resize", calc);
    const t = setTimeout(calc, 300);
    return () => { window.removeEventListener("resize", calc); clearTimeout(t); };
  }, [ref]);
  return h;
}

function useTicker(ms) {
  const [, setN] = useState(0);
  useEffect(() => { const id = setInterval(() => setN((n) => n + 1), ms); return () => clearInterval(id); }, [ms]);
}

function ago(at) {
  if (!at) return "…";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  return `${Math.round(s / 60)} min ago`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function dayLabel(d) {
  const now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return "Today";
  if (sameDay(d, y)) return "Yesterday";
  return d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}
function clock(d) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function listTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return clock(d);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Yesterday";
  return d.toLocaleDateString([], { day: "2-digit", month: "short" });
}
function initials(name) {
  return String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}
function fmtDate(ymd) {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { day: "2-digit", month: "short" });
}

function Icon({ d, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: d }} />
  );
}
const IC = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  order: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  bellOff: '<path d="M13.7 21a2 2 0 0 1-3.4 0M18 8a6 6 0 0 0-9.3-5M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14M3 3l18 18"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};

// ---------- the page ----------
export default function TeamChat() {
  const [params, setParams] = useSearchParams();
  const roomId = Number(params.get("room")) || null;
  const settingsOpen = params.get("tab") === "settings";
  const wide = useWide(900);
  const shellRef = useRef(null);
  const height = useFillHeight(shellRef);

  const [cfg, setCfg] = useState(null);
  const [cfgError, setCfgError] = useState("");
  const [rooms, setRooms] = useState([]);
  const [roomsAt, setRoomsAt] = useState(0);
  const [newChat, setNewChat] = useState(false);

  useEffect(() => {
    apiRequest(`${CHAT}/config`).then(setCfg).catch((e) => setCfgError(e.message));
  }, []);

  async function loadRooms() {
    const r = await apiRequest(`${CHAT}/rooms`);
    setRooms(r);
    setRoomsAt(Date.now());
  }
  useEffect(() => { if (cfg) loadRooms().catch(() => {}); }, [cfg]);
  // The list is asked often only when it is all you are looking at (a phone
  // showing the list); next to an open chat, every 30 s is plenty.
  const listEvery = cfg ? (!wide && !roomId ? cfg.poll_open_s : Math.max(30, cfg.poll_open_s)) : 0;
  usePolling(loadRooms, settingsOpen ? 0 : listEvery, [listEvery, settingsOpen]);

  function openRoom(id) { setParams(id ? { room: String(id) } : {}); }

  if (cfgError) {
    return (<><TopBar title="Team Chat" /><div className="tc-page"><div className="card">{cfgError}</div></div></>);
  }

  if (settingsOpen && cfg?.can_manage) {
    return (
      <>
        <TopBar title="Team Chat · Settings" />
        <div className="tc-page"><TeamChatSettings onBack={() => setParams({})} /></div>
      </>
    );
  }

  const narrow = !wide;
  const showList = wide || !roomId;
  const showThread = wide || !!roomId;

  return (
    <>
      <TopBar title="Team Chat" />
      <div className="tc-page">
        <div ref={shellRef} className={`tc-shell${narrow ? " narrow" : ""}`} style={{ height }}>
          {showList && (
            <RoomList
              rooms={rooms} activeId={roomId} onOpen={openRoom} updatedAt={roomsAt}
              pollS={cfg?.poll_open_s} canSend={!!cfg?.can_send} canManage={!!cfg?.can_manage}
              onNew={() => setNewChat(true)} onSettings={() => setParams({ tab: "settings" })}
            />
          )}
          {showThread && (roomId && cfg ? (
            <Thread key={roomId} roomId={roomId} cfg={cfg} narrow={narrow}
              onBack={() => openRoom(null)} onActivity={() => loadRooms().catch(() => {})} />
          ) : (
            <div className="tc-thread"><div className="tc-empty">{cfg ? "Pick a chat on the left." : "Loading…"}</div></div>
          ))}
        </div>
      </div>
      {newChat && (
        <NewChatDialog onClose={() => setNewChat(false)}
          onOpened={(id) => { setNewChat(false); loadRooms().catch(() => {}); openRoom(id); }} />
      )}
    </>
  );
}

// ---------- chat list ----------
function RoomList({ rooms, activeId, onOpen, onNew, onSettings, updatedAt, pollS, canSend, canManage }) {
  const [q, setQ] = useState("");
  useTicker(5000);
  const ql = q.trim().toLowerCase();
  const match = (r) => !ql || String(r.name || "").toLowerCase().includes(ql) || String(r.last_text || "").toLowerCase().includes(ql);
  const groups = rooms.filter((r) => r.kind === "group" && match(r));
  const direct = rooms.filter((r) => r.kind === "direct" && match(r));
  const stale = updatedAt && Date.now() - updatedAt > 90_000;

  const row = (r) => {
    const ann = r.post_policy === "admins";
    return (
      <button key={r.id} type="button" className={`tc-room${r.id === activeId ? " active" : ""}`} onClick={() => onOpen(r.id)}>
        <span className={`tc-av ${r.kind === "direct" ? "person" : ann ? "ann" : "group"}`}>
          {r.kind === "direct" ? initials(r.name) : ann ? "!" : "#"}
        </span>
        <span className="tc-room-main">
          <span className="tc-room-name">
            {r.name}
            {r.muted && <span className="tc-muted-ico" title="Muted"><Icon d={IC.bellOff} size={13} /></span>}
          </span>
          <span className="tc-room-prev" style={{ display: "block" }}>
            {r.last_text
              ? <>{r.kind === "group" && r.last_user_name ? `${r.last_user_name.split(" ")[0]}: ` : ""}{r.last_text}</>
              : ann ? "Only the Administrator posts here" : r.kind === "direct" && r.other_role ? ROLE_NAMES[r.other_role] || r.other_role : "No messages yet"}
          </span>
        </span>
        <span className="tc-room-side">
          <span className="tc-time">{listTime(r.last_message_at)}</span>
          {r.unread > 0 && <span className="tc-unread" aria-label={`${r.unread} unread`}>{r.unread > 99 ? "99+" : r.unread}</span>}
        </span>
      </button>
    );
  };

  return (
    <div className="tc-list">
      <div className="tc-list-head">
        <input type="search" aria-label="Search chats" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
        {canSend && (
          <button type="button" className="tc-icon-btn" onClick={onNew} aria-label="New chat with a person" title="New chat with a person">
            <Icon d={IC.plus} />
          </button>
        )}
        {canManage && (
          <button type="button" className="tc-icon-btn" onClick={onSettings} aria-label="Team Chat settings" title="Team Chat settings">
            <Icon d={IC.gear} />
          </button>
        )}
      </div>
      <div className="tc-status">
        <span className={`tc-dot${stale ? " stale" : ""}`} />
        Updated {ago(updatedAt)}{pollS ? ` · checks every ${pollS} s while a chat is open` : ""}
      </div>
      <div className="tc-rooms">
        {groups.length > 0 && <div className="tc-section">Groups</div>}
        {groups.map(row)}
        {direct.length > 0 && <div className="tc-section">Direct</div>}
        {direct.map(row)}
        {!groups.length && !direct.length && (
          <div className="tc-empty" style={{ minHeight: 160 }}>
            {ql ? "No chat matches that." : "You are not in any chat yet. The Administrator adds people to groups in Team Chat settings."}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- one chat ----------
function Thread({ roomId, cfg, narrow, onBack, onActivity }) {
  const [room, setRoom] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [reads, setReads] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [polledAt, setPolledAt] = useState(0);
  const [pollS, setPollS] = useState(cfg.poll_open_s);
  const [showMembers, setShowMembers] = useState(false);
  const [orderView, setOrderView] = useState(null);
  const [photoView, setPhotoView] = useState(null);
  const [picked, setPicked] = useState(null); // message id whose actions are open

  const lastIdRef = useRef(0);      // newest id the server has shown us (never set from our own send)
  const readRef = useRef(0);        // newest id we have told the server we read
  const listRef = useRef(null);
  const stickRef = useRef(true);
  const keepRef = useRef(null);     // scroll anchor while older messages are added above

  const meId = cfg.me.id;

  function markRead(id) {
    if (!id || id <= readRef.current || document.hidden) return;
    readRef.current = id;
    apiRequest(`${CHAT}/rooms/${roomId}/read`, { method: "POST", body: { last_id: id } })
      .then(() => { bumpChatBadge(); onActivity(); }).catch(() => {});
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([apiRequest(`${CHAT}/rooms/${roomId}`), apiRequest(`${CHAT}/rooms/${roomId}/messages`)])
      .then(([r, m]) => {
        if (!alive) return;
        setRoom(r);
        setMsgs(m.messages);
        setReads(m.reads);
        setHasMore(m.has_more);
        if (m.poll_open_s) setPollS(m.poll_open_s);
        const last = m.messages.length ? m.messages[m.messages.length - 1].id : 0;
        lastIdRef.current = last;
        stickRef.current = true;
        setPolledAt(Date.now());
        markRead(last);
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  function merge(incoming) {
    if (!incoming.length) return;
    setMsgs((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const add = incoming.filter((m) => !seen.has(m.id));
      return add.length ? [...prev, ...add].sort((a, b) => a.id - b.id) : prev;
    });
  }

  usePolling(async () => {
    if (loading || error) return;
    const r = await apiRequest(`${CHAT}/rooms/${roomId}/messages?after=${lastIdRef.current}`);
    setPolledAt(Date.now());
    setReads(r.reads);
    if (r.poll_open_s && r.poll_open_s !== pollS) setPollS(r.poll_open_s);
    if (r.deleted_ids?.length) {
      const del = new Set(r.deleted_ids);
      setMsgs((prev) => prev.map((m) => (del.has(m.id) && !m.deleted ? { ...m, deleted: true, body: null, photo: null, order: null } : m)));
    }
    if (r.messages.length) {
      merge(r.messages);
      lastIdRef.current = r.messages[r.messages.length - 1].id;
      if (r.messages.some((m) => m.user_id !== meId)) { markRead(lastIdRef.current); onActivity(); }
    }
  }, pollS, [roomId, loading, error, pollS]);

  // Coming back to the app: tell the server what is now on screen.
  useEffect(() => {
    const on = () => { if (!document.hidden) markRead(lastIdRef.current); };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Keep the view at the newest message unless the person has scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (keepRef.current) {
      el.scrollTop = el.scrollHeight - keepRef.current.height + keepRef.current.top;
      keepRef.current = null;
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [msgs]);

  function onScroll() {
    const el = listRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  }

  async function loadOlder() {
    if (!msgs.length) return;
    const el = listRef.current;
    const r = await apiRequest(`${CHAT}/rooms/${roomId}/messages?before=${msgs[0].id}`);
    if (el) keepRef.current = { height: el.scrollHeight, top: el.scrollTop };
    setHasMore(r.has_more);
    setMsgs((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      return [...r.messages.filter((m) => !seen.has(m.id)), ...prev];
    });
  }

  async function onSent(m) {
    stickRef.current = true;
    merge([m]);
    onActivity();
  }

  async function del(m) {
    if (!window.confirm("Delete this message for everyone?")) return;
    try {
      await apiRequest(`${CHAT}/messages/${m.id}`, { method: "DELETE" });
      setMsgs((prev) => prev.map((x) => (x.id === m.id ? { ...x, deleted: true, body: null, photo: null, order: null } : x)));
      setPicked(null);
      onActivity();
    } catch (e) { window.alert(e.message); }
  }

  async function toggleMute() {
    try {
      const r = await apiRequest(`${CHAT}/rooms/${roomId}/mute`, { method: "POST", body: { muted: !room.muted } });
      setRoom((x) => ({ ...x, muted: r.muted }));
      bumpChatBadge();
      onActivity();
    } catch (e) { window.alert(e.message); }
  }

  useTicker(5000);
  const mentionRe = useMemo(() => {
    const names = (room?.members || []).map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return names.length ? new RegExp(`(@(?:${names.join("|")}))`, "gi") : null;
  }, [room]);

  if (error) {
    return (
      <div className="tc-thread">
        {narrow && <div className="tc-head"><button type="button" className="tc-icon-btn" onClick={onBack} aria-label="Back to chats"><Icon d={IC.back} /></button></div>}
        <div className="tc-empty">{error}</div>
      </div>
    );
  }

  const others = (room?.members || []).filter((m) => m.id !== meId);
  const sub = room
    ? room.kind === "direct"
      ? `${ROLE_NAMES[others[0]?.role] || others[0]?.role || ""} · updated ${ago(polledAt)}`
      : `${room.members.length} members · updated ${ago(polledAt)}`
    : "Loading…";

  // Day separators + "Seen by N" under my own messages.
  const items = [];
  let lastDay = null;
  for (const m of msgs) {
    const d = new Date(m.created_at);
    const key = d.toDateString();
    if (key !== lastDay) { items.push({ day: dayLabel(d), key: `d-${key}` }); lastDay = key; }
    items.push({ m, key: m.id });
  }

  function seenText(m) {
    const n = reads.filter((r) => r >= m.id).length;
    if (!n) return "Sent";
    return room?.kind === "direct" ? "Seen" : `Seen by ${n}`;
  }

  function renderBody(text) {
    if (!text) return null;
    if (!mentionRe) return text;
    return text.split(mentionRe).map((part, i) => (i % 2 ? <span key={i} className="tc-mention">{part}</span> : part));
  }

  return (
    <div className="tc-thread">
      <div className="tc-head">
        {narrow && (
          <button type="button" className="tc-icon-btn" onClick={onBack} aria-label="Back to chats"><Icon d={IC.back} /></button>
        )}
        <div className="tc-head-main">
          <div className="tc-head-name">{room?.name || "…"}</div>
          <div className="tc-head-sub">{sub}</div>
        </div>
        {room && (
          <>
            <button type="button" onClick={toggleMute} aria-pressed={room.muted} title={room.muted ? "You get no phone notifications for this chat" : "Stop phone notifications for this chat"}>
              {room.muted ? "Unmute" : "Mute"}
            </button>
            {room.kind === "group" && <button type="button" onClick={() => setShowMembers(true)}>Members</button>}
          </>
        )}
      </div>

      <div className="tc-msgs" ref={listRef} onScroll={onScroll}>
        {hasMore && <button type="button" className="tc-more" onClick={loadOlder}>Show earlier messages</button>}
        {loading && <div className="tc-empty">Loading…</div>}
        {!loading && !msgs.length && <div className="tc-empty">No messages yet. Say hello.</div>}
        {items.map((it) => {
          if (it.day) return <div key={it.key} className="tc-day">{it.day}</div>;
          const m = it.m;
          const mine = m.user_id === meId;
          const canDelete = !m.deleted && ((mine && Date.now() - new Date(m.created_at).getTime() < 24 * 3600_000) || cfg.can_manage);
          return (
            <div key={it.key} className={`tc-msg ${mine ? "mine" : "theirs"}`}>
              <div className="tc-bubble" onClick={() => canDelete && setPicked(picked === m.id ? null : m.id)}
                role={canDelete ? "button" : undefined} tabIndex={canDelete ? 0 : undefined}
                onKeyDown={(e) => { if (canDelete && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setPicked(picked === m.id ? null : m.id); } }}>
                {!mine && room?.kind === "group" && <div className="tc-who">{m.user_name}</div>}
                {m.deleted ? (
                  <span className="tc-deleted">Message deleted</span>
                ) : (
                  <>
                    {m.order && (
                      <button type="button" className="tc-order" onClick={(e) => { e.stopPropagation(); setOrderView(m.order.id); }}>
                        <Icon d={IC.order} size={16} />
                        <span><b>{formatOrderNumber(m.order.id)}</b> · {m.order.customer} · {m.order.site}<br />
                          {[m.order.grade, m.order.qty != null ? `${m.order.qty} m³` : null, fmtDate(m.order.date)].filter(Boolean).join(" · ")}</span>
                      </button>
                    )}
                    {m.photo && <PhotoThumb photo={m.photo} onOpen={(url) => setPhotoView(url)} />}
                    {m.body && <div>{renderBody(m.body)}</div>}
                  </>
                )}
                <div className="tc-meta">{clock(new Date(m.created_at))}{mine && !m.deleted ? ` · ${seenText(m)}` : ""}</div>
              </div>
              {picked === m.id && canDelete && (
                <div className="tc-actions">
                  <button type="button" className="btn-danger" onClick={() => del(m)}>Delete for everyone</button>
                  <button type="button" onClick={() => setPicked(null)}>Cancel</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {room && (room.can_post ? (
        <Composer roomId={roomId} members={others} photosAllowed={cfg.photos_allowed} narrow={narrow} onSent={onSent} />
      ) : (
        <div className="tc-compose"><div className="tc-readonly">
          {room.post_policy === "admins" ? "Only the Administrator posts in this group." : "You can read this chat but not send messages."}
        </div></div>
      ))}

      {showMembers && room && (
        <div className="tc-overlay" onClick={() => setShowMembers(false)} role="presentation">
          <div className="tc-dialog" role="dialog" aria-label="Members" onClick={(e) => e.stopPropagation()}>
            <div className="tc-dialog-head"><h2>{room.name} · {room.members.length} members</h2><button type="button" onClick={() => setShowMembers(false)}>Close</button></div>
            <div className="tc-dialog-body">
              {room.members.map((p) => (
                <div key={p.id} className="tc-pick" style={{ cursor: "default" }}>
                  <span className="tc-av person" style={{ width: 34, height: 34, fontSize: 12 }}>{initials(p.name)}</span>
                  <span>{p.name}{p.id === meId ? " (you)" : ""}<br /><small>{ROLE_NAMES[p.role] || p.role}</small></span>
                </div>
              ))}
              <p style={{ fontSize: 12, color: "var(--slate)", marginBottom: 0 }}>Members come from the group's roles. The Administrator changes them in Team Chat settings.</p>
            </div>
          </div>
        </div>
      )}
      {orderView && <OrderDetailModal orderId={orderView} onClose={() => setOrderView(null)} />}
      {photoView && (
        <div className="tc-overlay tc-viewer" onClick={() => setPhotoView(null)} role="presentation">
          <img src={photoView} alt="Photo from the chat" />
        </div>
      )}
    </div>
  );
}

function PhotoThumb({ photo, onOpen }) {
  const [url, setUrl] = useState(null);
  const [gone, setGone] = useState(photo.expired);
  useEffect(() => {
    if (photo.expired) return undefined;
    let alive = true;
    loadChatPhoto(photo.id).then((u) => { if (!alive) return; if (u) setUrl(u); else setGone(true); });
    return () => { alive = false; };
  }, [photo.id, photo.expired]);
  const ratio = photo.w && photo.h ? photo.h / photo.w : 0.75;
  if (gone) return <div className="tc-photo"><div className="tc-photo-gone">Photo expired</div></div>;
  return (
    <button type="button" className="tc-photo" onClick={(e) => { e.stopPropagation(); if (url) onOpen(url); }} aria-label="Open photo">
      {url ? <img src={url} alt="Photo from the chat" /> : <div style={{ width: 240, height: Math.min(320, Math.round(240 * ratio)) }} />}
    </button>
  );
}

// ---------- writing a message ----------
function Composer({ roomId, members, photosAllowed, narrow, onSent }) {
  const [text, setText] = useState(() => { try { return sessionStorage.getItem(`oorm_chat_draft_${roomId}`) || ""; } catch { return ""; } });
  const [photo, setPhoto] = useState(null);
  const [order, setOrder] = useState(null);
  const [pickOrder, setPickOrder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [err, setErr] = useState("");
  const [mention, setMention] = useState(null); // { q, start }
  const taRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    try { if (text) sessionStorage.setItem(`oorm_chat_draft_${roomId}`, text); else sessionStorage.removeItem(`oorm_chat_draft_${roomId}`); } catch { /* ignore */ }
  }, [text, roomId]);

  function onChange(e) {
    const v = e.target.value;
    setText(v);
    const caret = e.target.selectionStart ?? v.length;
    const m = v.slice(0, caret).match(/(^|\s)@([^\s@]{0,20})$/);
    setMention(m ? { q: m[2].toLowerCase(), start: caret - m[2].length - 1 } : null);
  }

  const suggestions = mention
    ? members.filter((p) => p.name.toLowerCase().includes(mention.q)).slice(0, 5)
    : [];

  function pickMention(p) {
    const caret = taRef.current?.selectionStart ?? text.length;
    const v = `${text.slice(0, mention.start)}@${p.name} ${text.slice(caret)}`;
    setText(v);
    setMention(null);
    setTimeout(() => {
      const pos = mention.start + p.name.length + 2;
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos, pos);
    }, 0);
  }

  async function onFile(e) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setErr(""); setPreparing(true);
    try { setPhoto(await shrinkPhoto(f)); } catch (x) { setErr(x.message); } finally { setPreparing(false); }
  }

  async function send() {
    const body = text.trim();
    if (busy || preparing || (!body && !photo && !order)) return;
    setBusy(true); setErr("");
    try {
      const m = await apiRequest(`${CHAT}/rooms/${roomId}/messages`, {
        method: "POST",
        body: {
          body,
          order_id: order?.id || null,
          photo: photo ? { mime: photo.mime, data: photo.data, width: photo.width, height: photo.height } : null,
        },
      });
      setText(""); setPhoto(null); setOrder(null); setMention(null);
      onSent(m);
      taRef.current?.focus();
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e) {
    if (suggestions.length && (e.key === "Enter" || e.key === "Tab")) { e.preventDefault(); pickMention(suggestions[0]); return; }
    if (e.key === "Escape") setMention(null);
    // On a computer Enter sends (Shift+Enter for a new line); on a phone the
    // keyboard's Enter is a new line and the arrow button sends.
    if (!narrow && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  const rows = Math.min(5, Math.max(1, text.split("\n").length));

  return (
    <div className="tc-compose">
      {err && <div className="tc-error">{err}</div>}
      {suggestions.length > 0 && (
        <div className="tc-suggest" role="listbox" aria-label="Mention someone">
          {suggestions.map((p) => (
            <button key={p.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pickMention(p)}>
              @{p.name} <small style={{ color: "var(--slate)" }}>{ROLE_NAMES[p.role] || p.role}</small>
            </button>
          ))}
        </div>
      )}
      {(photo || order || preparing) && (
        <div className="tc-attach">
          {preparing && <span className="tc-attach-chip">Preparing photo…</span>}
          {photo && (
            <span className="tc-attach-chip">
              <img src={photo.preview} alt="Photo to send" />
              {Math.round(photo.bytes / 1024)} KB
              <button type="button" onClick={() => setPhoto(null)} aria-label="Remove photo">Remove</button>
            </span>
          )}
          {order && (
            <span className="tc-attach-chip">
              <Icon d={IC.order} size={16} />
              {formatOrderNumber(order.id)} · {order.customer}
              <button type="button" onClick={() => setOrder(null)} aria-label="Remove order">Remove</button>
            </span>
          )}
        </div>
      )}
      <div className="tc-compose-row">
        {photosAllowed && (
          <>
            <button type="button" className="tc-send" onClick={() => fileRef.current?.click()} aria-label="Attach a photo" title="Attach a photo" disabled={busy || preparing}>
              <Icon d={IC.camera} />
            </button>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onFile} />
          </>
        )}
        <button type="button" className="tc-send" onClick={() => setPickOrder(true)} aria-label="Link an order" title="Link an order" disabled={busy}>
          <Icon d={IC.order} />
        </button>
        <textarea ref={taRef} rows={rows} value={text} onChange={onChange} onKeyDown={onKeyDown} aria-label="Message"
          placeholder={narrow ? "Message" : "Type a message — @ to mention someone"} maxLength={4000} />
        <button type="button" className="tc-send btn-primary" onClick={send} aria-label="Send" disabled={busy || preparing || (!text.trim() && !photo && !order)}>
          <Icon d={IC.send} />
        </button>
      </div>
      {pickOrder && <OrderPicker onClose={() => setPickOrder(false)} onPick={(o) => { setOrder(o); setPickOrder(false); }} />}
    </div>
  );
}

function OrderPicker({ onClose, onPick }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      apiRequest(`${CHAT}/orders?q=${encodeURIComponent(q.trim())}`).then(setRows).catch((e) => setErr(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="tc-overlay" onClick={onClose} role="presentation">
      <div className="tc-dialog" role="dialog" aria-label="Link an order" onClick={(e) => e.stopPropagation()}>
        <div className="tc-dialog-head"><h2>Link an order</h2><button type="button" onClick={onClose}>Close</button></div>
        <div className="tc-dialog-body">
          <input type="search" autoFocus placeholder="Order number, customer or site" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search orders" />
          {err && <div className="tc-error">{err}</div>}
          {rows === null && <p style={{ color: "var(--slate)", fontSize: 13 }}>Loading…</p>}
          {rows && !rows.length && <p style={{ color: "var(--slate)", fontSize: 13 }}>No order found in the last 30 days and ahead.</p>}
          {rows?.map((o) => (
            <button key={o.id} type="button" className="tc-pick" onClick={() => onPick(o)}>
              <Icon d={IC.order} />
              <span><b>{formatOrderNumber(o.id)}</b> · {o.customer}<br />
                <small>{o.site} · {o.grade} · {Number(o.order_quantity_m3)} m³ · {fmtDate(o.order_date)}</small></span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function NewChatDialog({ onClose, onOpened }) {
  const [q, setQ] = useState("");
  const [people, setPeople] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      apiRequest(`${CHAT}/people?q=${encodeURIComponent(q.trim())}`).then(setPeople).catch((e) => setErr(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  async function start(p) {
    try {
      const r = await apiRequest(`${CHAT}/direct`, { method: "POST", body: { user_id: p.id } });
      onOpened(r.id);
    } catch (e) { setErr(e.message); }
  }
  return (
    <div className="tc-overlay" onClick={onClose} role="presentation">
      <div className="tc-dialog" role="dialog" aria-label="New chat" onClick={(e) => e.stopPropagation()}>
        <div className="tc-dialog-head"><h2>New chat with…</h2><button type="button" onClick={onClose}>Close</button></div>
        <div className="tc-dialog-body">
          <input type="search" autoFocus placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
          {err && <div className="tc-error">{err}</div>}
          {people === null && <p style={{ color: "var(--slate)", fontSize: 13 }}>Loading…</p>}
          {people?.map((p) => (
            <button key={p.id} type="button" className="tc-pick" onClick={() => start(p)}>
              <span className="tc-av person" style={{ width: 34, height: 34, fontSize: 12 }}>{initials(p.name)}</span>
              <span>{p.name}<br /><small>{ROLE_NAMES[p.role] || p.role}</small></span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
