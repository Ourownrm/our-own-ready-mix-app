// Round 256 — the side menu on a computer (owner, 31 Oct 2026: "Side menu …
// when you click on side menu the side bar should open and show the sub menus
// and from there we can easily navigate to next menu"; phone screens stay as
// they are). Mock-up: claude/home-navigation-mockup-v1.md.
//
// Shown only on a wide screen (MIN_WIDTH and up), to a signed-in person who
// has at least one module, outside the public pages and the emergency lock.
// A phone or tablet never sees it, and nothing on the existing screens moves
// for them.
//
// What it lists is exactly what the person may open today: an Administrator
// gets the Administrator dashboard's modules (visibleAdminModules), everyone
// else the Modules page's (visibleHub). Under each module, its screens: the
// module's own tabs (lib/moduleTabs.js, the same list the page draws its tab
// strip from) or, for a module made of separate screens (Quality Control,
// Sales and Collection …), those screens. A module with nothing under it
// opens straight away.
//
// Six groups, each its own colour, and every module its own icon — the home
// screen's look-alike colours were the owner's complaint. The group name is
// always printed, so colour is never the only clue.
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext.jsx";
import { usePermissions } from "./PermissionContext.jsx";
import { useLocked } from "./lockContext.js";
import { GLYPHS, visibleHub, visibleAdminModules } from "./adminScreens.js";
import { MODULE_TABS, tabAllowed } from "./moduleTabs.js";
import { ROLE_HOME } from "./roleHome.js";
import { isAdminLevel } from "./roles.js";

const MIN_WIDTH = 1100;
const HIDE_KEY = "oorm_side_menu_hidden";

// Public pages and the Delivery Challan module (its own login) never get it.
const HIDDEN_ON = [/^\/login/, /^\/track\//, /^\/solitaire\//, /^\/book\//, /^\/inquiry/, /^\/portal/, /^\/services/, /^\/rmc-vs-sitemix/, /^\/technical-assistance/];

// `ink` is the icon colour on the group colour; `text` the group name's colour
// on white (each ≥ 4.5:1); `soft` the open module's background; `line` the rule
// beside its screens.
export const NAV_GROUPS = [
  { key: "plant", label: "Plant", colour: "#C2410C", ink: "#FFFFFF", text: "#9A3412", soft: "#FFF1E6", line: "#FDBA8C",
    modules: ["production", "plant-production", "weighbridge-receipts", "material-module"] },
  { key: "fleet", label: "Fleet & Fuel", colour: "#F59E0B", ink: "#2A1500", text: "#92400E", soft: "#FEF6DC", line: "#FCD34D",
    modules: ["plant-equipment", "maintenance-module", "maintenance-complaint", "fuel-module", "fuel-lubricants"] },
  { key: "quality", label: "Quality", colour: "#7C3AED", ink: "#FFFFFF", text: "#6D28D9", soft: "#F1ECFE", line: "#C4B5FD",
    modules: ["quality-control"] },
  { key: "sales", label: "Sales", colour: "#1D4ED8", ink: "#FFFFFF", text: "#1D4ED8", soft: "#E8F0FE", line: "#93C5FD",
    modules: ["sales-collection"] },
  { key: "money", label: "Money", colour: "#15803D", ink: "#FFFFFF", text: "#166534", soft: "#E6F6EC", line: "#86EFAC",
    modules: ["accounts-module", "cost-module", "directors-dashboard"] },
  { key: "people", label: "People & Admin", colour: "#334155", ink: "#FFFFFF", text: "#334155", soft: "#EEF1F5", line: "#94A3B8",
    modules: ["hr", "users-roles"] },
];
// A module added to the registry later and not yet placed in a group still shows, here.
const OTHER_GROUP = { key: "other", label: "Other", colour: "#4B5563", ink: "#FFFFFF", text: "#374151", soft: "#F1F2F4", line: "#9CA3AF", modules: [] };

// The side menu's own icon and, where the registry's name reads badly in a
// list, its own name. The phone's tiles keep the registry's.
const NAV_LOOK = {
  production: { icon: "clipboard" },
  "plant-production": { icon: "factory" },
  "weighbridge-receipts": { icon: "scale" },
  "material-module": { icon: "box", label: "Raw Material" },
  "plant-equipment": { icon: "truck", label: "Plant & Equipment" },
  "maintenance-module": { icon: "wrench" },
  "maintenance-complaint": { icon: "alert" },
  "fuel-module": { icon: "pump" },
  "fuel-lubricants": { icon: "droplet", label: "Fuel & Lubricant Reports" },
  "quality-control": { icon: "flask" },
  "sales-collection": { icon: "trend" },
  "accounts-module": { icon: "receipt" },
  "cost-module": { icon: "pie" },
  "directors-dashboard": { icon: "chart" },
  hr: { icon: "people" },
  "users-roles": { icon: "shield" },
};

function Glyph({ name, size = 16, stroke = "currentColor", width = 2 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={width}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: GLYPHS[name] || "" }} />
  );
}

