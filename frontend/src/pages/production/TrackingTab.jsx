// Round 254 — Production → Vehicle tracking (owner, 31 Oct 2026). The
// running orders' trucks: a map (plant, sites, last GPS of each truck) and,
// per order, each truck on a five-stage bar — Left plant, At site,
// Unloading, Returning, At plant — with a thick line from Left plant to the
// stage it is at and the transit mixer drawn on that stage.
import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { apiRequest } from "../../lib/api.js";
import { formatOrderNumber } from "../../lib/orderNumber.js";
import TransitMixer from "../../lib/TransitMixer.jsx";

const STAGES = ["Left plant", "At site", "Unloading", "Returning", "At plant"];
const REFRESH_MS = 20000;
const sub = { fontSize: 12, color: "var(--slate)" };
const hm = (t) => (t ? new Date(t).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) : "");
const mins = (t) => (t ? Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000)) : null);

const COLOUR = { to: "#2A6F97", site: "#6B4C9A", back: "#1D7A55", late: "#B03A2E", gps: "#9C6B12", done: "#5B6470" };
function colourOf(t) {
  if (t.delayed) return COLOUR.late;
  if (t.gps_stale && t.stage <= 0) return COLOUR.gps;
  if (t.stage <= 0) return COLOUR.to;
  if (t.stage <= 2) return COLOUR.site;
  if (t.stage === 3) return COLOUR.back;
  return COLOUR.done;
}
function pill(t) {
  if (t.stage === 4) return ["Completed", "badge-neutral"];
  if (t.delayed) return [`At site ${t.minutes_at_site} min`, "badge-danger"];
  if (t.stage === -1) return ["Loading at plant", "badge-neutral"];
  if (t.stage === 0) return t.gps_stale && t.gps_age_min != null ? [`GPS ${t.gps_age_min} min old`, "badge-warning"] : [`To site${t.eta_at ? ` · ETA ${hm(t.eta_at)}` : ""}`, "badge-info"];
  if (t.stage === 1) return [`At site ${t.minutes_at_site} min`, "badge-progress"];
  if (t.stage === 2) return [`Unloading ${mins(t.unloading_started_at)} min`, "badge-progress"];
  return [`Returning${t.eta_at ? ` · ETA ${hm(t.eta_at)}` : ""}`, "badge-success"];
}
function note(t) {
  if (t.stage === -1) return `Ticket ${hm(t.created_at)} · ${t.loaded_quantity_m3} m³ · not left the plant yet`;
  if (t.stage === 0) {
    const gps = t.gps_age_min == null ? "no GPS yet" : `GPS ${t.gps_age_min} min ago`;
    return t.gps_stale ? `ETA worked out from the distance and plant-out time · ${gps}` : `On the way · ${gps} · ${t.loaded_quantity_m3} m³`;
  }
  if (t.stage === 1) return `Reached site ${hm(t.reached_site_at)} · not unloading yet${t.site_delay_reason ? ` · reason: ${t.site_delay_reason}` : ""}`;
  if (t.stage === 2) return `Reached site ${hm(t.reached_site_at)} · unloading since ${hm(t.unloading_started_at)}`;
  if (t.stage === 3) return `Unloaded ${hm(t.unloading_completed_at)}`;
  const trip = t.left_plant_at && t.returned_at ? Math.round((new Date(t.returned_at) - new Date(t.left_plant_at)) / 60000) : null;
  return `Back at plant ${hm(t.returned_at)}${trip != null ? ` · trip ${trip} min` : ""}`;
}
function stageCaption(t, i) {
  if (i === 0) return t.left_plant_at ? hm(t.left_plant_at) : t.stage === -1 ? "loading" : "";
  if (i === 1 && t.stage === 1) return t.delayed ? "waiting" : `since ${hm(t.reached_site_at)}`;
  if (i === 2 && t.stage === 2) return `since ${hm(t.unloading_started_at)}`;
  if (i === 3 && t.stage === 3 && t.eta_at) return `ETA ${hm(t.eta_at)}`;
  if (i === 4 && t.stage === 4) return hm(t.returned_at);
  return "";
}

