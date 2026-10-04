// Solitaire data-entry screen — locked visual design (§4.1 of
// 02_FUNCTIONAL_SPEC.md): the real reference screenshot as a background
// image, real form fields absolutely positioned on top of it by percentage
// coordinates (04_field_coordinates.json), responsive via
// aspect-ratio:1366/721. Do not redesign without explicit sign-off.
//
// Translated from the approved 06_mockup_v7.html's own JS 1:1 for behavior
// (role gating, sheet-number formula, validation, popups), wired to the
// real backend (lib/solitaireApi.js) instead of the mock's in-memory arrays.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { solitaireApi } from "../../lib/solitaireApi.js";
// ROUND 161 — the plant-driven half of MixTrack. Kept in its own file: these
// are ordinary working screens, while this file is the MCI370 panel replica
// and mixing the two would make both harder to change.
import { RecipeMap, PrintQueue } from "./MixTrackLoads.jsx";
// ROUND 188 — saved dockets and the two data stores, Admin & QC only.
import { SavedDockets, PlantBatchData, PrintedTickets } from "./MixTrackAdmin.jsx";
import "./solitaire.css";

// Percentage coordinates lifted verbatim from 04_field_coordinates.json —
// detected programmatically from the reference screenshot, not eyeballed.
// Round 152 (revised) — every coordinate below was MEASURED from
// public/solitaire/screen-reference.png (1366x721) rather than estimated: the
// green dropdowns and white fields were detected in the image and converted to
// percentages, and they matched the original values to within ~1%, which
// confirmed the original overlay was calibrated against this exact screenshot.
// If the panel image is ever replaced, re-measure rather than nudging by eye.
//
// The menu bar is now fully mapped — all eight words, not just two.
const MENU_BAR = [
  { key: "master",  label: "Master",           left: 0.366,  width: 3.001 },
  { key: "plant",   label: "Plant setup",      left: 4.026,  width: 4.612 },
  { key: "start",   label: "Start Production", left: 9.370,  width: 6.589 },
  { key: "alarm",   label: "Alarm View",       left: 16.691, width: 4.612 },
  { key: "divert",  label: "Divert Concrete",  left: 22.108, width: 6.296 },
  { key: "options", label: "Options",          left: 29.136, width: 3.367 },
  { key: "help",    label: "Help",             left: 33.236, width: 2.123 },
  { key: "quit",    label: "Quit",             left: 36.091, width: 1.977 },
];
const MENU_TOP = 3.19, MENU_H = 2.63;