function useWide() {
  const query = `(min-width: ${MIN_WIDTH}px)`;
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => (mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on));
  }, [query]);
  return wide;
}

function pathOf(to) { return to ? to.split("?")[0] : null; }
function paramsOf(to) { return new URLSearchParams(to && to.includes("?") ? to.slice(to.indexOf("?") + 1) : ""); }

// The menu for this person: groups → modules → screens.
export function buildMenu({ admin, can, canScreen, ready }) {
  const mods = admin ? visibleAdminModules(canScreen, ready) : visibleHub(can);
  const out = mods.map((m) => {
    const look = NAV_LOOK[m.key] || {};
    const tabbed = MODULE_TABS[m.key];
    let items = [];
    if (tabbed) {
      items = ready
        ? tabbed.tabs.filter((t) => tabAllowed(t, can)).map((t) => ({ key: t.key, label: t.label, to: `${tabbed.path}?tab=${t.key}` }))
        : [];
    } else if (m.screens.length) {
      items = m.screens.map((s) => ({
        key: s.key,
        label: s.label,
        to: s.to || (admin ? `/administrator?view=${s.view}` : `/modules?module=${m.key}&view=${s.view}`),
      }));
    }
    const to = tabbed ? tabbed.path : (m.to || (m.view ? `/administrator?view=${m.view}` : null));
    return { key: m.key, label: look.label || m.label, icon: look.icon || m.icon, to, base: pathOf(to), items };
  });
  const placed = new Set();
  const groups = NAV_GROUPS.map((g) => {
    const modules = g.modules.map((k) => out.find((m) => m.key === k)).filter(Boolean);
    modules.forEach((m) => placed.add(m.key));
    return { ...g, modules };
  });
  const rest = out.filter((m) => !placed.has(m.key));
  if (rest.length) groups.push({ ...OTHER_GROUP, modules: rest });
  return groups.filter((g) => g.modules.length);
}

// Which module and screen the current page is. A screen matches when its path
// is this page's and every query value it names is in the URL; the one naming
// the most values wins (/rm-tests?tab=done over /rm-tests). A tabbed module
// opened without ?tab= is on its first screen.
function findCurrent(groups, pathname, search) {
  const here = new URLSearchParams(search);
  let best = null;
  for (const g of groups) {
    for (const m of g.modules) {
      for (const it of m.items) {
        if (pathOf(it.to) !== pathname) continue;
        const want = paramsOf(it.to);
        let ok = true; let n = 0;
        want.forEach((v, k) => { n += 1; if (here.get(k) !== v) ok = false; });
        if (ok && (!best || n > best.n)) best = { moduleKey: m.key, itemKey: it.key, n };
      }
    }
  }
  if (best) return best;
  for (const g of groups) {
    for (const m of g.modules) {
      if (!m.base || m.base !== pathname) continue;
      let ok = true;
      paramsOf(m.to).forEach((v, k) => { if (here.get(k) !== v) ok = false; });
      if (!ok) continue;
      const first = m.items[0];
      return { moduleKey: m.key, itemKey: !here.get("tab") && first ? first.key : null, n: 0 };
    }
  }
  return null;
}

