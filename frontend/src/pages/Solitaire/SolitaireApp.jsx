// Solitaire data-entry screen — locked visual design (§4.1 of
// 02_FUNCTIONAL_SPEC.md): the real reference screenshot as a background
// image, real form fields absolutely positioned on top of it by percentage
// coordinates (04_field_coordinates.json), responsive via
// aspect-ratio:1366/721. Do not redesign without explicit sign-off.
//
// Translated from the approved 06_mockup_v7.html's own JS 1:1 for behavior
// (role gating, sheet-number formula, validation, popups), wired to the
// real backend (lib/solitaireApi.js) instead of the mock's in-memory arrays.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { solitaireApi } from "../../lib/solitaireApi.js";
import { generateSolitaireDocketPdf, computeSheetNumber } from "../../lib/solitaireDocketPdf.js";
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

const MASTERS_ROLES = ["operator", "qc", "admin"];
const MIX_DESIGN_ROLES = ["qc", "admin"];

export default function SolitaireApp() {
  const navigate = useNavigate();
  const [account, setAccount] = useState(null);
  const [loadError, setLoadError] = useState("");

  const [customers, setCustomers] = useState([]);
  const [trucks, setTrucks] = useState([]);
  // Round 152 — drivers are main-app user accounts now, not a column on the truck.
  const [drivers, setDrivers] = useState([]);
  // If the panel image cannot load, fall back to visible controls rather than
  // leaving the menus as invisible rectangles — the Round 149 failure mode.
  const [imgFailed, setImgFailed] = useState(false);
  const [mixDesigns, setMixDesigns] = useState([]);

  const [customerId, setCustomerId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [recipeCode, setRecipeCode] = useState("");
  const [truckReg, setTruckReg] = useState("");
  const [driverName, setDriverName] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [prodQty, setProdQty] = useState("");
  const [mixerCap, setMixerCap] = useState("1");
  const [moisture, setMoisture] = useState("");
  const [orderQty, setOrderQty] = useState("");
  const [withThisLoad, setWithThisLoad] = useState("");
  const [orderDateTime, setOrderDateTime] = useState("");

  const [validationMsg, setValidationMsg] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [openMenu, setOpenMenu] = useState(null); // 'master' | 'options' | null
  const [overlay, setOverlay] = useState(null); // 'order' | 'confirm' | 'search' | 'settings' | 'master:<kind>' | null
  const [masterKind, setMasterKind] = useState(null); // 'customer' | 'truck' | 'mix'
  const [banner, setBanner] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [settings, setSettings] = useState({ save_folder_path: "", default_printer: "" });
  const [printing, setPrinting] = useState(false);
  const [devices, setDevices] = useState([]);

  useEffect(() => {
    solitaireApi.me().then(setAccount).catch(() => navigate("/solitaire/login", { replace: true }));
    reloadMasters();
    solitaireApi.nextBatchNumber().then((r) => setBatchNumber(r.next_batch_number)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function reloadMasters() {
    solitaireApi.customers().then(setCustomers).catch((e) => setLoadError(e.message));
    solitaireApi.trucks().then(setTrucks).catch((e) => setLoadError(e.message));
    solitaireApi.drivers().then(setDrivers).catch(() => setDrivers([]));
    solitaireApi.mixDesigns().then(setMixDesigns).catch((e) => setLoadError(e.message));
  }

  const customer = customers.find((c) => c.id === Number(customerId));
  const sites = customer?.sites || [];
  const mixDesign = mixDesigns.find((m) => m.code === recipeCode);
  const truck = trucks.find((t) => t.registration_number === truckReg);
  const sheetNumber = useMemo(() => computeSheetNumber(prodQty, mixerCap), [prodQty, mixerCap]);

  function toast(msg) {
    setBanner(msg);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => setBanner(""), 6000);
  }

  async function doLogout() {
    await solitaireApi.logout().catch(() => {});
    navigate("/solitaire/login", { replace: true });
  }

  // Round 152 — picking a truck no longer decides the driver. The workbook
  // derives one from the other by lookup (one fixed driver per vehicle), but
  // the main app knows drivers change trip to trip, so the driver is chosen
  // separately and the docket records who actually drove.
  function onTruckChange(reg) {
    setTruckReg(reg);
  }

  const canEditMasters = MASTERS_ROLES.includes(account?.role);
  const canEditMixDesign = MIX_DESIGN_ROLES.includes(account?.role);
  const canSeeSettings = account?.role === "admin";

  function validateRequired() {
    const errs = {};
    if (!customerId) errs.customer = true;
    if (!siteId) errs.site = true;
    if (!recipeCode) errs.recipeCode = true;
    if (!truckReg) errs.truckReg = true;
    if (!prodQty) errs.prodQty = true;
    setFieldErrors(errs);
    const ok = Object.keys(errs).length === 0;
    setValidationMsg(ok ? "" : "⚠ Please complete all mandatory fields (Customer, Site, Recipe Code, Truck Registration Number, Production Qty) before printing.");
    return ok;
  }

  function startPrintFlow() {
    if (!validateRequired()) return;
    setOverlay("confirm");
  }

  async function confirmPrint() {
    setPrinting(true);
    try {
      const site = sites.find((s) => s.id === Number(siteId));
      const { filename, base64 } = await generateSolitaireDocketPdf({
        batchNumber, orderQty: Number(orderQty) || 0, withThisLoad: Number(withThisLoad) || 0,
        customer, site, mixDesign, truck, driverName,
        prodQty: Number(prodQty) || 0, mixerCap: Number(mixerCap) || 0,
      });
      const result = await solitaireApi.createDocket({
        batch_number: batchNumber,
        order_date_time: orderDateTime || null,
        order_qty_m3: Number(orderQty) || null,
        with_this_load_m3: Number(withThisLoad) || null,
        customer_id: Number(customerId), site_id: Number(siteId), mix_design_id: mixDesign?.id,
        truck_id: truck?.id, driver_name: driverName,
        production_qty_m3: Number(prodQty), mixer_capacity_m3: Number(mixerCap), moisture_pct: Number(moisture) || null,
        pdf_base64: base64, pdf_filename: filename,
      });
      setOverlay(null);
      toast(`✔ Order completed. Report printed and saved as PDF:<br><b>${result.save_folder_path || ""}${filename}</b><br><span style="font-size:10.5px;color:#7a5b00;">Temporary format — pending the real Excel-based print pipeline.</span>`);
      solitaireApi.nextBatchNumber().then((r) => setBatchNumber(r.next_batch_number)).catch(() => {});
    } catch (err) {
      toast(`✕ ${err.message}`);
    } finally {
      setPrinting(false);
    }
  }

  async function runSearch(q) {
    setSearchQuery(q);
    const rows = await solitaireApi.searchDockets(q).catch(() => []);
    setSearchResults(rows);
  }

  if (loadError) return <div className="solitaire-root sol-screen">Error loading Solitaire: {loadError}</div>;
  if (!account) return <div className="solitaire-root sol-screen">Loading…</div>;

  return (
    <div className="solitaire-root">
      <div className="sol-app-shell">
        <div className="sol-screen">
          {/* Round 152 (revised) — back to the real panel photograph, at the
              user's request, now that the image actually exists. The picture
              is `public/solitaire/screen-reference.png`, shipped in the repo,
              so the Round 149 failure — an overlay calibrated against an image
              nobody had — cannot repeat.

              What IS kept from that lesson: if the image fails to load for any
              reason, `imgFailed` swaps in a visible toolbar, so the module
              stays usable instead of becoming a white page with invisible
              menus. The hotspots also highlight on hover and carry tooltips,
              so the menu bar behaves like a menu bar rather than a secret. */}
          {imgFailed && (
            <div className="sol-toolbar">
              <span className="sol-tb-warn">Panel image missing — plain controls shown</span>
              <button type="button" className={`sol-tb-btn${openMenu === "master" ? " open" : ""}`}
                      onClick={() => setOpenMenu(openMenu === "master" ? null : "master")}>Master</button>
              <button type="button" className={`sol-tb-btn${openMenu === "options" ? " open" : ""}`}
                      onClick={() => setOpenMenu(openMenu === "options" ? null : "options")}>Options</button>
              <span className="sol-tb-gap" />
              <button type="button" className="sol-tb-btn" onClick={() => setOverlay("order")}>New Order</button>
              <button type="button" className="sol-tb-btn" onClick={() => { setOverlay("search"); runSearch(""); }}>Search / Reprint</button>
              <button type="button" className="sol-tb-btn primary" onClick={startPrintFlow}>Print Docket</button>
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
              <button className="sol-icon-btn" title="New Order" onClick={() => setOverlay("order")}>＋</button>
              <button className="sol-icon-btn" title="Search / Reprint" onClick={() => { setOverlay("search"); runSearch(""); }}>🔍</button>
              <button className="sol-icon-btn primary" title="Print Docket" onClick={startPrintFlow}>🖨</button>
            </div>

            {/* All eight menu words are clickable. Master and Options open the
                real menus; the other six are plant-control functions that live
                on the MCI370 itself and have no equivalent here, so they say so
                rather than doing nothing when clicked. */}
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
                <a className="disabled" title="Maintained in the main app">Customer &amp; Site &mdash; in the main app</a>
                <a className="disabled" title="Maintained in the main app">Truck &amp; Driver &mdash; in the main app</a>
                <a
                  className={!canEditMixDesign ? "disabled" : ""}
                  onClick={() => { if (canEditMixDesign) { setOpenMenu(null); setMasterKind("mix"); setOverlay("master"); } }}
                >
                  Mix Design Master <span className="badge">QC</span>
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

            <select className="sol-ov sol-ov-select" style={pct(COORDS.customer)} value={customerId}
              onChange={(e) => { setCustomerId(e.target.value); setSiteId(""); }}>
              <option value="">-- select --</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
            </select>

            <input className="sol-ov sol-ov-input" style={pct(COORDS.batchNumber)} value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} />
            <input className="sol-ov sol-ov-input ro" style={pct(COORDS.elapsedBatch)} value="0" readOnly />
            <input className="sol-ov sol-ov-input ro" style={pct(COORDS.totalBatch)} value={sheetNumber} readOnly />

            <select className={`sol-ov sol-ov-select${fieldErrors.recipeCode ? " error" : ""}`} style={pct(COORDS.recipeCode)} value={recipeCode}
              onChange={(e) => setRecipeCode(e.target.value)}>
              <option value="">-- select --</option>
              {mixDesigns.map((m) => <option key={m.id} value={m.code}>{m.code}</option>)}
            </select>
            <input className="sol-ov sol-ov-input" style={pct(COORDS.prodQty)} type="number" step="0.1" value={prodQty} onChange={(e) => setProdQty(e.target.value)} />
            <select className={`sol-ov sol-ov-select${fieldErrors.truckReg ? " error" : ""}`} style={pct(COORDS.truckReg)} value={truckReg}
              onChange={(e) => onTruckChange(e.target.value)}>
              <option value="">-- select --</option>
              {trucks.map((t) => <option key={t.id} value={t.registration_number}>{t.registration_number}</option>)}
            </select>

            <input className="sol-ov sol-ov-input ro left" style={pct(COORDS.recipeName)} value={mixDesign?.name || ""} readOnly />
            <input className="sol-ov sol-ov-input" style={pct(COORDS.mixerCap)} type="number" step="0.1" value={mixerCap} onChange={(e) => setMixerCap(e.target.value)} />
            {/* Round 152 — drivers are main-app accounts; the truck no longer
                decides who is driving. */}
            <select className="sol-ov sol-ov-select" style={pct(COORDS.driverName)} value={driverName} onChange={(e) => setDriverName(e.target.value)}>
              <option value="">-- select --</option>
              {drivers.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select>

            <select className={`sol-ov sol-ov-select${fieldErrors.site ? " error" : ""}`} style={pct(COORDS.site)} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">-- select --</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input className="sol-ov sol-ov-input" style={pct(COORDS.moisture)} type="number" step="0.1" value={moisture} onChange={(e) => setMoisture(e.target.value)} />
            <input className="sol-ov sol-ov-input ro left" style={pct(COORDS.truckId)} value={truck?.truck_code || ""} readOnly />
          </div>
          {validationMsg && <div className="sol-error-msg">{validationMsg}</div>}
        </div>
      </div>

      {/* ============ New Order popup ============ */}
      {overlay === "order" && (
        <div className="sol-overlay" onClick={() => setOverlay(null)}>
          <div className="sol-popup" onClick={(e) => e.stopPropagation()}>
            <div className="sol-popup-title"><span>New Order</span><span style={{ cursor: "pointer" }} onClick={() => setOverlay(null)}>✕</span></div>
            <div className="sol-popup-body">
              <div><label>Order Date &amp; Time</label><input type="datetime-local" value={orderDateTime} onChange={(e) => setOrderDateTime(e.target.value)} /></div>
              <div><label>Order Qty (M³)</label><input type="number" step="0.1" value={orderQty} onChange={(e) => setOrderQty(e.target.value)} placeholder="e.g. 20" /></div>
              <div><label>With This Load (M³)</label><input type="number" step="0.1" value={withThisLoad} onChange={(e) => setWithThisLoad(e.target.value)} placeholder="e.g. 20" /></div>
            </div>
            <div className="sol-popup-actions">
              <button onClick={() => setOverlay(null)}>Cancel</button>
              <button className="primary" onClick={() => { setOverlay(null); toast("Order details saved for this docket."); }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ============ Print confirmation — mirrors PrintOrderandAsPDF() §7 step 3 ============ */}
      {overlay === "confirm" && (
        <div className="sol-overlay">
          <div className="sol-popup">
            <div className="sol-popup-title"><span>Confirm Order</span><span style={{ cursor: "pointer" }} onClick={() => setOverlay(null)}>✕</span></div>
            <div className="sol-popup-body">
              <div style={{ fontSize: 12 }}>Do you want to proceed with this Order with the following details?</div>
              <div className="sol-confirm-lines">
                <div className="l"><span className="k">Report No.</span><span>: {batchNumber}</span></div>
                <div className="l"><span className="k">Customer</span><span>: {customer?.name || "—"}</span></div>
                <div className="l"><span className="k">Site</span><span>: {sites.find((s) => s.id === Number(siteId))?.name || "—"}</span></div>
                <div className="l"><span className="k">Mix</span><span>: {mixDesign?.code || "—"}</span></div>
                <div className="l"><span className="k">Quantity</span><span>: {prodQty} m³ &nbsp;&nbsp; With this Load: {withThisLoad || 0} m³</span></div>
                <div className="l"><span className="k">Date</span><span>: {new Date().toLocaleDateString()} &nbsp;&nbsp; Time: {new Date().toLocaleTimeString()}</span></div>
                <div className="l"><span className="k">Vehicle</span><span>: {truckReg || "—"} &nbsp;&nbsp; Driver: {driverName || "—"}</span></div>
                <div className="l" style={{ marginTop: 6, borderTop: "1px dashed #ccc", paddingTop: 6 }}>
                  <span className="k">Sheet to print</span><span>: Sheet {sheetNumber} (Qty {prodQty} ÷ Capacity {mixerCap})</span>
                </div>
              </div>

              {/* Round 155 — say plainly what this screen is and is not.
                  This module writes only its own docket record. It does NOT
                  create a delivery note in the main app, so nothing printed
                  here reaches Plant QC, no cubes are recorded against it, and
                  it never appears in the Lab Technician's testing queue. That
                  split was invisible until the lab reported missing batches
                  in September, and the plant confirmed the two systems should
                  stay separate — so the separation has to be visible at the
                  moment somebody prints, not buried in a document. */}
              <div style={{
                marginTop: 10, padding: "8px 10px", borderRadius: 6,
                background: "#FFF6E5", border: "1px solid #E0C48A",
                fontSize: 11.5, lineHeight: 1.5, color: "#6B4E00",
              }}>
                <b>This prints the batching docket only.</b> It does not raise a Delivery Note,
                and no QC or cube sample is recorded against it. If this load needs a Delivery
                Note or cube testing, it must also be raised in the main app by the Plant Operator.
              </div>
            </div>
            <div className="sol-popup-actions">
              <button onClick={() => setOverlay(null)} disabled={printing}>No</button>
              <button className="primary" onClick={confirmPrint} disabled={printing}>{printing ? "Printing…" : "Yes — Print & Save PDF"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ============ Search & Reprint ============ */}
      {overlay === "search" && (
        <div className="sol-overlay" onClick={() => setOverlay(null)}>
          <div className="sol-popup wide" onClick={(e) => e.stopPropagation()}>
            <div className="sol-popup-title"><span>Search &amp; Reprint</span><span style={{ cursor: "pointer" }} onClick={() => setOverlay(null)}>✕</span></div>
            <div className="sol-popup-body">
              <div style={{ display: "flex", gap: 8 }}>
                <input placeholder="Search by Docket No / Truck / Customer / Date" value={searchQuery} onChange={(e) => runSearch(e.target.value)} style={{ flex: 1 }} />
              </div>
              <table className="sol-search-table">
                <thead><tr><th>Docket No</th><th>Date</th><th>Customer</th><th>Site</th><th>Recipe</th><th>Truck</th><th>Qty (M³)</th><th>PDF</th></tr></thead>
                <tbody>
                  {searchResults.map((r) => (
                    <tr key={r.id}>
                      <td>{r.batch_number}</td>
                      <td>{new Date(r.printed_at).toLocaleDateString()}</td>
                      <td>{r.customer_name}</td>
                      <td>{r.site_name}</td>
                      <td>{r.recipe_code}</td>
                      <td>{r.truck_number}</td>
                      <td>{r.production_qty_m3}</td>
                      <td>
                        <a href={solitaireApi.docketPdfUrl(r.id)} target="_blank" rel="noreferrer">📄 View / Reprint</a>
                        {r.is_placeholder_pdf && <span className="sol-placeholder-badge">temp format</span>}
                      </td>
                    </tr>
                  ))}
                  {!searchResults.length && <tr><td colSpan={8} style={{ textAlign: "center", color: "#888" }}>No dockets found.</td></tr>}
                </tbody>
              </table>
              <div style={{ fontSize: 11, color: "#666" }}>PDF copies live in the admin-configured save folder and are indexed here.</div>
            </div>
            <div className="sol-popup-actions"><button onClick={() => setOverlay(null)}>Close</button></div>
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
                {/* Round 150 — authorizing a DIFFERENT machine. The button
                    above only ever registers the browser it is clicked in,
                    which is why a new terminal could never join: it cannot
                    sign in to reach this screen in the first place. A code
                    carried to that machine breaks the circle. */}
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
          customers={customers}
          trucks={trucks}
          mixDesigns={mixDesigns}
          onClose={() => setOverlay(null)}
          onChanged={() => { reloadMasters(); toast("✔ Master data updated."); }}
        />
      )}

      {banner && <div className="sol-save-banner" dangerouslySetInnerHTML={{ __html: banner }} />}
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