const COORDS = {
  customer: { left: 16.545, top: 60.472, width: 27.086, height: 3.606 },
  batchNumber: { left: 53.587, top: 61.165, width: 5.051, height: 2.635 },
  elapsedBatch: { left: 72.987, top: 61.165, width: 3.514, height: 2.635 },
  totalBatch: { left: 85.578, top: 61.165, width: 3.514, height: 2.635 },
  recipeCode: { left: 16.545, top: 65.187, width: 26.867, height: 3.190 },
  prodQty: { left: 54.319, top: 65.465, width: 4.392, height: 2.635 },
  truckReg: { left: 74.378, top: 65.603, width: 14.861, height: 3.606 },
  recipeName: { left: 16.618, top: 69.487, width: 26.867, height: 3.190 },
  mixerCap: { left: 54.319, top: 70.042, width: 4.392, height: 2.635 },
  driverName: { left: 67.570, top: 70.458, width: 21.669, height: 3.606 },
  site: { left: 16.545, top: 74.064, width: 27.013, height: 3.606 },
  moisture: { left: 54.319, top: 74.480, width: 4.319, height: 2.635 },
  truckId: { left: 67.716, top: 75.035, width: 20.059, height: 3.051 },
};
function pct(box) {
  return { left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` };
}

// Round 188 — two more measured boxes from the same 1366x721 screenshot: the
// bottom status-bar strip that carries Save & Print, and the empty band above
// it that carries the "saved and sent to the printer" message.
const STATUS_BAR = { left: 38.873, top: 93.897, width: 61.054, height: 5.964 };
const SAVED_STRIP = { left: 7.028, top: 83.633, width: 83.455, height: 2.774 };

const MIX_DESIGN_ROLES = ["qc", "admin"];
const DOCKET_ADMIN_ROLES = ["qc", "admin"];

function fmtNum(v, dp = 2) {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(dp) : String(v);
}

export default function SolitaireApp() {
  const navigate = useNavigate();
  const [account, setAccount] = useState(null);
  const [loadError, setLoadError] = useState("");
  // If the panel image cannot load, fall back to visible controls rather than
  // leaving the menus as invisible rectangles — the Round 149 failure mode.
  const [imgFailed, setImgFailed] = useState(false);
  const [mixDesigns, setMixDesigns] = useState([]);

  // ROUND 188 (v10.17) — the screen is driven by the plant's batch number.
  // Picking a number fills every green box with the plant's OWN text; the
  // operator types Production Qty and With This Load, then Save & Print.
  const [loads, setLoads] = useState([]);
  const [selKey, setSelKey] = useState("");
  const [prodQty, setProdQty] = useState("");
  const [withThisLoad, setWithThisLoad] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null); // { batch_number, sheet_number }
  const [stripMsg, setStripMsg] = useState("");

  const [openMenu, setOpenMenu] = useState(null); // 'master' | 'options' | null
  const [overlay, setOverlay] = useState(null); // 'dockets' | 'store1' | 'store2' | 'plant' | 'settings' | 'master' | null
  const [masterKind, setMasterKind] = useState(null);
  const [banner, setBanner] = useState("");
  const [settings, setSettings] = useState({ save_folder_path: "", default_printer: "" });
  const [devices, setDevices] = useState([]);
  const [plantTab, setPlantTab] = useState("map");

  useEffect(() => {
    solitaireApi.me().then(setAccount).catch(() => navigate("/solitaire/login", { replace: true }));
    reloadMasters();
    reloadLoads();
    // The plant agent sends batches as they finish; refresh the dropdown so a
    // truck that has just loaded appears without anybody reloading the page.
    const t = setInterval(reloadLoads, 30000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function reloadMasters() {
    solitaireApi.mixDesigns().then(setMixDesigns).catch((e) => setLoadError(e.message));
  }
  function reloadLoads() {
    return solitaireApi.openLoads().then(setLoads).catch((e) => setStripMsg(`✕ ${e.message}`));
  }

  const sel = loads.find((l) => l.key === selKey) || null;

  function toast(msg) {
    setBanner(msg);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => setBanner(""), 6000);
  }

  async function doLogout() {
    await solitaireApi.logout().catch(() => {});
    navigate("/solitaire/login", { replace: true });
  }

  const canEditMixDesign = MIX_DESIGN_ROLES.includes(account?.role);
  const canSeeSettings = account?.role === "admin";
  const isDocketAdmin = DOCKET_ADMIN_ROLES.includes(account?.role);

  function pick(key) {
    setSelKey(key);
    setProdQty("");
    setWithThisLoad("");
    setSaved(null);
    const l = loads.find((x) => x.key === key);
    setStripMsg(l?.blocker === "no-mapping"
      ? `✕ Recipe ${l.recipe_code} is not mapped to a mix design — QC must map it before this docket can print.`
      : l?.blocker === "design-inactive"
        ? `✕ Recipe ${l.recipe_code} is mapped to a deactivated mix design — QC must re-map it.`
        : "");
  }

  async function saveAndPrint() {
    if (!sel) { setStripMsg("✕ Pick the Batch / Docket Number first."); return; }
    const q = Number(prodQty);
    if (!prodQty || !Number.isFinite(q) || q <= 0) { setStripMsg("✕ Enter the Production Qty."); return; }
    if (withThisLoad !== "" && !(Number(withThisLoad) > 0)) { setStripMsg("✕ With This Load must be a number above zero."); return; }
    setSaving(true);
    setStripMsg("");
    try {
      const r = await solitaireApi.saveAndPrint({
        plant_no: sel.plant_no, batch_year: sel.batch_year, batch_no: sel.batch_no,
        production_qty_m3: q,
        with_this_load_m3: withThisLoad === "" ? null : Number(withThisLoad),
      });
      setSaved(r);
      setSelKey("");
      setProdQty("");
      setWithThisLoad("");
      reloadLoads();
    } catch (err) {
      setStripMsg(`✕ ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <div className="solitaire-root sol-screen">Error loading MixTrack: {loadError}</div>;
  if (!account) return <div className="solitaire-root sol-screen">Loading…</div>;

  const green = (box, value, align = "left") => (
    <div className={`sol-ov sol-ov-green${align === "right" ? " right" : ""}`} style={pct(box)}>{value ?? ""}</div>
  );

  const adminButtons = isDocketAdmin ? (
    <>
      <button className="sol-icon-btn" title="Saved dockets — edit, reprint, retry" onClick={() => setOverlay("dockets")}>📋</button>
      <button className="sol-icon-btn" title="Plant batch data (MCI370 copy)" onClick={() => setOverlay("store1")}>🗄</button>
      <button className="sol-icon-btn" title="Printed tickets (read back from the workbook)" onClick={() => setOverlay("store2")}>🧾</button>
      <button className="sol-icon-btn" title="Recipe map and print queue" onClick={() => setOverlay("plant")}>⚙</button>
    </>
  ) : null;

  return (
    <div className="solitaire-root">
      <div className="sol-app-shell">
        <div className="sol-screen">
          {imgFailed && (
            <div className="sol-toolbar">
              <span className="sol-tb-warn">Panel image missing — plain controls shown</span>
              <button type="button" className={`sol-tb-btn${openMenu === "master" ? " open" : ""}`}
                      onClick={() => setOpenMenu(openMenu === "master" ? null : "master")}>Master</button>
              <button type="button" className={`sol-tb-btn${openMenu === "options" ? " open" : ""}`}
                      onClick={() => setOpenMenu(openMenu === "options" ? null : "options")}>Options</button>
              <span className="sol-tb-gap" />
              {isDocketAdmin && <button type="button" className="sol-tb-btn" onClick={() => setOverlay("dockets")}>Saved dockets</button>}
              {isDocketAdmin && <button type="button" className="sol-tb-btn" onClick={() => setOverlay("store1")}>Plant batch data</button>}
              {isDocketAdmin && <button type="button" className="sol-tb-btn" onClick={() => setOverlay("store2")}>Printed tickets</button>}
              <button type="button" className="sol-tb-btn primary" onClick={saveAndPrint} disabled={saving}>Save &amp; Print</button>
            </div>
          )}

          <div className="sol-entry-bg">
            <img
              src="/solitaire/screen-reference.png"
              alt="Schwing Stetter MCI370 Control System"
              onError={() => setImgFailed(true)}
            />

            <div className="sol-topbar-ov">
              <span className="who">
                Signed in as <b>{account.displayName}</b> <span style={{ color: "#666" }}>({account.role})</span>{" "}
                <span className="sol-logout-link" onClick={doLogout}>Sign out</span>
              </span>
              {adminButtons}
            </div>

            {MENU_BAR.map((m) => (
              <button
                key={m.key}
                type="button"
                className={`sol-menu-hotspot${openMenu === m.key ? " active" : ""}`}
                style={{ left: `${m.left}%`, top: `${MENU_TOP}%`, width: `${m.width}%`, height: `${MENU_H}%` }}
                title={m.key === "master" || m.key === "options" ? m.label : `${m.label} — on the plant's own MCI370, not in this module`}
                onClick={() => {
                  if (m.key === "master" || m.key === "options") setOpenMenu(openMenu === m.key ? null : m.key);
                  else { setOpenMenu(null); toast(`${m.label} runs on the plant's own MCI370 — this screen only raises and prints dockets.`); }
                }}
              />
            ))}

            {openMenu === "master" && (
              <div className="sol-menu-dropdown" style={{ left: `${MENU_BAR[0].left}%`, top: "5.9%" }}>
                <a
                  className={!canEditMixDesign ? "disabled" : ""}
                  onClick={() => { if (canEditMixDesign) { setOpenMenu(null); setMasterKind("mix"); setOverlay("master"); } }}
                >
                  Mix Design Master <span className="badge">QC</span>
                </a>
                <a
                  className={!isDocketAdmin ? "disabled" : ""}
                  onClick={() => { if (isDocketAdmin) { setOpenMenu(null); setPlantTab("map"); setOverlay("plant"); } }}
                >
                  Recipe Map <span className="badge">QC</span>
                </a>
              </div>
            )}
            {openMenu === "options" && (
              <div className="sol-menu-dropdown" style={{ left: `${MENU_BAR[5].left}%`, top: "5.9%" }}>
                <a
                  className={!canSeeSettings ? "disabled" : ""}
                  onClick={() => {
                    if (canSeeSettings) {
                      setOpenMenu(null);
                      solitaireApi.getSettings().then(setSettings);
                      solitaireApi.devices().then(setDevices);
                      setOverlay("settings");
                    }
                  }}
                >
                  Settings — PDF Save Location <span className="badge">Admin</span>
                </a>
              </div>
            )}

            {/* ---- the plant's own text, read-only, in the green boxes ---- */}
            {green(COORDS.customer, sel?.customer)}
            {green(COORDS.recipeCode, sel?.recipe_code)}
            {green(COORDS.recipeName, sel?.recipe_name)}
            {green(COORDS.site, sel?.site)}
            {green(COORDS.mixerCap, sel ? fmtNum(sel.mixer_capacity_m3) : "", "right")}
            {green(COORDS.moisture, sel ? fmtNum(sel.moisture_pct, 1) : "", "right")}
            {green(COORDS.totalBatch, sel ? sel.batches : "")}
            {green(COORDS.truckReg, sel?.truck_no)}
            {green(COORDS.driverName, sel?.driver)}
            {green(COORDS.truckId, sel?.truck_no)}

            {/* ---- Batch / Docket Number: the number only ---- */}
            <select className="sol-ov sol-ov-req" style={pct(COORDS.batchNumber)} value={selKey}
                    aria-label="Batch / Docket Number" onChange={(e) => pick(e.target.value)}>
              <option value="">—</option>
              {loads.map((l) => <option key={l.key} value={l.key}>{l.batch_no}</option>)}
            </select>

            {/* ---- the two figures the operator types ---- */}
            <input className="sol-ov sol-ov-req" style={pct(COORDS.prodQty)} type="number" step="0.5" min="0"
                   aria-label="Production Qty M³" placeholder="0" value={prodQty}
                   onChange={(e) => { setProdQty(e.target.value); setStripMsg(""); }} disabled={!sel} />
            {/* With This Load lives in the "Elapsed Batch Counter" green box —
                the label printed on the screenshot is left exactly as it is. */}
            <input className="sol-ov sol-ov-req" style={pct(COORDS.elapsedBatch)} type="number" step="0.5" min="0"
                   aria-label="With This Load M³" placeholder={sel?.with_this_load_m3 != null ? fmtNum(sel.with_this_load_m3, 0) : "0"}
                   value={withThisLoad} onChange={(e) => { setWithThisLoad(e.target.value); setStripMsg(""); }} disabled={!sel} />

            {saved && (
              <div className="sol-saved-strip" style={pct(SAVED_STRIP)}>
                Docket {saved.batch_number} saved and sent to the plant printer — Report No.{saved.batch_number} (sheet {saved.sheet_number}) will print in a few seconds.
              </div>
            )}

            <div className="sol-statusbar" style={pct(STATUS_BAR)}>
              <span className={`sol-statusbar-msg${stripMsg.startsWith("✕") ? " err" : ""}`}>
                {stripMsg || (sel
                  ? <>Enter <b>Production Qty</b> and <b>With This Load</b> (Elapsed Batch Counter box)
                      {sel.with_this_load_m3 != null ? <> · plant reported With This Load {fmtNum(sel.with_this_load_m3)}</> : null}</>
                  : <>Pick the <b>Batch / Docket Number</b> — {loads.length} plant batch{loads.length === 1 ? "" : "es"} without a docket</>)}
              </span>
              <button type="button" className="sol-statusbar-btn" onClick={saveAndPrint}
                      disabled={saving || !sel || !!sel?.blocker}>
                {saving ? "Saving…" : "Save & Print"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ============ Saved dockets / the two stores (Admin & QC) ============ */}
      {overlay === "dockets" && isDocketAdmin && (
        <AdminOverlay title="Saved dockets" onClose={() => setOverlay(null)}>
          <SavedDockets toast={toast} />
        </AdminOverlay>
      )}
      {overlay === "store1" && isDocketAdmin && (
        <AdminOverlay title="Plant batch data" onClose={() => setOverlay(null)}>
          <PlantBatchData />
        </AdminOverlay>
      )}
      {overlay === "store2" && isDocketAdmin && (
        <AdminOverlay title="Printed tickets" onClose={() => setOverlay(null)}>
          <PrintedTickets />
        </AdminOverlay>
      )}

      {overlay === "plant" && isDocketAdmin && (
        <div className="sol-overlay" onClick={() => setOverlay(null)}>
          <div className="sol-popup wide" style={{ width: "min(1100px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className="sol-popup-title">
              <span>Recipe map &amp; print queue</span>
              <span style={{ cursor: "pointer" }} onClick={() => setOverlay(null)}>✕</span>
            </div>
            <div className="sol-popup-body">
              <div style={{ display: "flex", gap: 6 }}>
                {[["map", "Recipe map"], ["queue", "Print queue"]].map(([k, label]) => (
                  <button key={k} type="button" className={`sol-tb-btn${plantTab === k ? " open" : ""}`}
                          onClick={() => setPlantTab(k)}>{label}</button>
                ))}
              </div>
              {plantTab === "map" && <RecipeMap account={account} toast={toast} />}
              {plantTab === "queue" && <PrintQueue toast={toast} />}
            </div>
          </div>
        </div>
      )}

      {/* ============ Admin Settings ============ */}
      {overlay === "settings" && canSeeSettings && (
        <div className="sol-overlay" onClick={() => setOverlay(null)}>
          <div className="sol-popup" onClick={(e) => e.stopPropagation()}>
            <div className="sol-popup-title"><span>Settings</span><span style={{ cursor: "pointer" }} onClick={() => setOverlay(null)}>✕</span></div>
            <div className="sol-popup-body">
              <div style={{ fontSize: 11, color: "#666" }}>Admin-only. This path is never shown on the data entry screen.</div>
              <div><label>PDF Save Folder Path</label><input value={settings.save_folder_path || ""} onChange={(e) => setSettings({ ...settings, save_folder_path: e.target.value })} /></div>
              <div><label>Default Printer</label><input value={settings.default_printer || ""} onChange={(e) => setSettings({ ...settings, default_printer: e.target.value })} /></div>
              <div><label>Max authorized devices</label><input value={settings.max_devices || ""} onChange={(e) => setSettings({ ...settings, max_devices: e.target.value })} /></div>

              <div style={{ borderTop: "1px dashed #ccc", paddingTop: 10, marginTop: 4 }}>
                <label>Device Management — §2.2 company-wide allowlist</label>
                <div style={{ fontSize: 10.5, color: "#888", marginBottom: 6 }}>
                  Software/cookie-based, not a hardware lock — a technical user could copy the cookie elsewhere.
                  This is a reasonable trade-off for an internal plant tool, not an unspoofable guarantee.
                </div>
                <table className="sol-mtable">
                  <thead><tr><th>Label</th><th>Registered</th><th>Last used</th><th></th></tr></thead>
                  <tbody>
                    {devices.filter((d) => !d.revoked_at).map((d) => (
                      <tr key={d.id}>
                        <td>{d.label}</td>
                        <td>{new Date(d.registered_at).toLocaleDateString()}</td>
                        <td>{d.last_used_at ? new Date(d.last_used_at).toLocaleString() : "—"}</td>
                        <td className="rm" onClick={() => solitaireApi.revokeDevice(d.id).then(() => solitaireApi.devices().then(setDevices))}>Revoke</td>
                      </tr>
                    ))}
                    {!devices.filter((d) => !d.revoked_at).length && <tr><td colSpan={4} style={{ textAlign: "center", color: "#888" }}>No authorized devices.</td></tr>}
                  </tbody>
                </table>
                <button
                  className="sol-mtable-add"
                  onClick={async () => {
                    const label = window.prompt("Label for this browser/device (e.g. \"Plant office PC\"):", "");
                    if (label === null) return;
                    try {
                      await solitaireApi.registerDevice(label);
                      solitaireApi.devices().then(setDevices);
                      toast("✔ This browser is now authorized.");
                    } catch (err) { toast(`✕ ${err.message}`); }
                  }}
                >
                  ＋ Authorize this browser
                </button>
                {/* Round 150 — authorizing a DIFFERENT machine: a code carried
                    to that machine breaks the sign-in circle. */}
                <button
                  className="sol-mtable-add"
                  onClick={async () => {
                    const label = window.prompt("Which machine is this code for? (e.g. \"Lab PC\"):", "");
                    if (label === null) return;
                    try {
                      const r = await solitaireApi.createPairingCode(label);
                      window.alert(
                        "Device code:  " + r.code + "\n\n" +
                        "Type this on the new machine's MixTrack login screen, along with a username and password.\n\n" +
                        "It works once and expires in " + r.expires_in_minutes + " minutes. Generating a code cancels any earlier unused one."
                      );
                      solitaireApi.devices().then(setDevices);
                    } catch (err) { toast(`✕ ${err.message}`); }
                  }}
                >
                  ＋ Get a code for another machine
                </button>
              </div>
            </div>
            <div className="sol-popup-actions">
              <button onClick={() => setOverlay(null)}>Cancel</button>
              <button className="primary" onClick={async () => { await solitaireApi.saveSettings(settings); setOverlay(null); toast("✔ Settings saved."); }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ============ Master editors ============ */}
      {overlay === "master" && (
        <MasterEditor
          kind={masterKind}
          customers={[]}
          trucks={[]}
          mixDesigns={mixDesigns}
          onClose={() => setOverlay(null)}
          onChanged={() => { reloadMasters(); toast("✔ Master data updated."); }}
        />
      )}

      {banner && <div className="sol-save-banner" dangerouslySetInnerHTML={{ __html: banner }} />}
    </div>
  );
}

function AdminOverlay({ title, onClose, children }) {
  return (
    <div className="sol-overlay" onClick={onClose}>
      <div className="sol-popup wide sol-admin-popup" onClick={(e) => e.stopPropagation()}>
        <div className="sol-popup-title">
          <span>{title} <span className="sol-admin-badge">Admin &amp; QC only</span></span>
          <span style={{ cursor: "pointer" }} onClick={onClose}>✕</span>
        </div>
        <div className="sol-popup-body">{children}</div>
      </div>
    </div>
  );
}

function MasterEditor({ kind, customers, trucks, mixDesigns, onClose, onChanged }) {
  const [newSiteFor, setNewSiteFor] = useState(null);
  const [newSiteName, setNewSiteName] = useState("");

  const titles = { customer: "Customer & Site Master", truck: "Truck & Driver Master", mix: "Mix Design Master" };

  async function addRow() {
    if (kind === "customer") await solitaireApi.createCustomer({ code: "C-NEW", name: "NEW CUSTOMER" });
    if (kind === "truck") await solitaireApi.createTruck({ registration_number: "NEW REG", truck_code: "TRK-NEW", driver_name: "NEW DRIVER" });
    if (kind === "mix") await solitaireApi.createMixDesign({ code: "NEW" });
    onChanged();
  }

  return (
    <div className="sol-overlay" onClick={onClose}>
      <div className="sol-popup wide" onClick={(e) => e.stopPropagation()}>
        <div className="sol-popup-title"><span>{titles[kind]}</span><span style={{ cursor: "pointer" }} onClick={onClose}>✕</span></div>
        <div className="sol-popup-body">
          {kind === "customer" && (
            <table className="sol-mtable">
              <thead><tr><th>Code</th><th>Name</th><th>Sites</th><th></th></tr></thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td><input defaultValue={c.code} onBlur={(e) => solitaireApi.updateCustomer(c.id, { code: e.target.value }).then(onChanged)} /></td>
                    <td><input defaultValue={c.name} onBlur={(e) => solitaireApi.updateCustomer(c.id, { name: e.target.value }).then(onChanged)} /></td>
                    <td>
                      {c.sites.map((s) => (
                        <div key={s.id} style={{ display: "flex", gap: 4, marginBottom: 2 }}>
                          <input defaultValue={s.name} onBlur={(e) => solitaireApi.updateSite(s.id, { name: e.target.value }).then(onChanged)} />
                          <span className="rm" onClick={() => solitaireApi.deleteSite(s.id).then(onChanged)}>✕</span>
                        </div>
                      ))}
                      {newSiteFor === c.id ? (
                        <div style={{ display: "flex", gap: 4 }}>
                          <input autoFocus value={newSiteName} onChange={(e) => setNewSiteName(e.target.value)} placeholder="Site name" />
                          <button onClick={() => { solitaireApi.createSite(c.id, newSiteName).then(() => { setNewSiteFor(null); setNewSiteName(""); onChanged(); }); }}>Add</button>
                        </div>
                      ) : (
                        <button className="sol-mtable-add" onClick={() => setNewSiteFor(c.id)}>＋ Add site</button>
                      )}
                    </td>
                    <td className="rm" onClick={() => solitaireApi.deleteCustomer(c.id).then(onChanged)}>✕</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {kind === "truck" && (
            <table className="sol-mtable">
              <thead><tr><th>Registration No.</th><th>Truck ID</th><th>Driver</th><th></th></tr></thead>
              <tbody>
                {trucks.map((t) => (
                  <tr key={t.id}>
                    <td><input defaultValue={t.registration_number} onBlur={(e) => solitaireApi.updateTruck(t.id, { registration_number: e.target.value }).then(onChanged)} /></td>
                    <td><input defaultValue={t.truck_code} onBlur={(e) => solitaireApi.updateTruck(t.id, { truck_code: e.target.value }).then(onChanged)} /></td>
                    <td><input defaultValue={t.driver_name} onBlur={(e) => solitaireApi.updateTruck(t.id, { driver_name: e.target.value }).then(onChanged)} /></td>
                    <td className="rm" onClick={() => solitaireApi.deleteTruck(t.id).then(onChanged)}>✕</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {kind === "mix" && (
            <table className="sol-mtable">
              <thead><tr><th>Code</th><th>M Sand</th><th>12mm</th><th>20mm</th><th>Cem1</th><th>Cem2</th><th>Cem3</th><th>Admix1</th><th>Admix2</th><th>Water</th><th></th></tr></thead>
              <tbody>
                {mixDesigns.map((m) => (
                  <tr key={m.id}>
                    <td><input defaultValue={m.code} onBlur={(e) => solitaireApi.updateMixDesign(m.id, { code: e.target.value, name: e.target.value }).then(onChanged)} /></td>
                    {["msand_kgm3", "agg_12mm_kgm3", "agg_20mm_kgm3", "cem1_kgm3", "cem2_kgm3", "cem3_kgm3", "admix1_kgm3", "admix2_kgm3", "water_kgm3"].map((f) => (
                      <td key={f}><input defaultValue={m[f]} onBlur={(e) => solitaireApi.updateMixDesign(m.id, { [f]: Number(e.target.value) || 0 }).then(onChanged)} /></td>
                    ))}
                    <td className="rm" onClick={() => solitaireApi.deleteMixDesign(m.id).then(onChanged)}>✕</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button className="sol-mtable-add" onClick={addRow}>＋ Add row</button>
          {/* Round 152 — bulk upload, read from the workbook's own Mix Design
              sheet. Parsed HERE in the browser (SheetJS is already bundled),
              so a 400KB .xlsm never crosses the wire and the server needs no
              spreadsheet library. Mapped by COLUMN LETTER, not by header text:
              the sheet's R3 header reads "20MM%" but the column is actually
              the first M Sand's moisture — confirmed against the Load sheet's
              own VLOOKUP column indexes — so trusting the headers would have
              silently loaded moisture into the wrong ingredient. */}
          {kind === "mix" && (
            <label className="sol-mtable-add" style={{ marginLeft: 6, display: "inline-block", cursor: "pointer" }}>
              ⬆ Bulk upload from workbook
              <input
                type="file" accept=".xlsx,.xlsm,.xls" style={{ display: "none" }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  try {
                    const XLSX = await import("xlsx");
                    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
                    const ws = wb.Sheets["Mix Design"];
                    if (!ws) { window.alert('That workbook has no sheet called "Mix Design".'); return; }
                    const COLS = {
                      code: "B", name: "X",
                      msand_kgm3: "C", msand2_kgm3: "D", agg_12mm_kgm3: "E", agg_20mm_kgm3: "F",
                      cem1_kgm3: "H", cem2_kgm3: "I", cem3_kgm3: "J",
                      admix1_kgm3: "K", admix2_kgm3: "L", water_kgm3: "M",
                      absorb_msand_pct: "N", absorb_msand2_pct: "O", absorb_12mm_pct: "P", absorb_20mm_pct: "Q",
                      moisture_msand_pct: "R", moisture_msand2_pct: "S", moisture_12mm_pct: "T", moisture_20mm_pct: "U",
                      water_var_min_pct: "V", water_var_max_pct: "W",
                    };
                    const range = XLSX.utils.decode_range(ws["!ref"]);
                    const rows = [];
                    for (let r = 4; r <= range.e.r + 1; r++) {
                      const rec = {};
                      for (const [k, col] of Object.entries(COLS)) rec[k] = ws[`${col}${r}`]?.v ?? null;
                      if (rec.code !== null && String(rec.code).trim() !== "") rows.push(rec);
                    }
                    if (!rows.length) { window.alert("No recipes found on that sheet."); return; }
                    if (!window.confirm(
                      `Found ${rows.length} recipe(s) on the Mix Design sheet.\n\n` +
                      `First: ${String(rows[0].code)}\nLast:  ${String(rows[rows.length - 1].code)}\n\n` +
                      `Recipes already here with the same code are updated. Nothing is deleted.`
                    )) return;
                    const out = await solitaireApi.bulkMixDesigns(rows);
                    window.alert(
                      `${out.created} added, ${out.updated} updated.` +
                      (out.duplicates_in_file ? `\n${out.duplicates_in_file} duplicate code(s) in the file — the last one won.` : "") +
                      (out.skipped?.length ? `\n${out.skipped.length} row(s) skipped.` : "")
                    );
                    onChanged();
                  } catch (err) { window.alert(`Couldn't read that workbook: ${err.message}`); }
                }}
              />
            </label>
          )}
        </div>
        <div className="sol-popup-actions"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