export default function SideMenu() {
  const { user } = useAuth();
  const { can, canScreen, ready } = usePermissions();
  const locked = useLocked();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const wide = useWide();
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(HIDE_KEY) === "1"; } catch { return false; } });
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState(null);

  const admin = !!user && isAdminLevel(user.role);
  const groups = useMemo(
    () => (user ? buildMenu({ admin, can, canScreen, ready }) : []),
    [user, admin, can, canScreen, ready],
  );
  const current = useMemo(() => findCurrent(groups, pathname, search), [groups, pathname, search]);

  // Arriving on a module's page (from a link, a tile, the address bar) opens
  // that module in the menu.
  const currentModule = current ? current.moduleKey : null;
  useEffect(() => { if (currentModule) setOpenKey(currentModule); }, [currentModule, pathname]);

  const show = !!user && !locked && wide && groups.length > 0 && !HIDDEN_ON.some((r) => r.test(pathname));

  useEffect(() => {
    const b = document.body.classList;
    b.toggle("with-side-menu", show && !hidden);
    b.toggle("with-side-rail", show && hidden);
    return () => { b.remove("with-side-menu"); b.remove("with-side-rail"); };
  }, [show, hidden]);

  function setHide(v) {
    setHidden(v);
    try { localStorage.setItem(HIDE_KEY, v ? "1" : "0"); } catch { /* storage blocked: only for this visit */ }
  }

  if (!show) return null;

  if (hidden) {
    return (
      <nav className="side-rail" aria-label="Menu">
        <button type="button" className="side-rail-btn" onClick={() => setHide(false)} aria-label="Show menu" title="Show menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
      </nav>
    );
  }

  // Search: a module whose name matches shows all its screens; otherwise only
  // the screens whose names match. Everything that matches is shown open.
  const q = query.trim().toLowerCase();
  const shown = q
    ? groups.map((g) => ({
        ...g,
        modules: g.modules
          .map((m) => (m.label.toLowerCase().includes(q) ? m : { ...m, items: m.items.filter((it) => it.label.toLowerCase().includes(q)) }))
          .filter((m) => m.label.toLowerCase().includes(q) || m.items.length),
      })).filter((g) => g.modules.length)
    : groups;

  const home = user ? ROLE_HOME[user.role] : null;

  function onModule(m) {
    if (!m.items.length) { if (m.to) navigate(m.to); return; }
    setOpenKey((k) => (k === m.key && !q ? null : m.key));
  }

  return (
    <nav className="side-menu" aria-label="Modules">
      <div className="side-menu-head">
        <div className="side-menu-brand">Our Own Ready Mix</div>
        <button type="button" className="side-menu-hide" onClick={() => setHide(true)} aria-label="Hide menu" title="Hide menu">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
        </button>
      </div>
      <label className="side-menu-search">
        <Glyph name="search" size={15} stroke="#374151" width={2.2} />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a screen" aria-label="Find a screen" />
      </label>
      <div className="side-menu-scroll">
        {home && !q && (
          <Link to={home} className={`side-menu-home${pathname === home ? " on" : ""}`} aria-current={pathname === home ? "page" : undefined}>
            <span className="side-menu-icon" style={{ background: "#22262B", color: "#fff" }}><Glyph name="home" size={15} width={2.2} /></span>
            Home
          </Link>
        )}
        {q && shown.length === 0 && <div className="side-menu-empty">No screen called “{query.trim()}”.</div>}
        {shown.map((g) => (
          <div key={g.key} className="side-menu-group">
            <div className="side-menu-group-name" style={{ color: g.text }}>{g.label}</div>
            {g.modules.map((m) => {
              const open = q ? m.items.length > 0 : openKey === m.key && m.items.length > 0;
              const isCurrent = current && current.moduleKey === m.key;
              const rowStyle = { background: isCurrent || open ? g.soft : undefined, fontWeight: isCurrent ? 800 : 600 };
              const icon = (
                <span className="side-menu-icon" style={{ background: g.colour, color: g.ink }}>
                  <Glyph name={m.icon} size={15} width={2.1} />
                </span>
              );
              return (
                <div key={m.key}>
                  {m.items.length ? (
                    <button type="button" className="side-menu-module" style={rowStyle} aria-expanded={open} onClick={() => onModule(m)}>
                      {icon}
                      <span className="side-menu-label">{m.label}</span>
                      <span className="side-menu-chev" style={{ transform: open ? "rotate(90deg)" : "none" }}>
                        <Glyph name="chevron" size={14} stroke="#4B5563" width={2.4} />
                      </span>
                    </button>
                  ) : (
                    <Link to={m.to || "#"} className="side-menu-module" style={rowStyle} aria-current={isCurrent ? "page" : undefined}>
                      {icon}
                      <span className="side-menu-label">{m.label}</span>
                    </Link>
                  )}
                  {open && (
                    <div className="side-menu-items" style={{ borderLeftColor: g.line }}>
                      {m.items.map((it) => {
                        const on = isCurrent && current.itemKey === it.key;
                        return (
                          <Link key={it.key} to={it.to} className={`side-menu-item${on ? " on" : ""}`} aria-current={on ? "page" : undefined}
                            onClick={() => setQuery("")}>
                            {it.label}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