// The five-stage bar with the thick line and the truck on the current stage.
export function StageBar({ t }) {
  const at = Math.max(0, t.stage);
  const lineColour = t.delayed ? "#B03A2E" : "#1D7A55";
  const centre = 10 + at * 20; // % — the middle of the stage's column
  return (
    <div style={{ position: "relative", paddingTop: 66 }}>
      <div style={{ position: "absolute", top: 76, left: "10%", right: "10%", height: 6, borderRadius: 3, background: "#E3E0D8" }} />
      <div style={{ position: "absolute", top: 76, left: "10%", width: `${at * 20}%`, height: 6, borderRadius: 3, background: lineColour }} />
      <div style={{ position: "absolute", top: 0, width: 122, height: 60, left: `clamp(0px, calc(${centre}% - 61px), calc(100% - 122px))`, opacity: t.stage === -1 || (t.gps_stale && t.stage === 0) ? 0.55 : 1 }}>
        <TransitMixer returning={t.stage >= 3} chute={t.stage === 2} title={`Transit mixer ${t.truck_number || ""} — ${STAGES[at]}`} />
      </div>
      <div style={{ position: "relative", display: "flex" }}>
        {STAGES.map((label, i) => {
          const done = t.stage === 4 ? true : i < at || (i === at && false);
          const now = t.stage !== 4 && t.stage >= 0 && i === at;
          const late = now && t.delayed;
          const colour = late ? "#B03A2E" : now ? "#C75B12" : done ? "#1D7A55" : "var(--slate)";
          const cap = stageCaption(t, i);
          return (
            <div key={label} style={{ flex: "1 1 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, fontSize: 10.5, color: colour, fontWeight: now ? 700 : 400, textAlign: "center", lineHeight: 1.25 }}>
              <i style={{
                width: 20, height: 20, borderRadius: "50%", display: "block", boxSizing: "border-box",
                background: now ? colour : done ? "#1D7A55" : "#fff", border: `3px solid ${now ? "#fff" : done ? "#1D7A55" : "#D5D1C7"}`,
                boxShadow: now ? `0 0 0 3px ${colour}` : undefined,
              }} />
              <span>{label}{cap && <><br />{cap}</>}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TrackingMap({ data, orders, focus }) {
  const el = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const fitted = useRef(false);

  useEffect(() => {
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([10.0, 76.3], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => { map.current.remove(); map.current = null; };
  }, []);

  function points() {
    const pts = [];
    if (data?.plant) pts.push([data.plant.lat, data.plant.lng]);
    for (const o of orders) {
      if (o.site) pts.push([o.site.lat, o.site.lng]);
      for (const t of o.trucks) if (t.lat != null && t.stage < 4) pts.push([t.lat, t.lng]);
    }
    return pts;
  }
  function fit() {
    const pts = points();
    if (!map.current || !pts.length) return;
    if (pts.length === 1) map.current.setView(pts[0], 13);
    else map.current.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
  }

  useEffect(() => {
    if (!layer.current) return;
    layer.current.clearLayers();
    const tag = (text, colour, square) => L.divIcon({
      className: "",
      html: `<div style="display:flex;align-items:center;gap:4px;transform:translate(-9px,-9px)"><span style="width:${square ? 18 : 14}px;height:${square ? 18 : 14}px;border-radius:${square ? 4 : 50}${square ? "px" : "%"};background:${colour};border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);flex:none"></span><span style="background:#fff;border:1px solid ${colour === COLOUR.late || colour === COLOUR.gps ? colour : "#C8C2B5"};color:${colour === COLOUR.late ? COLOUR.late : colour === COLOUR.gps ? "#7a5410" : "#22262B"};border-radius:6px;padding:1px 6px;font-size:11.5px;font-weight:600;white-space:nowrap">${text}</span></div>`,
      iconSize: [0, 0],
    });
    const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    if (data?.plant) L.marker([data.plant.lat, data.plant.lng], { icon: tag("Plant", "#22262B", true) }).addTo(layer.current);
    for (const o of orders) {
      if (o.site) {
        L.circle([o.site.lat, o.site.lng], { radius: o.site.radius_m, color: "#7A4BA8", weight: 2, dashArray: "4 4", fillOpacity: 0.05 }).addTo(layer.current);
        L.marker([o.site.lat, o.site.lng], { icon: tag(esc(o.site_name), "#7A4BA8", true) }).addTo(layer.current);
      }
      for (const t of o.trucks) {
        if (t.lat == null || t.stage >= 4) continue;
        const what = t.delayed ? `at site ${t.minutes_at_site} min` : t.gps_stale ? `last GPS ${t.gps_age_min} min` : ["→ site", "at site", "unloading", "returning"][Math.max(0, t.stage)];
        L.marker([t.lat, t.lng], { icon: tag(`${esc(t.truck_number)} ${what}`, colourOf(t)) }).addTo(layer.current);
      }
    }
    if (!fitted.current && points().length) { fit(); fitted.current = true; }
  }, [data, orders]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fitted.current = false; fit(); }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: "relative" }}>
      <div ref={el} role="img" aria-label="Map with the plant, sites and trucks" style={{ height: 560, background: "#EEF0E8" }} />
      <div style={{ position: "absolute", left: 12, bottom: 24, zIndex: 500, background: "#fff", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5 }}>
        {[["To site", COLOUR.to], ["At site / unloading", COLOUR.site], ["Returning", COLOUR.back], ["Delayed", COLOUR.late], ["GPS not updating", COLOUR.gps]].map(([l, c]) => (
          <span key={l}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: c, marginRight: 4 }} />{l}</span>
        ))}
      </div>
      <button type="button" onClick={() => { fitted.current = false; fit(); }} style={{ position: "absolute", right: 12, top: 12, zIndex: 500, minHeight: 40 }}>Fit all</button>
      {!data?.plant && <div style={{ position: "absolute", right: 12, bottom: 24, zIndex: 500, background: "#fff", borderRadius: 8, padding: "6px 10px", ...sub }}>Plant location not set (Administrator → Plant Location)</div>}
    </div>
  );
}

export default function TrackingTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all"); // all | delayed | <order id>
  const [showDone, setShowDone] = useState(false);
  const [tick, setTick] = useState(0);

  async function load() {
    try { setData(await apiRequest("/production/tracking")); setError(""); } catch (e) { setError(e.message); }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    const s = setInterval(() => setTick((x) => x + 1), 5000);
    return () => { clearInterval(t); clearInterval(s); };
  }, []);

  async function siteDelayReason(t) {
    const reason = window.prompt(`Reason ${t.truck_number} is waiting at site:`);
    if (!reason) return;
    try { await apiRequest(`/orders/tickets/${t.ticket_id}/site-delay-reason`, { method: "POST", body: { reason } }); load(); } catch (e) { setError(e.message); }
  }

  const running = useMemo(() => (data?.orders || []).filter((o) => o.trucks.some((t) => t.stage < 4)), [data]);
  const shown = useMemo(() => {
    let list = data?.orders || [];
    if (filter === "delayed") list = list.map((o) => ({ ...o, trucks: o.trucks.filter((t) => t.delayed) })).filter((o) => o.trucks.length);
    else if (filter !== "all") list = list.filter((o) => String(o.order_id) === filter);
    else list = showDone ? list : running;
    return list;
  }, [data, filter, showDone, running]);

  const tl = data?.tiles;
  const ago = data ? Math.round((Date.now() - new Date(data.updated_at).getTime()) / 1000) : null;
  void tick;
  return (
    <>
      {error && <div className="card" style={{ marginBottom: 10, color: "var(--alert-red)", background: "var(--alert-red-bg)", fontSize: 13 }}>{error}</div>}
      {tl && (
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
          <Tile label="Running orders" value={tl.orders} />
          <Tile label="To site" value={tl.to_site} colour={COLOUR.to} />
          <Tile label="At site / unloading" value={tl.at_site} colour={COLOUR.site} />
          <Tile label="Returning" value={tl.returning} colour={COLOUR.back} />
          <Tile label="Delayed" value={tl.delayed} colour={COLOUR.late} bg={tl.delayed ? "var(--alert-red-bg)" : undefined} />
          <Tile label="No GPS for 10+ min" value={tl.gps_stale} colour={COLOUR.gps} bg={tl.gps_stale ? "var(--amber-bg)" : undefined} />
        </section>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <button type="button" className={`btn-tab ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All running · {running.length}</button>
        {running.map((o) => (
          <button key={o.order_id} type="button" className={`btn-tab ${filter === String(o.order_id) ? "active" : ""}`} onClick={() => setFilter(String(o.order_id))}>{o.customer_name} · {o.site_name}</button>
        ))}
        <button type="button" className={`btn-tab ${filter === "delayed" ? "active" : ""}`} onClick={() => setFilter("delayed")}>Delayed only</button>
        <label style={{ ...sub, display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show finished orders</label>
        <span style={{ ...sub, marginLeft: "auto" }}>{ago != null ? `Updated ${ago} s ago · refreshes every 20 s` : "Loading…"}</span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
        <section className="card" style={{ flex: "999 1 560px", minWidth: 0, padding: 0, overflow: "hidden" }}>
          <TrackingMap data={data} orders={shown} focus={filter} />
        </section>
        <aside className="card" style={{ flex: "1 1 420px", minWidth: 0, padding: 0, overflow: "hidden" }}>
          {shown.map((o, oi) => (
            <div key={o.order_id}>
              <div style={{ padding: "12px 14px", background: "#FBF8F2", borderBottom: "1px solid var(--border)", borderTop: oi ? "1px solid var(--border)" : undefined }}>
                <b>{formatOrderNumber(o.order_id)} · {o.customer_name}</b>
                <div style={sub}>{o.site_name} · {o.grade}{o.mix_code ? ` · ${o.mix_code}` : ""} · {o.supplied} / {o.order_quantity_m3} m³{o.distance_km != null ? ` · ${o.distance_km} km` : ""}</div>
              </div>
              {o.trucks.map((t) => {
                const [label, cls] = pill(t);
                return (
                  <div key={t.ticket_id} style={{ borderTop: "1px solid var(--border)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, background: t.delayed ? "#FDF4F2" : undefined }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <span><b>{t.truck_number || "—"}</b> · {t.driver_name || "—"} · {t.ticket_number}</span>
                      <span className={`badge ${cls}`}>{label}</span>
                    </div>
                    <StageBar t={t} />
                    <div style={sub}>{note(t)}</div>
                    {t.delayed && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {t.driver_phone && <a href={`tel:${t.driver_phone}`}><button type="button">Call driver</button></a>}
                        {o.site_contact && <a href={`tel:${o.site_contact}`}><button type="button">Call site</button></a>}
                        {!t.site_delay_reason && <button type="button" onClick={() => siteDelayReason(t)}>Site delay reason</button>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {data && shown.length === 0 && <div style={{ padding: 16, ...sub }}>No trucks out right now.</div>}
        </aside>
      </div>
    </>
  );
}

function Tile({ label, value, colour, bg }) {
  return (
    <div className="card" style={{ padding: "12px 14px", background: bg, borderColor: bg ? colour : undefined }}>
      <div style={{ ...sub, color: bg ? colour : sub.color }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: colour }}>{value}</div>
    </div>
  );
}
