// Round 192 — the modules a person can open, for every role.
//
// Until now only the Administrator had a modules grid; everybody else reached
// a module through whatever button their own home screen happened to carry,
// and a Super Admin granting, say, the Weighbridge to an Accountant changed
// nothing they could see. This page is built from the same registry as the
// Administrator dashboard (lib/adminScreens.js) and shows a tile only when the
// person holds View on that screen's function — so a grant on the Access
// Control page appears here, and a denied module disappears.
//
// Scope is the user's list of 8 Oct 2026: the four modules in their role ×
// module table plus the Production and Fuel & Lubricants screens. Fuel, HR and
// Accounts modules join when they are built.
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { GLYPHS, visibleHub } from "../lib/adminScreens.js";
import {
  ProductionTargetPanel, MixDesignAssignmentsPanel, MixDesignsPanel, FuelStationsAndEquipmentPanel,
  OrdersPanel, TicketsPanel,
} from "../lib/MasterDataPanels.jsx";

function Glyph({ name, size = 24 }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: GLYPHS[name] || "" }}
    />
  );
}

const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: "20px 8px", alignItems: "start" };
const TILE_BTN = { background: "none", border: "none", padding: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 7, cursor: "pointer", font: "inherit", color: "var(--charcoal)" };

export default function Modules() {
  const navigate = useNavigate();
  const { can, ready } = usePermissions();
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState("");
  const moduleKey = params.get("module");
  const view = params.get("view");

  if (!ready) return null;
  const hub = visibleHub(can);
  const active = moduleKey ? hub.find((m) => m.key === moduleKey) : null;
  const viewScreen = view && active ? active.screens.find((s) => s.view === view) : null;

  function openScreen(module, s) {
    if (s.to) navigate(s.to);
    else setParams({ module: module.key, view: s.view });
  }
  function openModule(m) {
    if (!m.screens.length) navigate(m.to);
    else setParams({ module: m.key });
  }

  return (
    <>
      <TopBar title="Modules" />
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}

        {(active || view) && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
            <button type="button" style={{ fontSize: 13, fontWeight: 600 }}
                    onClick={() => (viewScreen ? setParams({ module: active.key }) : setParams({}))}>
              &larr; Back
            </button>
            <div style={{ fontSize: 11.5, color: "var(--slate)" }}>
              Modules {active && <>&rsaquo; {active.label}</>} {viewScreen && <>&rsaquo; <b style={{ color: "var(--charcoal)" }}>{viewScreen.label}</b></>}
            </div>
          </div>
        )}

        {/* a panel opened in place */}
        {viewScreen && (
          <>
            {view === "production-target" && <ProductionTargetPanel setError={setError} />}
            {view === "orders" && <OrdersPanel setError={setError} />}
            {view === "tickets" && <TicketsPanel setError={setError} showChallan />}
            {view === "mix-assignments" && <MixDesignAssignmentsPanel setError={setError} />}
            {view === "mix-designs" && <MixDesignsPanel setError={setError} />}
            {view === "fuel" && <FuelStationsAndEquipmentPanel setError={setError} />}
          </>
        )}

        {/* a module's screens */}
        {!viewScreen && active && (
          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <span style={{ width: 44, height: 44, borderRadius: 12, background: active.colour, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", flex: "none" }}>
                <Glyph name={active.icon} size={22} />
              </span>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{active.label}</div>
            </div>
            <div style={GRID}>
              {active.screens.map((s) => (
                <button key={s.key} type="button" onClick={() => openScreen(active, s)} style={TILE_BTN}>
                  <span style={{ width: 58, height: 58, borderRadius: 15, background: active.tint, border: `1px solid ${active.colour}33`, display: "flex", alignItems: "center", justifyContent: "center", color: active.colour }}>
                    <Glyph name={s.icon} size={26} />
                  </span>
                  <span style={{ fontSize: 11.5, lineHeight: 1.25, textAlign: "center" }}>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* home */}
        {!active && !view && (
          hub.length === 0 ? (
            <div className="card" style={{ fontSize: 13.5 }}>
              No modules have been switched on for you. A Super Admin can give you access on the Access Control page.
            </div>
          ) : (
            <div className="card">
              <div style={GRID}>
                {hub.map((m) => (
                  <button key={m.key} type="button" onClick={() => openModule(m)} style={TILE_BTN}>
                    <span style={{ width: 68, height: 68, borderRadius: 18, background: m.colour, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
                      <Glyph name={m.icon} size={32} />
                    </span>
                    <span style={{ fontSize: 12.5, fontWeight: 600, textAlign: "center", lineHeight: 1.25 }}>{m.label}</span>
                    <span style={{ fontSize: 10, color: "var(--slate)", textAlign: "center" }}>
                      {m.screens.length ? `${m.screens.length} screen${m.screens.length === 1 ? "" : "s"}` : "opens straight away"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        )}
      </div>
    </>
  );
}
