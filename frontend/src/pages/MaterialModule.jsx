// Round 139 — Material Module: Store's raw-material purchase -> receive ->
// consume -> physical-count workflow, plus Administrator masters/valuation
// and reports. See backend/src/routes/materialModule.js's header comment
// for the full "why a separate rm_* system" rationale (it deliberately does
// not touch the pre-existing raw_material_stock / RawMaterialStockEntry.jsx
// 9-bin Lab Technician feature).
//
// Built as ONE file (tab-based) rather than the ~8 separate pages the
// original planning notes sketched — the frontend folder was already over
// this project's own file-count guidance before this round, so every tab
// here is a section of this single component instead of its own file. See
// claude/raw-material-module-notes.md for the requirements this implements.
//
// Role scope (matches the backend's role arrays exactly):
//   Administrator — Materials, Suppliers, Orders (approve), Receipts,
//                   Consumption, Stock (with valuation), Physical Stock,
//                   Reports.
//   Store         — Orders (create), Receipts (receive), Stock (qty only,
//                   no valuation), Physical Stock (enter counts).
//   Plant Operator— Consumption + Production entry, Stock (qty only).
// No Manager access yet (an easy later addition — see the notes doc's own
// "open items" list) — flagged to the user at delivery time.
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.jsx";
import { isAdminLevel } from "../lib/roles.js";
import { monthStartStr, todayStr } from "../lib/istDate.js";

// ===================== Shared helpers =====================

function fmtDateTime(ts) {
  if (!ts) return "–";
  return new Date(ts).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function fmtDate(d) {
  if (!d) return "–";
  return new Date(d).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}
function fmtNum(n, decimals = 2) {
  if (n === null || n === undefined || n === "") return "–";
  return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}
function fmtMoney(n) {
  if (n === null || n === undefined || n === "") return "–";
  // Sign before the symbol ("-₹36,580", not "₹-36,580") — a cost of
  // difference is negative often enough here that the sign has to read
  // as part of the amount.
  const v = Number(n);
  return `${v < 0 ? "-" : ""}₹${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
// Round 142 — the mockup's stock/count tables read in MT for bulk materials
// and kg for the small ones (2,224 kg of admixture next to 62.0 MT of
// cement). Everything is still STORED and computed in kg; this is purely how
// a figure is printed, and the unit is always printed with it so a number can
// never be read as the wrong one.
const MT_THRESHOLD_KG = 10000;
function fmtMass(kg) {
  if (kg === null || kg === undefined || kg === "") return "–";
  const n = Number(kg);
  if (Math.abs(n) >= MT_THRESHOLD_KG) return `${fmtNum(n / 1000, 1)} MT`;
  return `${fmtNum(n, 0)} kg`;
}
// Responsive stand-in for the mockup's fixed 4/5-column KPI strip — the real
// app is used on phones in the plant as much as on a desk.
const kpiGridStyle = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 14 };

// Deliberately NOT toISOString().slice(...) — that converts to UTC first, so
// in IST (+5:30) every date before 05:30, and the 1st of any month, comes back
// as the PREVIOUS day/month. These build the string from the local calendar
// fields instead, which is what "today" and "this month" mean to a plant.
function thisMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
// Month arithmetic on the YYYY-MM string itself, for the same reason.
function addMonths(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}
function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString([], { month: "long", year: "numeric" });
}

// Round 142 — which mix-design ingredient a material is, so the "mix vs
// actual" report can compare it against the design. Values must match
// backend materialModule.js's MIX_COMPONENT_COLUMN exactly; "" means the
// design sheet has no figure for it (water, curing compound) and the report
// simply leaves that material out of the comparison.
const MIX_COMPONENT_OPTIONS = [
  { value: "", label: "Not a mix-design ingredient" },
  { value: "cement", label: "Cement" },
  { value: "fly_ash", label: "Fly ash" },
  { value: "fine_agg", label: "Fine aggregate (sand)" },
  { value: "coarse_20mm", label: "Coarse aggregate 20 mm" },
  { value: "coarse_12_5mm", label: "Coarse aggregate 12.5 mm" },
  { value: "admixture", label: "Admixture" },
];
const MIX_COMPONENT_LABEL = Object.fromEntries(MIX_COMPONENT_OPTIONS.map((o) => [o.value, o.label]));

const SCOPE_LABEL = { delivered: "Delivered", ex_factory: "Ex-factory" };
const FREIGHT_BASIS_LABEL = { per_purchase_unit: "Per purchase unit", per_trip: "Per trip", per_kg: "Per kg" };
const ORDER_STATUS_LABEL = { pending_approval: "Pending approval", approved: "Approved", rejected: "Rejected", closed: "Closed" };
const ORDER_STATUS_COLOR = { pending_approval: "var(--amber)", approved: "var(--signal-green)", rejected: "var(--alert-red)", closed: "var(--slate)" };

// Closing only counts a backdrop click that also STARTED on the backdrop —
// item 3's fix. Without this, selecting/copying text inside the modal (e.g.
// dragging from an input out past the panel edge before releasing) made the
// click event's target resolve to the backdrop, closing the modal mid-select.
// Tracking mousedown separately means a drag that started inside the panel
// never counts as a backdrop click, no matter where the mouse is released.
function Modal({ title, onClose, children, wide }) {
  const mouseDownOnBackdrop = useRef(false);
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 }}
      onMouseDown={(e) => { mouseDownOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (mouseDownOnBackdrop.current && e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: "#fff", borderRadius: "14px 14px 0 0", padding: 18, width: "100%", maxWidth: wide ? 620 : 460, maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
          <button type="button" onClick={onClose} style={{ border: "none", background: "none", fontSize: 18, lineHeight: 1, padding: 0, color: "var(--slate)" }}>&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ fontSize: 11.5, color: "var(--slate)", display: "block", marginBottom: 3 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle = { width: "100%" };

// Tabs each role sees. Materials/Suppliers are master-editing tools kept
// Administrator-only (Store/Plant Operator still read materials & suppliers
// live inside their own tabs — e.g. the Orders form's dropdowns — via the
// same GET endpoints, without needing this browsing/editing tab).
// Round 140, item 5: Stock is the landing tab everywhere it's shown — matches
// the mockup's own nav order (Stock, Receive/Orders/Receipts, Monthly stock,
// Reports, Cost dashboard | Materials, Suppliers masters last, after a visual
// divider) instead of opening on the Materials master.
const TABS_BY_ROLE = {
  administrator: [
    { key: "stock", label: "Stock" },
    { key: "orders", label: "Orders" },
    { key: "receipts", label: "Receipts" },
    { key: "consumption", label: "Consumption" },
    { key: "physical-stock", label: "Physical Stock" },
    { key: "reports", label: "Reports" },
    { key: "cost-dashboard", label: "Cost Dashboard" },
    { key: "materials", label: "Materials" },
    { key: "suppliers", label: "Suppliers" },
  ],
  store: [
    { key: "stock", label: "Stock" },
    { key: "orders", label: "Orders" },
    { key: "receipts", label: "Receipts" },
    { key: "physical-stock", label: "Physical Stock" },
  ],
  plant_operator: [
    { key: "stock", label: "Stock" },
    { key: "consumption", label: "Consumption" },
  ],
};

export default function MaterialModule() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabs = TABS_BY_ROLE[user?.role] || [];
  const requestedTab = searchParams.get("tab");
  const initialTab = tabs.some((t) => t.key === requestedTab) ? requestedTab : (tabs[0]?.key || "");
  const [tab, setTab] = useState(initialTab);

  function changeTab(key) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  return (
    <>
      <TopBar title="Material Module" />
      {/* Round 142 — wider than the app's usual 620px column. Every other
          page here is a phone-first form; this module's Stock, Monthly
          physical stock and report screens are wide tables the mockup lays
          out across a desk-width screen, and at 620px the value and status
          columns fell off the right edge. max-width only caps, so phones are
          unchanged. */}
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`btn-tab${tab === t.key ? " active" : ""}`}
              onClick={() => changeTab(t.key)}
              style={{ fontSize: 12, padding: "6px 12px", borderRadius: 999 }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "materials" && <MaterialsTab />}
        {tab === "suppliers" && <SuppliersTab />}
        {tab === "orders" && <OrdersTab role={user.role} />}
        {tab === "receipts" && <ReceiptsTab role={user.role} />}
        {tab === "consumption" && <ConsumptionTab />}
        {tab === "stock" && <StockTab role={user.role} onGoTab={changeTab} />}
        {tab === "physical-stock" && <PhysicalStockTab role={user.role} />}
        {tab === "reports" && <ReportsTab />}
        {tab === "cost-dashboard" && <CostDashboardTab />}
      </div>
    </>
  );
}

// ===================== Materials tab (Administrator) =====================

function MaterialsTab() {
  const [materials, setMaterials] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(null); // null = closed, {} = new, {...} = editing existing
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({});

  // Round 140, item 4 — purchase units per material.
  const [expandedUnits, setExpandedUnits] = useState(null); // material id whose units are shown
  const [units, setUnits] = useState([]);
  const [addingUnit, setAddingUnit] = useState(false);
  const [unitForm, setUnitForm] = useState({ unit_name: "", kg_per_unit: "", is_default: false });

  async function load() {
    try {
      setMaterials(await apiRequest("/material-module/materials"));
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function loadUnits(materialId) {
    try { setUnits(await apiRequest(`/material-module/materials/${materialId}/units`)); }
    catch (err) { setError(err.message); }
  }
  function toggleUnits(m) {
    if (expandedUnits === m.id) { setExpandedUnits(null); return; }
    setExpandedUnits(m.id);
    setAddingUnit(false);
    loadUnits(m.id);
  }
  async function submitUnit(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest(`/material-module/materials/${expandedUnits}/units`, { method: "POST", body: unitForm });
      setNotice("Purchase unit added.");
      setAddingUnit(false);
      setUnitForm({ unit_name: "", kg_per_unit: "", is_default: false });
      await loadUnits(expandedUnits);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  async function makeUnitDefault(u) {
    setError(""); setNotice("");
    try {
      await apiRequest(`/material-module/materials/${expandedUnits}/units/${u.id}`, { method: "PATCH", body: { is_default: true } });
      await loadUnits(expandedUnits);
      await load();
    } catch (err) { setError(err.message); }
  }
  async function deleteUnit(u) {
    setError(""); setNotice("");
    try {
      await apiRequest(`/material-module/materials/${expandedUnits}/units/${u.id}`, { method: "DELETE" });
      await loadUnits(expandedUnits);
    } catch (err) { setError(err.message); }
  }

  function openNew() {
    setForm({ name: "", category: "", sub_category: "", mix_component: "", purchase_unit: "", kg_per_purchase_unit: "", tolerance_pct: "", reorder_level_kg: "", opening_stock_kg: "0", opening_stock_rate_per_kg: "" });
    setEditing({});
    setError(""); setNotice("");
  }
  function openEdit(m) {
    setForm({
      name: m.name, category: m.category || "", sub_category: m.sub_category || "",
      mix_component: m.mix_component || "",
      purchase_unit: m.purchase_unit, kg_per_purchase_unit: m.kg_per_purchase_unit,
      tolerance_pct: m.tolerance_pct ?? "", reorder_level_kg: m.reorder_level_kg ?? "",
      opening_stock_kg: m.opening_stock_kg ?? "0", opening_stock_rate_per_kg: m.opening_stock_rate_per_kg ?? "",
    });
    setEditing(m);
    setError(""); setNotice("");
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      if (editing.id) {
        await apiRequest(`/material-module/materials/${editing.id}`, { method: "PATCH", body: form });
        setNotice("Material updated.");
      } else {
        await apiRequest("/material-module/materials", { method: "POST", body: form });
        setNotice("Material added.");
      }
      setEditing(null);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function toggleActive(m) {
    setError(""); setNotice("");
    try {
      await apiRequest(`/material-module/materials/${m.id}`, { method: "PATCH", body: { is_active: !m.is_active } });
      await load();
    } catch (err) { setError(err.message); }
  }

  const grouped = materials.reduce((acc, m) => {
    const key = m.category || "Uncategorized";
    (acc[key] = acc[key] || []).push(m);
    return acc;
  }, {});

  return (
    <div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 10 }}>{notice}</div>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Materials master</div>
        <button type="button" onClick={openNew} style={{ fontSize: 12, padding: "6px 12px" }}>+ New material</button>
      </div>

      {Object.entries(grouped).map(([cat, rows]) => (
        <div key={cat} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 6 }}>{cat}</div>
          {rows.map((m) => (
            <div key={m.id} className="card" style={{ marginBottom: 8, opacity: m.is_active ? 1 : 0.55 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.name}{!m.is_active && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>Inactive</span>}</div>
                  <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 3 }}>
                    {m.sub_category ? `${m.sub_category} · ` : ""}{m.purchase_unit} = {fmtNum(m.kg_per_purchase_unit, 4)} kg
                    {m.mix_component ? ` · ${MIX_COMPONENT_LABEL[m.mix_component] || m.mix_component}` : ""}
                    {m.reorder_level_kg != null ? ` · Reorder ≤ ${fmtNum(m.reorder_level_kg)} kg` : ""}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>
                    Opening stock: {fmtNum(m.opening_stock_kg)} kg{m.opening_stock_rate_per_kg != null ? ` @ ${fmtMoney(m.opening_stock_rate_per_kg)}/kg` : ""}
                    {m.tolerance_pct != null ? ` · Tolerance ${fmtNum(m.tolerance_pct, 1)}%` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <button type="button" style={{ fontSize: 11, padding: "4px 9px" }} onClick={() => openEdit(m)}>Edit</button>
                  <button type="button" style={{ fontSize: 11, padding: "4px 9px" }} onClick={() => toggleActive(m)}>{m.is_active ? "Deactivate" : "Reactivate"}</button>
                </div>
              </div>
              <button type="button" onClick={() => toggleUnits(m)} style={{ fontSize: 10.5, padding: "3px 0", marginTop: 8, background: "none", border: "none", color: "var(--rebar)", textAlign: "left" }}>
                {expandedUnits === m.id ? "Hide purchase units ↑" : "Purchase units →"}
              </button>
              {expandedUnits === m.id && (
                <div style={{ marginTop: 10, borderTop: "1px solid var(--border, #DEDAD1)", paddingTop: 10 }}>
                  <div style={{ fontSize: 10.5, color: "var(--slate)", marginBottom: 6 }}>
                    Several named units can be on file for one material (e.g. CFT, Brass, MT) — mark one Default, which is the unit orders/receipts use.
                  </div>
                  {units.map((u) => (
                    <div key={u.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, padding: "4px 0" }}>
                      <span>{u.unit_name} = {fmtNum(u.kg_per_unit, 4)} kg{u.is_default && <span className="badge badge-info" style={{ marginLeft: 6, fontSize: 9.5, padding: "1px 6px" }}>Default</span>}</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        {!u.is_default && <button type="button" style={{ fontSize: 10, padding: "2px 7px" }} onClick={() => makeUnitDefault(u)}>Make default</button>}
                        {!u.is_default && <button type="button" style={{ fontSize: 10, padding: "2px 7px" }} onClick={() => deleteUnit(u)}>Delete</button>}
                      </div>
                    </div>
                  ))}
                  {!addingUnit ? (
                    <button type="button" style={{ fontSize: 10.5, padding: "3px 8px", marginTop: 4 }} onClick={() => { setAddingUnit(true); setUnitForm({ unit_name: "", kg_per_unit: "", is_default: false }); }}>+ Add purchase unit</button>
                  ) : (
                    <form onSubmit={submitUnit} style={{ marginTop: 6, background: "var(--surface-2, #F7F5F0)", padding: 10, borderRadius: 8 }}>
                      <Field label="Unit name (e.g. CFT, Brass, MT)"><input required value={unitForm.unit_name} onChange={(e) => setUnitForm({ ...unitForm, unit_name: e.target.value })} style={inputStyle} /></Field>
                      <Field label="Kg per this unit"><input required type="number" step="0.0001" min="0" value={unitForm.kg_per_unit} onChange={(e) => setUnitForm({ ...unitForm, kg_per_unit: e.target.value })} style={inputStyle} /></Field>
                      <label style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                        <input type="checkbox" checked={unitForm.is_default} onChange={(e) => setUnitForm({ ...unitForm, is_default: e.target.checked })} />
                        Make this the default (used by orders/receipts)
                      </label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="submit" disabled={saving} style={{ flex: 1 }}>{saving ? "Saving..." : "Save unit"}</button>
                        <button type="button" onClick={() => setAddingUnit(false)} style={{ flex: 1 }}>Cancel</button>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
      {materials.length === 0 && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>No materials yet — add the first one.</div>}

      {editing && (
        <Modal title={editing.id ? `Edit material — ${editing.name}` : "New material"} onClose={() => setEditing(null)}>
          <form onSubmit={submit}>
            <Field label="Name"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} /></Field>
            <Field label="Category"><input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={inputStyle} placeholder="e.g. Cement, Aggregate, Admixture" /></Field>
            <Field label="Sub-category (optional)"><input value={form.sub_category} onChange={(e) => setForm({ ...form, sub_category: e.target.value })} style={inputStyle} /></Field>
            <Field label="Mix design ingredient (for the mix vs actual report)">
              <select value={form.mix_component} onChange={(e) => setForm({ ...form, mix_component: e.target.value })} style={inputStyle}>
                {MIX_COMPONENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Purchase unit"><input required value={form.purchase_unit} onChange={(e) => setForm({ ...form, purchase_unit: e.target.value })} style={inputStyle} placeholder="e.g. Bag, MT, CFT" /></Field>
            <Field label="Kg per purchase unit"><input required type="number" step="0.0001" min="0" value={form.kg_per_purchase_unit} onChange={(e) => setForm({ ...form, kg_per_purchase_unit: e.target.value })} style={inputStyle} /></Field>
            <Field label="Tolerance % (optional, for short-supply flagging)"><input type="number" step="0.1" min="0" value={form.tolerance_pct} onChange={(e) => setForm({ ...form, tolerance_pct: e.target.value })} style={inputStyle} /></Field>
            <Field label="Reorder level (kg, optional)"><input type="number" step="0.01" min="0" value={form.reorder_level_kg} onChange={(e) => setForm({ ...form, reorder_level_kg: e.target.value })} style={inputStyle} /></Field>
            <Field label="Opening stock (kg)"><input type="number" step="0.01" min="0" value={form.opening_stock_kg} onChange={(e) => setForm({ ...form, opening_stock_kg: e.target.value })} style={inputStyle} /></Field>
            <Field label="Opening stock rate (₹ per kg, optional — used until the first receipt)"><input type="number" step="0.0001" min="0" value={form.opening_stock_rate_per_kg} onChange={(e) => setForm({ ...form, opening_stock_rate_per_kg: e.target.value })} style={inputStyle} /></Field>
            <button type="submit" disabled={saving} style={{ width: "100%" }}>{saving ? "Saving..." : "Save material"}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ===================== Suppliers, rates & transporters tab (Administrator) =====================
// A supplier may quote a material at both scopes (delivered / ex-factory) —
// one rate row per scope. Ex-factory orders additionally need a transporter
// on file for that supplier+material, with a freight rate/basis; one can be
// marked default. Global transporters (name/phone) are created once and then
// linked to as many supplier+material combinations as needed.

function SuppliersTab() {
  const [suppliers, setSuppliers] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [transporters, setTransporters] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [editingSupplier, setEditingSupplier] = useState(null); // null | {} | {...}
  const [supplierForm, setSupplierForm] = useState({});
  const [saving, setSaving] = useState(false);

  const [expanded, setExpanded] = useState(null); // supplier id whose rates/transporters are shown
  const [rates, setRates] = useState([]);
  const [links, setLinks] = useState([]);

  const [addingRate, setAddingRate] = useState(false);
  const [rateForm, setRateForm] = useState({ material_id: "", scope: "delivered", rate: "" });

  // Round 140, item 2 — effective-dated rate history.
  const [showingHistory, setShowingHistory] = useState(false);
  const [rateHistory, setRateHistory] = useState([]);

  const [addingLink, setAddingLink] = useState(false);
  const [linkForm, setLinkForm] = useState({ material_id: "", transporter_id: "", new_transporter_name: "", new_transporter_phone: "", freight_rate: "", freight_basis: "per_purchase_unit", is_default: false });

  async function loadAll() {
    try {
      const [s, m, t] = await Promise.all([
        apiRequest("/material-module/suppliers"),
        apiRequest("/material-module/materials"),
        apiRequest("/material-module/transporters"),
      ]);
      setSuppliers(s); setMaterials(m); setTransporters(t);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { loadAll(); }, []);

  async function loadSupplierDetail(supplierId) {
    try {
      const [r, l] = await Promise.all([
        apiRequest(`/material-module/suppliers/${supplierId}/rates`),
        apiRequest(`/material-module/suppliers/${supplierId}/transporters`),
      ]);
      setRates(r); setLinks(l);
    } catch (err) { setError(err.message); }
  }

  function toggleExpand(s) {
    if (expanded === s.id) { setExpanded(null); return; }
    setExpanded(s.id);
    setAddingRate(false); setAddingLink(false); setShowingHistory(false);
    loadSupplierDetail(s.id);
  }

  async function toggleHistory() {
    if (showingHistory) { setShowingHistory(false); return; }
    setError("");
    try {
      setRateHistory(await apiRequest(`/material-module/suppliers/${expanded}/rates/history`));
      setShowingHistory(true);
    } catch (err) { setError(err.message); }
  }

  function openNewSupplier() {
    setSupplierForm({ name: "", contact_person: "", phone: "", address: "", gstin: "" });
    setEditingSupplier({});
    setError(""); setNotice("");
  }
  function openEditSupplier(s) {
    setSupplierForm({ name: s.name, contact_person: s.contact_person || "", phone: s.phone || "", address: s.address || "", gstin: s.gstin || "" });
    setEditingSupplier(s);
    setError(""); setNotice("");
  }
  async function submitSupplier(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      if (editingSupplier.id) {
        await apiRequest(`/material-module/suppliers/${editingSupplier.id}`, { method: "PATCH", body: supplierForm });
        setNotice("Supplier updated.");
      } else {
        await apiRequest("/material-module/suppliers", { method: "POST", body: supplierForm });
        setNotice("Supplier added.");
      }
      setEditingSupplier(null);
      await loadAll();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  async function toggleSupplierActive(s) {
    setError(""); setNotice("");
    try {
      await apiRequest(`/material-module/suppliers/${s.id}`, { method: "PATCH", body: { is_active: !s.is_active } });
      await loadAll();
    } catch (err) { setError(err.message); }
  }

  async function submitRate(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest(`/material-module/suppliers/${expanded}/rates`, { method: "POST", body: rateForm });
      setNotice("Rate saved.");
      setAddingRate(false);
      setRateForm({ material_id: "", scope: "delivered", rate: "" });
      await loadSupplierDetail(expanded);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function submitLink(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      let transporterId = linkForm.transporter_id;
      if (!transporterId) {
        if (!linkForm.new_transporter_name.trim()) throw new Error("Pick an existing transporter or enter a new transporter's name.");
        const created = await apiRequest("/material-module/transporters", { method: "POST", body: { name: linkForm.new_transporter_name, phone: linkForm.new_transporter_phone || null } });
        transporterId = created.id;
      }
      await apiRequest(`/material-module/suppliers/${expanded}/transporters`, {
        method: "POST",
        body: { material_id: linkForm.material_id, transporter_id: transporterId, freight_rate: linkForm.freight_rate, freight_basis: linkForm.freight_basis, is_default: linkForm.is_default },
      });
      setNotice("Transporter linked.");
      setAddingLink(false);
      setLinkForm({ material_id: "", transporter_id: "", new_transporter_name: "", new_transporter_phone: "", freight_rate: "", freight_basis: "per_purchase_unit", is_default: false });
      await loadSupplierDetail(expanded);
      const t = await apiRequest("/material-module/transporters");
      setTransporters(t);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 10 }}>{notice}</div>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Suppliers</div>
        <button type="button" onClick={openNewSupplier} style={{ fontSize: 12, padding: "6px 12px" }}>+ New supplier</button>
      </div>

      {suppliers.map((s) => (
        <div key={s.id} className="card" style={{ marginBottom: 8, opacity: s.is_active ? 1 : 0.55 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{s.name}{!s.is_active && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>Inactive</span>}</div>
              <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 3 }}>
                {s.contact_person ? `${s.contact_person} · ` : ""}{s.phone || "no phone on file"}{s.gstin ? ` · GSTIN ${s.gstin}` : ""}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button type="button" style={{ fontSize: 11, padding: "4px 9px" }} onClick={() => openEditSupplier(s)}>Edit</button>
              <button type="button" style={{ fontSize: 11, padding: "4px 9px" }} onClick={() => toggleSupplierActive(s)}>{s.is_active ? "Deactivate" : "Reactivate"}</button>
            </div>
          </div>
          <button type="button" onClick={() => toggleExpand(s)} style={{ fontSize: 10.5, padding: "3px 0", marginTop: 8, background: "none", border: "none", color: "var(--rebar)", textAlign: "left" }}>
            {expanded === s.id ? "Hide rates & transporters ↑" : "Rates & transporters →"}
          </button>

          {expanded === s.id && (
            <div style={{ marginTop: 10, borderTop: "1px solid var(--border, #DEDAD1)", paddingTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700 }}>Material rates <span style={{ fontWeight: 400, color: "var(--slate)" }}>(current)</span></div>
                <button type="button" style={{ fontSize: 10, padding: "2px 8px" }} onClick={toggleHistory}>{showingHistory ? "Hide history" : "Rate history →"}</button>
              </div>
              {rates.length === 0 && <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 6 }}>No rates on file yet.</div>}
              {rates.map((r) => (
                <div key={r.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, padding: "4px 0" }}>
                  <span>{r.material_name} · {SCOPE_LABEL[r.scope]} <span style={{ color: "var(--slate)", fontSize: 10.5 }}>since {fmtDate(r.valid_from)}</span></span>
                  <span style={{ fontWeight: 600 }}>{fmtMoney(r.rate)} / {r.purchase_unit}</span>
                </div>
              ))}

              {showingHistory && (
                <div style={{ marginTop: 6, marginBottom: 8, background: "var(--surface-2, #F7F5F0)", padding: 10, borderRadius: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>Rate history — every rate this supplier has quoted</div>
                  {rateHistory.length === 0 && <div style={{ fontSize: 11, color: "var(--slate)" }}>No history yet.</div>}
                  {rateHistory.map((r) => (
                    <div key={r.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "3px 0", opacity: r.valid_to ? 0.7 : 1 }}>
                      <span>{r.material_name} · {SCOPE_LABEL[r.scope]} · {fmtDate(r.valid_from)}{r.valid_to ? ` – ${fmtDate(r.valid_to)}` : " – current"}</span>
                      <span style={{ fontWeight: 600 }}>{fmtMoney(r.rate)} / {r.purchase_unit}</span>
                    </div>
                  ))}
                </div>
              )}

              {!addingRate ? (
                <button type="button" style={{ fontSize: 10.5, padding: "3px 8px", marginTop: 4 }} onClick={() => { setAddingRate(true); setRateForm({ material_id: "", scope: "delivered", rate: "", valid_from: todayStr() }); }}>+ Add / update rate</button>
              ) : (
                <form onSubmit={submitRate} style={{ marginTop: 6, background: "var(--surface-2, #F7F5F0)", padding: 10, borderRadius: 8 }}>
                  <Field label="Material">
                    <select required value={rateForm.material_id} onChange={(e) => setRateForm({ ...rateForm, material_id: e.target.value })} style={inputStyle}>
                      <option value="">Select material</option>
                      {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Scope">
                    <select value={rateForm.scope} onChange={(e) => setRateForm({ ...rateForm, scope: e.target.value })} style={inputStyle}>
                      <option value="delivered">Delivered</option>
                      <option value="ex_factory">Ex-factory</option>
                    </select>
                  </Field>
                  <Field label="Rate (₹ per purchase unit)"><input required type="number" step="0.01" min="0" value={rateForm.rate} onChange={(e) => setRateForm({ ...rateForm, rate: e.target.value })} style={inputStyle} /></Field>
                  <Field label="Effective from"><input type="date" value={rateForm.valid_from || todayStr()} onChange={(e) => setRateForm({ ...rateForm, valid_from: e.target.value })} style={inputStyle} /></Field>
                  <div style={{ fontSize: 10.5, color: "var(--slate)", marginBottom: 8 }}>Saving closes the current rate the day before this date and starts the new one — nothing is overwritten, so it stays in Rate history.</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="submit" disabled={saving} style={{ flex: 1 }}>{saving ? "Saving..." : "Save rate"}</button>
                    <button type="button" onClick={() => setAddingRate(false)} style={{ flex: 1 }}>Cancel</button>
                  </div>
                </form>
              )}

              <div style={{ fontSize: 11.5, fontWeight: 700, margin: "12px 0 4px" }}>Transporters (ex-factory)</div>
              {links.length === 0 && <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 6 }}>No transporters linked yet.</div>}
              {links.map((l) => (
                <div key={l.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, padding: "4px 0" }}>
                  <span>{l.transporter_name}{l.is_default && <span className="badge badge-info" style={{ marginLeft: 6, fontSize: 9.5, padding: "1px 6px" }}>Default</span>}</span>
                  <span style={{ fontWeight: 600 }}>{fmtMoney(l.freight_rate)} · {FREIGHT_BASIS_LABEL[l.freight_basis]}</span>
                </div>
              ))}
              {!addingLink ? (
                <button type="button" style={{ fontSize: 10.5, padding: "3px 8px", marginTop: 4 }} onClick={() => { setAddingLink(true); setLinkForm({ material_id: "", transporter_id: "", new_transporter_name: "", new_transporter_phone: "", freight_rate: "", freight_basis: "per_purchase_unit", is_default: false }); }}>+ Link transporter</button>
              ) : (
                <form onSubmit={submitLink} style={{ marginTop: 6, background: "var(--surface-2, #F7F5F0)", padding: 10, borderRadius: 8 }}>
                  <Field label="Material">
                    <select required value={linkForm.material_id} onChange={(e) => setLinkForm({ ...linkForm, material_id: e.target.value })} style={inputStyle}>
                      <option value="">Select material</option>
                      {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Transporter">
                    <select value={linkForm.transporter_id} onChange={(e) => setLinkForm({ ...linkForm, transporter_id: e.target.value })} style={inputStyle}>
                      <option value="">+ New transporter (enter below)</option>
                      {transporters.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </Field>
                  {!linkForm.transporter_id && (
                    <>
                      <Field label="New transporter name"><input value={linkForm.new_transporter_name} onChange={(e) => setLinkForm({ ...linkForm, new_transporter_name: e.target.value })} style={inputStyle} /></Field>
                      <Field label="New transporter phone (optional)"><input value={linkForm.new_transporter_phone} onChange={(e) => setLinkForm({ ...linkForm, new_transporter_phone: e.target.value })} style={inputStyle} /></Field>
                    </>
                  )}
                  <Field label="Freight rate (₹)"><input required type="number" step="0.01" min="0" value={linkForm.freight_rate} onChange={(e) => setLinkForm({ ...linkForm, freight_rate: e.target.value })} style={inputStyle} /></Field>
                  <Field label="Freight basis">
                    <select value={linkForm.freight_basis} onChange={(e) => setLinkForm({ ...linkForm, freight_basis: e.target.value })} style={inputStyle}>
                      <option value="per_purchase_unit">Per purchase unit</option>
                      <option value="per_trip">Per trip</option>
                      <option value="per_kg">Per kg</option>
                    </select>
                  </Field>
                  <label style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                    <input type="checkbox" checked={linkForm.is_default} onChange={(e) => setLinkForm({ ...linkForm, is_default: e.target.checked })} />
                    Default transporter for this material
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="submit" disabled={saving} style={{ flex: 1 }}>{saving ? "Saving..." : "Save link"}</button>
                    <button type="button" onClick={() => setAddingLink(false)} style={{ flex: 1 }}>Cancel</button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      ))}
      {suppliers.length === 0 && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>No suppliers yet — add the first one.</div>}

      {editingSupplier && (
        <Modal title={editingSupplier.id ? `Edit supplier — ${editingSupplier.name}` : "New supplier"} onClose={() => setEditingSupplier(null)}>
          <form onSubmit={submitSupplier}>
            <Field label="Name"><input required value={supplierForm.name} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} style={inputStyle} /></Field>
            <Field label="Contact person"><input value={supplierForm.contact_person} onChange={(e) => setSupplierForm({ ...supplierForm, contact_person: e.target.value })} style={inputStyle} /></Field>
            <Field label="Phone"><input value={supplierForm.phone} onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} style={inputStyle} /></Field>
            <Field label="Address"><textarea rows={2} value={supplierForm.address} onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })} style={{ ...inputStyle, fontFamily: "inherit" }} /></Field>
            <Field label="GSTIN (optional)"><input value={supplierForm.gstin} onChange={(e) => setSupplierForm({ ...supplierForm, gstin: e.target.value })} style={inputStyle} /></Field>
            <button type="submit" disabled={saving} style={{ width: "100%" }}>{saving ? "Saving..." : "Save supplier"}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ===================== Orders tab (Store creates, Administrator approves) =====================
// Confirmed decision: an order cannot be received against until Administrator
// approves it (see backend's header comment on this route).

function blankOrderForm() {
  return { material_id: "", supplier_id: "", scope: "delivered", transporter_id: "", ordered_qty: "", rate: "", freight_rate: "", freight_basis: "per_purchase_unit", tax_pct: "0", gst_treatment: "excluded", notes: "" };
}

function OrdersTab({ role }) {
  const isAdmin = isAdminLevel(role);
  const [orders, setOrders] = useState([]);
  const [pending, setPending] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(blankOrderForm());
  const [supplierRates, setSupplierRates] = useState([]);
  const [supplierTransporters, setSupplierTransporters] = useState([]);

  const [rejecting, setRejecting] = useState(null);
  const [rejectReason, setRejectReason] = useState("");

  // Round 140, item 7 — close / revise an approved order.
  const [closing, setClosing] = useState(null);
  const [closeReason, setCloseReason] = useState("");
  const [revising, setRevising] = useState(null);
  const [reviseForm, setReviseForm] = useState({});

  async function load() {
    try {
      const [mine, m, s] = await Promise.all([
        apiRequest("/material-module/orders/mine"),
        apiRequest("/material-module/materials"),
        apiRequest("/material-module/suppliers"),
      ]);
      setOrders(mine); setMaterials(m); setSuppliers(s);
      if (isAdmin) setPending(await apiRequest("/material-module/orders/pending"));
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  // Rate card for the chosen supplier, fetched once a supplier is picked.
  useEffect(() => {
    if (!creating || !form.supplier_id) { setSupplierRates([]); return; }
    apiRequest(`/material-module/suppliers/${form.supplier_id}/rates`).then(setSupplierRates).catch(() => setSupplierRates([]));
  }, [creating, form.supplier_id]);

  // Transporters on file for this supplier+material, only relevant ex-factory.
  useEffect(() => {
    if (!creating || form.scope !== "ex_factory" || !form.supplier_id || !form.material_id) { setSupplierTransporters([]); return; }
    apiRequest(`/material-module/suppliers/${form.supplier_id}/transporters?material_id=${form.material_id}`).then(setSupplierTransporters).catch(() => setSupplierTransporters([]));
  }, [creating, form.supplier_id, form.material_id, form.scope]);

  // Prefill the rate from the supplier's rate card — only while the field is
  // still empty, so it never overwrites something the user already typed.
  useEffect(() => {
    if (!creating) return;
    const match = supplierRates.find((r) => String(r.material_id) === String(form.material_id) && r.scope === form.scope);
    if (match && !form.rate) setForm((f) => ({ ...f, rate: match.rate }));
  }, [supplierRates]); // eslint-disable-line react-hooks/exhaustive-deps

  // Prefill the default transporter + freight, same "don't overwrite" rule.
  useEffect(() => {
    if (!creating || form.scope !== "ex_factory") return;
    const def = supplierTransporters.find((l) => l.is_default) || supplierTransporters[0];
    if (def && !form.transporter_id) {
      setForm((f) => ({ ...f, transporter_id: String(def.transporter_id), freight_rate: f.freight_rate || def.freight_rate, freight_basis: def.freight_basis }));
    }
  }, [supplierTransporters]); // eslint-disable-line react-hooks/exhaustive-deps

  function openNew() {
    setForm(blankOrderForm());
    setSupplierRates([]); setSupplierTransporters([]);
    setCreating(true);
    setError(""); setNotice("");
  }

  async function submitOrder(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest("/material-module/orders", { method: "POST", body: form });
      setNotice("Order sent to Administrator for approval.");
      setCreating(false);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function approve(o) {
    setError(""); setNotice("");
    try {
      await apiRequest(`/material-module/orders/${o.id}/approve`, { method: "POST" });
      setNotice("Order approved.");
      await load();
    } catch (err) { setError(err.message); }
  }
  function openReject(o) { setRejecting(o); setRejectReason(""); setError(""); }
  async function submitReject(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest(`/material-module/orders/${rejecting.id}/reject`, { method: "POST", body: { reason: rejectReason } });
      setNotice("Order rejected.");
      setRejecting(null);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  function openClose(o) { setClosing(o); setCloseReason(""); setError(""); }
  async function submitClose(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest(`/material-module/orders/${closing.id}/close`, { method: "POST", body: { reason: closeReason || null } });
      setNotice("Order closed.");
      setClosing(null);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  function openRevise(o) {
    setRevising(o);
    setReviseForm({ ordered_qty: o.ordered_qty, rate: o.rate, freight_rate: o.freight_rate ?? "", freight_basis: o.freight_basis || "per_purchase_unit", tax_pct: o.tax_pct ?? "0", gst_treatment: o.gst_treatment });
    setError(""); setNotice("");
  }
  async function submitRevise(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest(`/material-module/orders/${revising.id}`, { method: "PATCH", body: reviseForm });
      setNotice("Order revised.");
      setRevising(null);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 10 }}>{notice}</div>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{isAdmin ? "All orders" : "My orders"}</div>
        <button type="button" onClick={openNew} style={{ fontSize: 12, padding: "6px 12px" }}>+ New order</button>
      </div>

      {isAdmin && pending.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 6 }}>Pending your approval</div>
          {pending.map((o) => (
            <div key={o.id} className="card" style={{ marginBottom: 8, background: "var(--amber-bg)" }}>
              <OrderSummary o={o} />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" style={{ fontSize: 11.5, padding: "5px 10px", flex: 1 }} onClick={() => approve(o)}>Approve</button>
                <button type="button" className="btn-danger" style={{ fontSize: 11.5, padding: "5px 10px", flex: 1 }} onClick={() => openReject(o)}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {orders.map((o) => (
        <div key={o.id} className="card" style={{ marginBottom: 8 }}>
          <OrderSummary o={o} />
          {isAdmin && o.status === "approved" && (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" style={{ fontSize: 11, padding: "4px 9px" }} onClick={() => openRevise(o)}>Revise</button>
              <button type="button" className="btn-danger" style={{ fontSize: 11, padding: "4px 9px" }} onClick={() => openClose(o)}>Close order</button>
            </div>
          )}
        </div>
      ))}
      {orders.length === 0 && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>No orders yet.</div>}

      {creating && (
        <Modal title="New material order" onClose={() => setCreating(false)} wide>
          <form onSubmit={submitOrder}>
            <Field label="Material">
              <select required value={form.material_id} onChange={(e) => setForm({ ...form, material_id: e.target.value })} style={inputStyle}>
                <option value="">Select material</option>
                {materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.purchase_unit})</option>)}
              </select>
            </Field>
            <Field label="Supplier">
              <select required value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value, transporter_id: "", rate: "", freight_rate: "" })} style={inputStyle}>
                <option value="">Select supplier</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Scope">
              <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value, transporter_id: "" })} style={inputStyle}>
                <option value="delivered">Delivered (supplier arranges transport)</option>
                <option value="ex_factory">Ex-factory (we arrange transport)</option>
              </select>
            </Field>
            {form.scope === "ex_factory" && (
              <Field label="Transporter">
                <select required value={form.transporter_id} onChange={(e) => {
                  const link = supplierTransporters.find((l) => String(l.transporter_id) === e.target.value);
                  setForm({ ...form, transporter_id: e.target.value, freight_rate: link ? link.freight_rate : form.freight_rate, freight_basis: link ? link.freight_basis : form.freight_basis });
                }} style={inputStyle}>
                  <option value="">Select transporter</option>
                  {supplierTransporters.map((l) => <option key={l.transporter_id} value={l.transporter_id}>{l.transporter_name}{l.is_default ? " (default)" : ""}</option>)}
                </select>
              </Field>
            )}
            <Field label="Ordered quantity"><input required type="number" step="0.01" min="0" value={form.ordered_qty} onChange={(e) => setForm({ ...form, ordered_qty: e.target.value })} style={inputStyle} /></Field>
            <Field label="Rate (₹ per purchase unit)"><input required type="number" step="0.01" min="0" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} style={inputStyle} /></Field>
            {form.scope === "ex_factory" && (
              <>
                <Field label="Freight rate (₹, override if needed)"><input type="number" step="0.01" min="0" value={form.freight_rate} onChange={(e) => setForm({ ...form, freight_rate: e.target.value })} style={inputStyle} /></Field>
                <Field label="Freight basis">
                  <select value={form.freight_basis} onChange={(e) => setForm({ ...form, freight_basis: e.target.value })} style={inputStyle}>
                    <option value="per_purchase_unit">Per purchase unit</option>
                    <option value="per_trip">Per trip</option>
                    <option value="per_kg">Per kg</option>
                  </select>
                </Field>
              </>
            )}
            <Field label="Tax %"><input type="number" step="0.01" min="0" value={form.tax_pct} onChange={(e) => setForm({ ...form, tax_pct: e.target.value })} style={inputStyle} /></Field>
            <Field label="GST treatment">
              <select value={form.gst_treatment} onChange={(e) => setForm({ ...form, gst_treatment: e.target.value })} style={inputStyle}>
                <option value="excluded">Excluded (claimable — not added to landed cost)</option>
                <option value="included">Included (not claimable — added to landed cost)</option>
              </select>
            </Field>
            <Field label="Notes (optional)"><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, fontFamily: "inherit" }} /></Field>
            <button type="submit" disabled={saving} style={{ width: "100%" }}>{saving ? "Sending..." : "Send for approval"}</button>
          </form>
        </Modal>
      )}

      {rejecting && (
        <Modal title={`Reject order — ${rejecting.material_name}`} onClose={() => setRejecting(null)}>
          <form onSubmit={submitReject}>
            <Field label="Reason"><textarea required rows={2} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} style={{ ...inputStyle, fontFamily: "inherit" }} /></Field>
            <button type="submit" disabled={saving} className="btn-danger" style={{ width: "100%" }}>{saving ? "Saving..." : "Reject order"}</button>
          </form>
        </Modal>
      )}

      {closing && (
        <Modal title={`Close order — ${closing.material_name}`} onClose={() => setClosing(null)}>
          <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>
            Stops this order from accepting any more receipts (outstanding {fmtNum(Number(closing.ordered_qty) - Number(closing.received_qty))} {closing.purchase_unit} is abandoned) — use this when the rate or supply conditions changed and a new order was placed instead. This can't be undone.
          </div>
          <form onSubmit={submitClose}>
            <Field label="Reason (optional)"><textarea rows={2} value={closeReason} onChange={(e) => setCloseReason(e.target.value)} style={{ ...inputStyle, fontFamily: "inherit" }} /></Field>
            <button type="submit" disabled={saving} className="btn-danger" style={{ width: "100%" }}>{saving ? "Closing..." : "Close order"}</button>
          </form>
        </Modal>
      )}

      {revising && (
        <Modal title={`Revise order — ${revising.material_name}`} onClose={() => setRevising(null)} wide>
          <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>
            Receipts already recorded against this order keep the rate they were taken at — only receipts from now on use the revised rate.
          </div>
          <form onSubmit={submitRevise}>
            <Field label="Ordered quantity"><input required type="number" step="0.01" min="0" value={reviseForm.ordered_qty} onChange={(e) => setReviseForm({ ...reviseForm, ordered_qty: e.target.value })} style={inputStyle} /></Field>
            <Field label="Rate (₹ per purchase unit)"><input required type="number" step="0.01" min="0" value={reviseForm.rate} onChange={(e) => setReviseForm({ ...reviseForm, rate: e.target.value })} style={inputStyle} /></Field>
            {revising.scope === "ex_factory" && (
              <>
                <Field label="Freight rate (₹)"><input type="number" step="0.01" min="0" value={reviseForm.freight_rate} onChange={(e) => setReviseForm({ ...reviseForm, freight_rate: e.target.value })} style={inputStyle} /></Field>
                <Field label="Freight basis">
                  <select value={reviseForm.freight_basis} onChange={(e) => setReviseForm({ ...reviseForm, freight_basis: e.target.value })} style={inputStyle}>
                    <option value="per_purchase_unit">Per purchase unit</option>
                    <option value="per_trip">Per trip</option>
                    <option value="per_kg">Per kg</option>
                  </select>
                </Field>
              </>
            )}
            <Field label="Tax %"><input type="number" step="0.01" min="0" value={reviseForm.tax_pct} onChange={(e) => setReviseForm({ ...reviseForm, tax_pct: e.target.value })} style={inputStyle} /></Field>
            <Field label="GST treatment">
              <select value={reviseForm.gst_treatment} onChange={(e) => setReviseForm({ ...reviseForm, gst_treatment: e.target.value })} style={inputStyle}>
                <option value="excluded">Excluded (claimable — not added to landed cost)</option>
                <option value="included">Included (not claimable — added to landed cost)</option>
              </select>
            </Field>
            <button type="submit" disabled={saving} style={{ width: "100%" }}>{saving ? "Saving..." : "Save revision"}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function OrderSummary({ o }) {
  const receivedPct = Number(o.ordered_qty) > 0 ? (Number(o.received_qty) / Number(o.ordered_qty)) * 100 : 0;
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{o.material_name}</div>
          <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>
            {o.supplier_name} · {SCOPE_LABEL[o.scope]}{o.transporter_name ? ` via ${o.transporter_name}` : ""}
          </div>
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, color: ORDER_STATUS_COLOR[o.status] }}>{ORDER_STATUS_LABEL[o.status]}</span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 4 }}>
        Ordered {fmtNum(o.ordered_qty)} {o.purchase_unit} @ {fmtMoney(o.rate)} · Received {fmtNum(o.received_qty)} {o.purchase_unit} ({fmtNum(receivedPct, 0)}%)
      </div>
      <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 2 }}>
        Requested by {o.requested_by_name} · {fmtDateTime(o.requested_at)}
        {o.approved_by_name ? ` · ${o.status === "rejected" ? "Rejected" : "Approved"} by ${o.approved_by_name} · ${fmtDateTime(o.approved_at)}` : ""}
      </div>
      {o.status === "rejected" && o.rejected_reason && <div style={{ fontSize: 11.5, color: "var(--alert-red)", marginTop: 3 }}>Reason: {o.rejected_reason}</div>}
      {o.status === "closed" && <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 3 }}>Closed{o.closed_reason ? ` — ${o.closed_reason}` : ""}</div>}
      {o.revised_at && <div style={{ fontSize: 10.5, color: "var(--slate)", marginTop: 2 }}>Last revised {fmtDateTime(o.revised_at)}</div>}
      {o.notes && <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 3, fontStyle: "italic" }}>{o.notes}</div>}
    </>
  );
}

// ===================== Receipts tab (receive against an approved order) =====================
// Weighbridge weight is a manual entry for now (see claude/weighbridge-
// integration-notes.md — the sync is a later phase). Accepted quantity
// defaults to the weighbridge weight when left blank; Store can override it
// directly instead. The transporter/freight on the receipt default to
// whatever's on the order and aren't re-picked here — override the order
// itself (a new order) if a different transporter actually showed up.

function blankReceiptForm() {
  return { supplier_qty: "", weighbridge_weight_kg: "", accepted_qty: "", vehicle_number: "", challan_number: "", debit_note_amount: "", notes: "", weighbridge_ticket_id: "", short_reason: "" };
}

function receiptEditForm(r) {
  return {
    supplier_qty: r.supplier_qty, weighbridge_weight_kg: r.weighbridge_weight_kg ?? "",
    accepted_qty: r.accepted_qty, vehicle_number: r.vehicle_number || "", challan_number: r.challan_number || "",
    debit_note_amount: r.debit_note_amount ?? "", notes: r.notes || "",
  };
}

function ReceiptsTab({ role }) {
  const isAdmin = isAdminLevel(role);
  const [receivable, setReceivable] = useState([]);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  const [saving, setSaving] = useState(false);

  const [receiving, setReceiving] = useState(null); // order being received against
  const [form, setForm] = useState(blankReceiptForm());

  // Round 140, item 6 — Admin edit/delete a wrong receipt entry.
  const [editingReceipt, setEditingReceipt] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [deletingReceipt, setDeletingReceipt] = useState(null);

  async function load() {
    try {
      const [r, h] = await Promise.all([
        apiRequest("/material-module/orders/receivable"),
        apiRequest("/material-module/receipts"),
      ]);
      setReceivable(r); setHistory(h);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  function openReceive(o) {
    setReceiving(o);
    setForm(blankReceiptForm());
    setError(""); setNotice(""); setWarning("");
  }

  // Round 156 — the weighbridge tickets this order could be receiving against.
  // Matched, unclaimed, and already narrowed to the order's own material and
  // supplier by the backend, so nothing here can offer the wrong load.
  const [wbTickets, setWbTickets] = useState([]);
  useEffect(() => {
    if (!receiving) { setWbTickets([]); return; }
    let alive = true;
    apiRequest(`/material-module/orders/${receiving.id}/weighbridge-tickets`)
      .then((r) => { if (alive) setWbTickets(r); })
      .catch(() => { if (alive) setWbTickets([]); });
    return () => { alive = false; };
  }, [receiving]);

  // Picking a ticket fills what the weighbridge actually knows and leaves the
  // rest to Store. The billed quantity is deliberately NOT filled: the
  // weighbridge records a DC number but never a DC quantity, and that missing
  // number is the only thing that makes short-load checking possible.
  function useTicket(t) {
    setForm((f) => ({
      ...f,
      weighbridge_ticket_id: String(t.ticket_number),
      weighbridge_weight_kg: String(t.net_weight_kg),
      accepted_qty: t.net_purchase_units != null ? String(t.net_purchase_units) : f.accepted_qty,
      vehicle_number: t.vehicle_registration || f.vehicle_number,
      challan_number: t.challan_number && t.challan_number !== "001" ? t.challan_number : f.challan_number,
    }));
  }

  async function submitReceipt(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice(""); setWarning("");
    try {
      const result = await apiRequest("/material-module/receipts", { method: "POST", body: { order_id: receiving.id, ...form } });
      // Round 158 — two genuinely different outcomes, so two different things
      // to say. A receipt that posted is finished business; one waiting on a
      // Manager has NOT reached stock yet, and Store needs to know that rather
      // than discovering it when the stock figure looks wrong.
      if (result.pending_confirmation) {
        setNotice("Receipt saved and waiting for a Manager.");
        setWarning(result.message);
      } else {
        setNotice(`Receipt recorded — landed rate ${fmtMoney(result.landed_rate_per_kg)}/kg.`);
        if (result.tolerance_exceeded) setWarning("Short/excess quantity is beyond this material's tolerance — worth a second look.");
      }
      setReceiving(null);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  function openEditReceipt(r) {
    setEditingReceipt(r);
    setEditForm(receiptEditForm(r));
    setError(""); setNotice("");
  }
  async function submitEditReceipt(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest(`/material-module/receipts/${editingReceipt.id}`, { method: "PATCH", body: editForm });
      setNotice("Receipt updated.");
      setEditingReceipt(null);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  async function confirmDeleteReceipt() {
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest(`/material-module/receipts/${deletingReceipt.id}`, { method: "DELETE" });
      setNotice("Receipt deleted.");
      setDeletingReceipt(null);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  const outstandingUnit = receiving ? receiving.purchase_unit : "";
  const outstandingQty = receiving ? Number(receiving.ordered_qty) - Number(receiving.received_qty) : 0;

  return (
    <div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 10 }}>{notice}</div>}
      {warning && <div style={{ color: "var(--amber)", fontSize: 13, marginBottom: 10 }}>{warning}</div>}

      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Approved orders — awaiting receipt</div>
      {receivable.length === 0 && <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 16 }}>Nothing outstanding right now.</div>}
      {receivable.map((o) => {
        const outstanding = Number(o.ordered_qty) - Number(o.received_qty);
        return (
          <div key={o.id} className="card" style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{o.material_name}</div>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>
              {o.supplier_name} · {SCOPE_LABEL[o.scope]}{o.transporter_name ? ` via ${o.transporter_name}` : ""}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>
              Ordered {fmtNum(o.ordered_qty)} {o.purchase_unit} · Received so far {fmtNum(o.received_qty)} · Outstanding {fmtNum(outstanding)}
            </div>
            <button type="button" style={{ fontSize: 11.5, padding: "5px 10px", marginTop: 8 }} onClick={() => openReceive(o)}>Receive</button>
          </div>
        );
      })}

      <div style={{ fontSize: 13, fontWeight: 700, margin: "18px 0 8px" }}>Receipt history</div>
      {history.length === 0 && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>No receipts yet.</div>}
      {history.map((r) => (
        <div key={r.id} className="card" style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{r.material_name}</div>
            <div style={{ fontSize: 11, color: "var(--slate)" }}>{fmtDateTime(r.received_at)}</div>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>
            {r.supplier_name}{r.transporter_name ? ` · ${r.transporter_name}` : ""}{r.vehicle_number ? ` · ${r.vehicle_number}` : ""}
          </div>
          <div style={{ fontSize: 11.5, marginTop: 2 }}>
            Supplier qty {fmtNum(r.supplier_qty)} {r.purchase_unit} · Accepted {fmtNum(r.accepted_qty)} {r.purchase_unit}
            {Number(r.short_qty) !== 0 && <span style={{ color: Number(r.short_qty) > 0 ? "var(--alert-red)" : "var(--info)" }}> · {Number(r.short_qty) > 0 ? "Short" : "Excess"} {fmtNum(Math.abs(r.short_qty))}</span>}
          </div>
          {r.weighbridge_weight_kg != null && <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 2 }}>Weighbridge: {fmtNum(r.weighbridge_weight_kg)} kg</div>}
          {r.debit_note_amount != null && <div style={{ fontSize: 11, color: "var(--alert-red)", marginTop: 2 }}>Debit note: {fmtMoney(r.debit_note_amount)}</div>}
          <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 2 }}>Received by {r.received_by_name}</div>
          {isAdmin && (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" style={{ fontSize: 11, padding: "4px 9px" }} onClick={() => openEditReceipt(r)}>Edit</button>
              <button type="button" className="btn-danger" style={{ fontSize: 11, padding: "4px 9px" }} onClick={() => setDeletingReceipt(r)}>Delete</button>
            </div>
          )}
        </div>
      ))}

      {receiving && (
        <Modal title={`Receive — ${receiving.material_name}`} onClose={() => setReceiving(null)} wide>
          <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 10 }}>
            Outstanding on this order: {fmtNum(outstandingQty)} {outstandingUnit}
          </div>
          {/* Round 156 — pick the weighbridge ticket this load was weighed on. */}
          {!!wbTickets.length && !form.weighbridge_ticket_id && (
            <div style={{ border: "1px solid var(--rebar)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 8 }}>
                Weighbridge tickets waiting ({wbTickets.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 190, overflowY: "auto" }}>
                {wbTickets.map((t) => (
                  <div key={t.ticket_number} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border)", borderRadius: 7, padding: "8px 10px" }}>
                    <div style={{ flexGrow: 1 }}>
                      <div style={{ fontSize: 12.5 }}>
                        <strong>#{t.ticket_number}</strong> · {t.vehicle_registration || "—"} ·{" "}
                        {t.weighed_at ? new Date(t.weighed_at).toLocaleString([], { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--slate)" }}>
                        {fmtNum(t.net_weight_kg)} kg ≈ {fmtNum(t.net_purchase_units)} {outstandingUnit}
                      </div>
                    </div>
                    <button type="button" className="btn-primary" style={{ fontSize: 12 }} onClick={() => useTicket(t)}>
                      Use this
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 8, lineHeight: 1.5 }}>
                Or fill the form by hand for a delivery that never crossed the weighbridge.
              </div>
            </div>
          )}

          {!!form.weighbridge_ticket_id && (
            <div style={{ border: "1px solid var(--signal-green)", background: "var(--signal-green-bg)", borderRadius: 8, padding: "10px 12px", marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12.5, flexGrow: 1 }}>
                Linked to weighbridge ticket <strong>#{form.weighbridge_ticket_id}</strong> — weight and vehicle came from it.
              </span>
              <button type="button" style={{ fontSize: 12 }}
                      onClick={() => setForm({ ...form, weighbridge_ticket_id: "", weighbridge_weight_kg: "", accepted_qty: "", vehicle_number: "" })}>
                Unlink
              </button>
            </div>
          )}

          <form onSubmit={submitReceipt}>
            <Field label={`Supplier's invoice/DC quantity (${outstandingUnit})`}>
              <input required type="number" step="0.01" min="0" value={form.supplier_qty} onChange={(e) => setForm({ ...form, supplier_qty: e.target.value })} style={inputStyle} />
            </Field>
            <Field label="Weighbridge weight (kg)">
              <input type="number" step="0.01" min="0" value={form.weighbridge_weight_kg} onChange={(e) => setForm({ ...form, weighbridge_weight_kg: e.target.value })} style={inputStyle} />
            </Field>
            <Field label={`Accepted quantity (${outstandingUnit}) — leave blank to derive from the weighbridge weight`}>
              <input type="number" step="0.01" min="0" value={form.accepted_qty} onChange={(e) => setForm({ ...form, accepted_qty: e.target.value })} style={inputStyle} />
            </Field>
            <Field label="Vehicle number"><input value={form.vehicle_number} onChange={(e) => setForm({ ...form, vehicle_number: e.target.value })} style={inputStyle} /></Field>
            <Field label="Challan number"><input value={form.challan_number} onChange={(e) => setForm({ ...form, challan_number: e.target.value })} style={inputStyle} /></Field>
            <Field label="Debit note amount (optional, ₹ — for short supply)"><input type="number" step="0.01" min="0" value={form.debit_note_amount} onChange={(e) => setForm({ ...form, debit_note_amount: e.target.value })} style={inputStyle} /></Field>
            {/* Round 156 — required by the backend only when the shortfall is
                beyond the material's tolerance. Always shown, because asking
                for it after a rejected save is a worse experience than a box
                that is usually left empty. */}
            {/* Round 158 — no longer required for anything. The receipt saves
                either way; this just means the Manager reviewing a disputed
                load can see what the person who was actually standing there
                thought, which is worth far more than a mandatory field. */}
            <Field label="If the quantities don't match, what happened? (optional, but it helps whoever reviews it)">
              <input value={form.short_reason} onChange={(e) => setForm({ ...form, short_reason: e.target.value })}
                     placeholder="spillage · disputed slip · re-weighed" style={inputStyle} />
            </Field>
            <Field label="Notes (optional)"><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, fontFamily: "inherit" }} /></Field>
            <button type="submit" disabled={saving} style={{ width: "100%" }}>{saving ? "Saving..." : "Confirm receipt"}</button>
          </form>
        </Modal>
      )}

      {editingReceipt && (
        <Modal title={`Edit receipt — ${editingReceipt.material_name}`} onClose={() => setEditingReceipt(null)} wide>
          <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 10 }}>Correcting a wrong entry — short/excess and landed rate are recalculated from these values.</div>
          <form onSubmit={submitEditReceipt}>
            <Field label={`Supplier's invoice/DC quantity (${editingReceipt.purchase_unit})`}>
              <input required type="number" step="0.01" min="0" value={editForm.supplier_qty} onChange={(e) => setEditForm({ ...editForm, supplier_qty: e.target.value })} style={inputStyle} />
            </Field>
            <Field label="Weighbridge weight (kg)">
              <input type="number" step="0.01" min="0" value={editForm.weighbridge_weight_kg} onChange={(e) => setEditForm({ ...editForm, weighbridge_weight_kg: e.target.value })} style={inputStyle} />
            </Field>
            <Field label={`Accepted quantity (${editingReceipt.purchase_unit})`}>
              <input required type="number" step="0.01" min="0" value={editForm.accepted_qty} onChange={(e) => setEditForm({ ...editForm, accepted_qty: e.target.value })} style={inputStyle} />
            </Field>
            <Field label="Vehicle number"><input value={editForm.vehicle_number} onChange={(e) => setEditForm({ ...editForm, vehicle_number: e.target.value })} style={inputStyle} /></Field>
            <Field label="Challan number"><input value={editForm.challan_number} onChange={(e) => setEditForm({ ...editForm, challan_number: e.target.value })} style={inputStyle} /></Field>
            <Field label="Debit note amount (optional, ₹)"><input type="number" step="0.01" min="0" value={editForm.debit_note_amount} onChange={(e) => setEditForm({ ...editForm, debit_note_amount: e.target.value })} style={inputStyle} /></Field>
            <Field label="Notes (optional)"><textarea rows={2} value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} style={{ ...inputStyle, fontFamily: "inherit" }} /></Field>
            <button type="submit" disabled={saving} style={{ width: "100%" }}>{saving ? "Saving..." : "Save changes"}</button>
          </form>
        </Modal>
      )}

      {deletingReceipt && (
        <Modal title="Delete receipt?" onClose={() => setDeletingReceipt(null)}>
          <div style={{ fontSize: 12.5, marginBottom: 14 }}>
            Delete the receipt of {fmtNum(deletingReceipt.accepted_qty)} {deletingReceipt.purchase_unit} of {deletingReceipt.material_name}
            {" "}from {deletingReceipt.supplier_name} received {fmtDateTime(deletingReceipt.received_at)}? Stock and rates will recompute immediately — this can't be undone.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => setDeletingReceipt(null)} style={{ flex: 1 }}>Cancel</button>
            <button type="button" className="btn-danger" disabled={saving} onClick={confirmDeleteReceipt} style={{ flex: 1 }}>{saving ? "Deleting..." : "Delete receipt"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ===================== Consumption & production tab (Plant Operator + Administrator) =====================
// Once per day, no shift. Automatic (batching-software reading) and Manual
// (operator's own count) are two independent figures shown side by side —
// see the backend's comment on which one book-stock deduction actually uses
// (Automatic when present, else Manual).

function ConsumptionTab() {
  const [date, setDate] = useState(todayStr());
  const [materials, setMaterials] = useState([]);
  const [entries, setEntries] = useState({}); // material_id -> { automatic_qty_kg, manual_qty_kg }
  const [production, setProduction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingProduction, setSavingProduction] = useState(false);
  const [loading, setLoading] = useState(false);

  async function load(d) {
    setLoading(true); setError("");
    try {
      const [cons, prod] = await Promise.all([
        apiRequest(`/material-module/consumption?date=${d}`),
        apiRequest(`/material-module/production?date=${d}`),
      ]);
      setMaterials(cons.materials);
      const map = {};
      for (const m of cons.materials) map[m.material_id] = { automatic_qty_kg: m.automatic_qty_kg ?? "", manual_qty_kg: m.manual_qty_kg ?? "" };
      setEntries(map);
      setProduction(prod ? prod.concrete_produced_m3 : "");
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(date); }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  function setEntry(materialId, field, value) {
    setEntries((e) => ({ ...e, [materialId]: { ...e[materialId], [field]: value } }));
  }

  async function saveConsumption(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      const entryList = Object.entries(entries).map(([material_id, v]) => ({ material_id, automatic_qty_kg: v.automatic_qty_kg || null, manual_qty_kg: v.manual_qty_kg || null }));
      await apiRequest("/material-module/consumption", { method: "POST", body: { date, entries: entryList } });
      setNotice("Consumption saved.");
      await load(date);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function saveProduction(e) {
    e.preventDefault();
    setSavingProduction(true); setError(""); setNotice("");
    try {
      await apiRequest("/material-module/production", { method: "POST", body: { date, concrete_produced_m3: production } });
      setNotice("Production saved.");
    } catch (err) { setError(err.message); } finally { setSavingProduction(false); }
  }

  return (
    <div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 10 }}>{notice}</div>}

      <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} /></Field>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Concrete produced today</div>
        <form onSubmit={saveProduction} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="number" step="0.01" min="0" value={production} onChange={(e) => setProduction(e.target.value)} placeholder="m³" style={{ flex: 1 }} />
          <button type="submit" disabled={savingProduction} style={{ fontSize: 12, padding: "8px 14px" }}>{savingProduction ? "Saving..." : "Save"}</button>
        </form>
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Daily material consumption</div>
      {loading ? (
        <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading...</div>
      ) : (
        <form onSubmit={saveConsumption}>
          {materials.map((m) => (
            <div key={m.material_id} className="card" style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{m.name}</div>
              <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 10.5, color: "var(--slate)" }}>Automatic (kg)</label>
                  <input type="number" step="0.01" min="0" value={entries[m.material_id]?.automatic_qty_kg ?? ""} onChange={(e) => setEntry(m.material_id, "automatic_qty_kg", e.target.value)} style={inputStyle} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 10.5, color: "var(--slate)" }}>Manual (kg)</label>
                  <input type="number" step="0.01" min="0" value={entries[m.material_id]?.manual_qty_kg ?? ""} onChange={(e) => setEntry(m.material_id, "manual_qty_kg", e.target.value)} style={inputStyle} />
                </div>
              </div>
            </div>
          ))}
          {materials.length === 0 && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>No active materials yet — add some in the Materials tab.</div>}
          {materials.length > 0 && <button type="submit" disabled={saving} style={{ width: "100%", marginTop: 4 }}>{saving ? "Saving..." : "Save consumption"}</button>}
        </form>
      )}
    </div>
  );
}

// ===================== Stock tab (live book stock; Store sees qty only) =====================

function stockStatus(m) {
  if (m.low_stock) return { label: "Low · reorder", cls: "badge-danger" };
  // "Near reorder" is the mockup's amber middle state — within a quarter
  // above the reorder level, i.e. one more day of pouring away from it.
  if (m.reorder_level_kg != null && m.book_stock_kg <= Number(m.reorder_level_kg) * 1.25) {
    return { label: "Near reorder", cls: "badge-warning" };
  }
  return { label: "OK", cls: "badge-success" };
}

// Round 142 — rebuilt to the mockup (project/Main.dc.html + AdminStock.dc.html):
// the month's Opening / Received / Consumed movement beside book stock, the
// reorder level and status badge, an Open orders panel with fill bars, and —
// Administrator only — the average rate, stock value and total. The round 139
// version showed only book stock / days remaining / rate / value.
function StockTab({ role, onGoTab }) {
  const showValuation = role !== "store";
  const isAdmin = isAdminLevel(role);
  const [month, setMonth] = useState(thisMonthStr());
  const [materials, setMaterials] = useState([]);
  const [openOrders, setOpenOrders] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Round 140, item 8 extra — pending-approval banner + valuation KPI cards, admin only.
  const [summary, setSummary] = useState(null);

  async function load() {
    setLoading(true); setError("");
    try {
      const data = await apiRequest(`/material-module/stock?month=${month}`);
      setMaterials(data.materials);
      setOpenOrders(data.open_orders || []);
      if (isAdmin) setSummary(await apiRequest("/material-module/reports/stock-summary"));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  const lowMaterials = materials.filter((m) => m.low_stock);
  const totalValue = showValuation ? materials.reduce((sum, m) => sum + (m.stock_value || 0), 0) : null;
  // Sorted copy — never sort the state array in place, which would reorder
  // the table under the user as a side effect of computing a KPI.
  const shortest = [...materials]
    .filter((m) => m.stock_days_remaining != null)
    .sort((a, b) => a.stock_days_remaining - b.stock_days_remaining)[0];
  // Low materials with nothing on order — the mockup's red note in the Open
  // orders panel. Matched on material_id, not name, so renaming a material
  // can never make its order silently stop counting.
  const uncovered = lowMaterials.filter((m) => !openOrders.some((o) => o.material_id === m.material_id));

  return (
    <div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {isAdmin && summary && summary.pending_approval_count > 0 && (
        <div className="card" style={{ marginBottom: 12, background: "#FBF6F0", border: "1px solid #EAD9C6", display: "flex", justifyContent: "space-between", alignItems: "center", padding: 10, gap: 10 }}>
          <div style={{ fontSize: 12.5 }}>
            <b>{summary.pending_approval_count}</b> order{summary.pending_approval_count === 1 ? "" : "s"} waiting for your approval
          </div>
          <button type="button" onClick={() => onGoTab("orders")} style={{ fontSize: 11, padding: "4px 9px", whiteSpace: "nowrap" }}>Review</button>
        </div>
      )}

      <div style={kpiGridStyle}>
        <KpiCard label="Open orders" value={openOrders.length} sub={uncovered.length > 0 ? `${uncovered.map((m) => m.name).join(", ")} have none` : "every low material has cover"} />
        <KpiCard
          label="Below reorder level"
          value={lowMaterials.length}
          tone={lowMaterials.length > 0 ? "danger" : undefined}
          sub={shortest ? `${shortest.name} · lasts ${fmtNum(shortest.stock_days_remaining, 1)} days` : "no consumption recorded yet"}
        />
        {isAdmin && summary && <KpiCard label="Stock value (book)" value={fmtMoney(summary.stock_value)} tone="dark" sub={`at ${month} average rates`} />}
        {isAdmin && summary && <KpiCard label="Balance on open orders" value={fmtMoney(summary.open_order_balance_value)} />}
        {isAdmin && summary && <KpiCard label="This month's purchases" value={fmtMoney(summary.month_purchase_value)} sub="landed, excl. GST" />}
        {isAdmin && summary && <KpiCard label="Debit notes due" value={fmtMoney(summary.debit_notes_due)} tone={Number(summary.debit_notes_due) > 0 ? "danger" : undefined} />}
      </div>

      {showValuation && <Field label="Rate as of month (for valuation)"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={inputStyle} /></Field>}

      {loading ? (
        <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading...</div>
      ) : (
        <>
          <div className="card" style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Material</th>
                  <th style={{ textAlign: "right" }}>Opening</th>
                  <th style={{ textAlign: "right" }}>Received</th>
                  <th style={{ textAlign: "right" }}>Consumed</th>
                  <th style={{ textAlign: "right" }}>Book stock</th>
                  <th style={{ textAlign: "right" }}>Reorder level</th>
                  <th style={{ textAlign: "right" }}>Stock lasts</th>
                  {showValuation && <th style={{ textAlign: "right" }}>Avg rate/kg</th>}
                  {showValuation && <th style={{ textAlign: "right" }}>Value</th>}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {materials.map((m) => {
                  const st = stockStatus(m);
                  return (
                    <tr key={m.material_id}>
                      <td>
                        <b>{m.name}</b>
                        <div style={{ fontSize: 10.5, color: "var(--slate)" }}>
                          {[m.category, m.sub_category].filter(Boolean).join(" · ") || "–"}
                        </div>
                      </td>
                      <td style={{ textAlign: "right" }}>{fmtMass(m.month_opening_kg)}</td>
                      <td style={{ textAlign: "right" }}>{fmtMass(m.month_received_kg)}</td>
                      <td style={{ textAlign: "right" }}>{fmtMass(m.month_consumed_kg)}</td>
                      <td style={{ textAlign: "right" }}>
                        <b>{fmtMass(m.book_stock_kg)}</b>
                        <div style={{ fontSize: 10.5, color: "var(--slate)" }}>{fmtNum(m.book_stock_purchase_units)} {m.purchase_unit}</div>
                      </td>
                      <td style={{ textAlign: "right" }}>{m.reorder_level_kg != null ? fmtMass(m.reorder_level_kg) : "–"}</td>
                      <td style={{ textAlign: "right" }}>{m.stock_days_remaining != null ? `${fmtNum(m.stock_days_remaining, 1)} days` : "–"}</td>
                      {showValuation && <td style={{ textAlign: "right" }}>{m.rate_per_kg != null ? fmtMoney(m.rate_per_kg) : "–"}</td>}
                      {showValuation && <td style={{ textAlign: "right" }}>{m.stock_value != null ? fmtMoney(m.stock_value) : "–"}</td>}
                      <td><span className={`badge ${st.cls}`} style={{ fontSize: 9.5, padding: "1px 6px", whiteSpace: "nowrap" }}>{st.label}</span></td>
                    </tr>
                  );
                })}
                {showValuation && materials.length > 0 && (
                  <tr>
                    <td colSpan={8} style={{ fontWeight: 700 }}>Total stock value</td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>{fmtMoney(totalValue)}</td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
            {materials.length === 0 && <div style={{ fontSize: 12.5, color: "var(--slate)", padding: 8 }}>No active materials yet.</div>}
          </div>

          <div style={{ fontSize: 10.5, color: "var(--slate)", lineHeight: 1.55, margin: "8px 2px 14px" }}>
            Opening / Received / Consumed are this calendar month's movement; book stock is the running balance
            (opening + received − consumed) across all time. <b style={{ color: "var(--charcoal)" }}>Stock lasts</b> = book stock ÷
            average daily consumption so far this month.
            {showValuation && " The average rate covers this month's receipts only and starts again on the 1st; stock carried in from last month is valued at last month's closing average until the first receipt. Rates exclude GST."}
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>Open orders</div>
              <button type="button" onClick={() => onGoTab("orders")} style={{ fontSize: 11, padding: "3px 8px" }}>View all</button>
            </div>
            {openOrders.length === 0 && <div style={{ fontSize: 12, color: "var(--slate)" }}>No approved order is still outstanding.</div>}
            {openOrders.map((o) => {
              const pct = Number(o.ordered_qty) > 0 ? Math.min(100, (Number(o.received_qty) / Number(o.ordered_qty)) * 100) : 0;
              return (
                <div key={o.id} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, gap: 8 }}>
                    <b>PO-{String(o.id).padStart(4, "0")} · {o.material_name}</b>
                    <span style={{ color: "var(--slate)", whiteSpace: "nowrap" }}>{fmtNum(o.received_qty)} / {fmtNum(o.ordered_qty)} {o.purchase_unit}</span>
                  </div>
                  <div className="meter-track" style={{ margin: "4px 0" }}><div className="meter-fill" style={{ width: `${pct}%`, background: "var(--rebar)" }} /></div>
                  <div style={{ fontSize: 10.5, color: "var(--slate)" }}>{o.supplier_name} · {SCOPE_LABEL[o.scope] || o.scope}</div>
                </div>
              );
            })}
            {uncovered.length > 0 && (
              <div style={{ background: "#F8E9E7", borderRadius: 8, padding: "8px 10px", fontSize: 11.5, color: "var(--alert-red)", lineHeight: 1.5 }}>
                <b>No open order for {uncovered.map((m) => m.name).join(", ")}.</b>{" "}
                {uncovered[0].stock_days_remaining != null && `Stock lasts about ${fmtNum(uncovered[0].stock_days_remaining, 1)} days.`}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ===================== Physical stock tab (monthly count & reconciliation) =====================
// Columns match the confirmed layout: Opening | Purchase | Plant Consumption
// | Book Stock | Physical Stock | Actual Consumption | Diff kg & % | Cost of
// Actual Consumption | Cost of Difference (the last three, valuation-based,
// are Administrator-only, same as the Stock tab above).

// Round 142 — rebuilt to the mockup (project/StockCount.dc.html): one count
// sheet with every material on it, the figure entered in the unit it was
// actually counted in, actual consumption and difference computed live as you
// type, and a side panel carrying who took the stock, when, and the remarks.
// The round 139 version was a card per material with a modal per count.
function PhysicalStockTab({ role }) {
  const { user } = useAuth();
  const showValuation = role !== "store";
  const canEnter = role === "store" || isAdminLevel(role);
  const [month, setMonth] = useState(thisMonthStr());
  const [materials, setMaterials] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Draft entries, keyed by material id: { value, unit } where unit is either
  // the material's purchase unit or "kg". Only materials the user actually
  // typed into are saved — an untouched row is never posted, so opening this
  // page and leaving can't overwrite last week's count with a blank.
  const [draft, setDraft] = useState({});
  const [remarks, setRemarks] = useState("");

  async function load() {
    setLoading(true); setError("");
    try {
      const data = await apiRequest(`/material-module/physical-stock?month=${month}`);
      setMaterials(data.materials);
      setDraft({});
      setRemarks(data.materials.find((m) => m.notes)?.notes || "");
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  function setEntry(m, patch) {
    setDraft((d) => ({ ...d, [m.material_id]: { unit: m.purchase_unit, value: "", ...(d[m.material_id] || {}), ...patch } }));
  }

  // kg is the only thing stored; this is the single place the counted unit is
  // converted, so the table's live "actual consumption" and what gets saved
  // can never be computed two different ways.
  function draftKg(m) {
    const entry = draft[m.material_id];
    if (!entry || entry.value === "" || entry.value == null) return null;
    const n = Number(entry.value);
    if (!Number.isFinite(n)) return null;
    return entry.unit === "kg" ? n : n * Number(m.kg_per_purchase_unit);
  }
  function effectiveKg(m) {
    const d = draftKg(m);
    return d != null ? d : m.physical_stock_kg;
  }

  async function saveAll() {
    const entries = materials.filter((m) => draftKg(m) != null);
    if (!entries.length) { setError("Enter at least one physical stock figure first."); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      for (const m of entries) {
        await apiRequest("/material-module/physical-stock", {
          method: "POST",
          body: { material_id: m.material_id, stock_month: month, physical_stock_kg: draftKg(m), notes: remarks || null },
        });
      }
      setNotice(`Saved ${entries.length} count${entries.length === 1 ? "" : "s"}.`);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  const counted = materials.filter((m) => m.physical_stock_kg != null);
  const takenBy = counted.find((m) => m.stock_taken_by_name);
  // Previous five months, for the panel's month switcher.
  const pastMonths = [1, 2, 3, 4, 5].map((back) => addMonths(month, -back));

  return (
    <div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 10 }}>{notice}</div>}

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Monthly physical stock</div>
        <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>
          Enter what is physically in the silos, stockpiles and store.
          {counted.length > 0 && takenBy && ` Stock taken by ${takenBy.stock_taken_by_name} on ${fmtDateTime(takenBy.taken_at)}.`}
        </div>
      </div>

      <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={inputStyle} /></Field>

      {loading ? (
        <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading...</div>
      ) : (
        <>
          <div className="card" style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Raw material</th>
                  <th style={{ textAlign: "right" }}>Opening</th>
                  <th style={{ textAlign: "right" }}>Purchase</th>
                  <th style={{ textAlign: "right" }}>Plant consumption</th>
                  <th style={{ textAlign: "right" }}>Book stock</th>
                  <th style={{ textAlign: "right" }}>Stock taken in</th>
                  <th style={{ textAlign: "right" }}>Physical stock</th>
                  <th style={{ textAlign: "right" }}>Actual consumption</th>
                  <th style={{ textAlign: "right" }}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {materials.map((m) => {
                  const physKg = effectiveKg(m);
                  const actual = physKg != null ? Number(m.opening_kg) + Number(m.purchase_kg) - physKg : null;
                  const diff = actual != null ? Number(m.plant_consumption_kg) - actual : null;
                  const diffPct = diff != null && Number(m.plant_consumption_kg) !== 0 ? (diff / Number(m.plant_consumption_kg)) * 100 : null;
                  const entry = draft[m.material_id] || {};
                  return (
                    <tr key={m.material_id}>
                      <td><b>{m.name}</b>{m.physical_stock_kg != null && draftKg(m) == null && <div style={{ fontSize: 10, color: "var(--signal-green)" }}>saved</div>}</td>
                      <td style={{ textAlign: "right" }}>{fmtMass(m.opening_kg)}</td>
                      <td style={{ textAlign: "right" }}>{fmtMass(m.purchase_kg)}</td>
                      <td style={{ textAlign: "right" }}>{fmtMass(m.plant_consumption_kg)}</td>
                      <td style={{ textAlign: "right" }}>{fmtMass(m.book_stock_kg)}</td>
                      <td style={{ textAlign: "right" }}>
                        {canEnter ? (
                          <select
                            value={entry.unit || m.purchase_unit}
                            onChange={(e) => setEntry(m, { unit: e.target.value })}
                            style={{ fontSize: 11, padding: "3px 4px" }}
                            aria-label={`${m.name} counted in`}
                          >
                            <option value={m.purchase_unit}>{m.purchase_unit}</option>
                            <option value="kg">kg</option>
                          </select>
                        ) : <span style={{ color: "var(--slate)" }}>kg</span>}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {canEnter ? (
                          <>
                            <input
                              type="number" step="0.01" min="0"
                              value={entry.value !== undefined ? entry.value : (m.physical_stock_kg != null ? (m.physical_stock_kg / Number(m.kg_per_purchase_unit)).toFixed(2) : "")}
                              onChange={(e) => setEntry(m, { value: e.target.value })}
                              style={{ width: 92, textAlign: "right", fontSize: 12 }}
                              aria-label={`${m.name} physical stock`}
                            />
                            {physKg != null && <div style={{ fontSize: 10, color: "var(--slate)" }}>{fmtMass(physKg)}</div>}
                          </>
                        ) : (physKg != null ? fmtMass(physKg) : "–")}
                      </td>
                      <td style={{ textAlign: "right" }}>{actual != null ? <b>{fmtMass(actual)}</b> : "–"}</td>
                      <td style={{ textAlign: "right", color: diff != null && diff < 0 ? "var(--alert-red)" : undefined, fontWeight: diff != null && diff < 0 ? 600 : 400 }}>
                        {diff != null ? `${fmtNum(diff, 0)} kg${diffPct != null ? ` · ${fmtNum(diffPct, 2)}%` : ""}` : "–"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {materials.length === 0 && <div style={{ fontSize: 12.5, color: "var(--slate)", padding: 8 }}>No active materials yet.</div>}
            <div style={{ fontSize: 10.5, color: "var(--slate)", lineHeight: 1.6, padding: "10px 2px 2px" }}>
              <b style={{ color: "var(--charcoal)" }}>Book stock</b> = opening + purchase − plant consumption.{" "}
              <b style={{ color: "var(--charcoal)" }}>Actual consumption</b> = opening + purchase − physical stock.{" "}
              <b style={{ color: "var(--charcoal)" }}>Difference</b> = plant consumption − actual consumption; a minus means more was used than the plant reported.
              A count entered in the purchase unit is converted to kg using the material master.
              {!showValuation && " The cost columns are on the Administrator's version of this page."}
            </div>
          </div>

          {canEnter && (
            <div className="card" style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 8 }}>Stock taking</div>
              <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 8, lineHeight: 1.5 }}>
                Stock taken by <b style={{ color: "var(--charcoal)" }}>{user?.name || "you"}</b> — recorded automatically with the date and time each figure is saved.
              </div>
              <Field label="Remarks (saved against every figure in this save)">
                <input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. rain on 29–30, sand piles wet" style={inputStyle} />
              </Field>
              <button type="button" onClick={saveAll} disabled={saving} style={{ width: "100%" }}>
                {saving ? "Saving..." : "Save counts"}
              </button>
            </div>
          )}

          <div className="card" style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 8 }}>Past months</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {pastMonths.map((pm) => (
                <button key={pm} type="button" onClick={() => setMonth(pm)} style={{ fontSize: 11, padding: "4px 9px" }}>
                  {monthLabel(pm)}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--slate)", marginTop: 8 }}>
              {counted.length} of {materials.length} material{materials.length === 1 ? "" : "s"} counted for this month.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ===================== Reports tab (Administrator only) =====================

const REPORT_LIST = [
  { key: "open-orders", label: "Open orders" },
  { key: "weighbridge", label: "Weighbridge comparison" },
  { key: "daily-consumption", label: "Daily consumption" },
  { key: "mix-vs-actual", label: "Mix vs actual" },
  { key: "monthly-consumption", label: "Monthly consumption" },
  { key: "monthly-physical-stock", label: "Monthly physical stock" },
  { key: "rate-history", label: "Weighted avg rate history" },
  { key: "supplier-summary", label: "Supplier purchase summary" },
  { key: "transporter-freight", label: "Transporter freight" },
  { key: "cost-per-m3", label: "Cost per m³" },
];

function ReportsTab() {
  const [report, setReport] = useState("open-orders");
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {REPORT_LIST.map((r) => (
          <button
            key={r.key}
            type="button"
            className={`btn-tab${report === r.key ? " active" : ""}`}
            onClick={() => setReport(r.key)}
            style={{ fontSize: 11, padding: "5px 10px", borderRadius: 999 }}
          >
            {r.label}
          </button>
        ))}
      </div>
      {report === "open-orders" && <OpenOrdersReport />}
      {report === "weighbridge" && <WeighbridgeComparisonReport />}
      {report === "daily-consumption" && <DailyConsumptionReport />}
      {report === "mix-vs-actual" && <MixVsActualReport />}
      {report === "monthly-consumption" && <MonthlyConsumptionReport />}
      {report === "monthly-physical-stock" && <MonthlyPhysicalStockReport />}
      {report === "rate-history" && <RateHistoryReport />}
      {report === "supplier-summary" && <SupplierSummaryReport />}
      {report === "transporter-freight" && <TransporterFreightReport />}
      {report === "cost-per-m3" && <CostPerM3Report />}
    </div>
  );
}

function ReportShell({ error, loading, empty, children }) {
  return (
    <div className="card" style={{ overflowX: "auto" }}>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {loading ? <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading...</div> : (empty ? <div style={{ fontSize: 12.5, color: "var(--slate)" }}>No data for this range.</div> : children)}
    </div>
  );
}

function DateRangeBar({ from, to, setFrom, setTo }) {
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
      <div style={{ flex: 1 }}><label style={{ fontSize: 10.5, color: "var(--slate)" }}>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} /></div>
      <div style={{ flex: 1 }}><label style={{ fontSize: 10.5, color: "var(--slate)" }}>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inputStyle} /></div>
    </div>
  );
}

function OpenOrdersReport() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    apiRequest("/material-module/reports/open-orders").then(setRows).catch((err) => setError(err.message)).finally(() => setLoading(false));
  }, []);
  return (
    <ReportShell error={error} loading={loading} empty={!loading && rows.length === 0}>
      <table>
        <thead><tr><th>Material</th><th>Supplier</th><th>Ordered</th><th>Received</th><th>Outstanding</th><th>Approved</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.material_name}</td><td>{r.supplier_name}</td>
              <td>{fmtNum(r.ordered_qty)} {r.purchase_unit}</td><td>{fmtNum(r.received_qty)}</td>
              <td>{fmtNum(r.outstanding_qty)}</td><td>{fmtDate(r.approved_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ReportShell>
  );
}

function WeighbridgeComparisonReport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true); setError("");
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from_date", from);
      if (to) qs.set("to_date", to);
      setRows(await apiRequest(`/material-module/reports/weighbridge-comparison?${qs}`));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <DateRangeBar from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <button type="button" onClick={run} style={{ fontSize: 12, padding: "6px 12px", marginBottom: 10 }}>Run</button>
      <ReportShell error={error} loading={loading} empty={!loading && rows.length === 0}>
        <table>
          <thead><tr><th>Date</th><th>Material</th><th>Supplier</th><th>Supplier qty</th><th>Weighbridge kg</th><th>Accepted</th><th>Short/Excess</th><th>Debit note</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={r.tolerance_exceeded ? { background: "var(--alert-red-bg)" } : undefined}>
                <td>{fmtDate(r.received_at)}</td><td>{r.material_name}</td><td>{r.supplier_name}</td>
                <td>{fmtNum(r.supplier_qty)} {r.purchase_unit}</td><td>{r.weighbridge_weight_kg != null ? fmtNum(r.weighbridge_weight_kg) : "–"}</td>
                <td>{fmtNum(r.accepted_qty)}</td>
                <td>{Number(r.short_qty) !== 0 ? fmtNum(r.short_qty) : "–"}</td>
                <td>{r.debit_note_amount != null ? fmtMoney(r.debit_note_amount) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportShell>
    </div>
  );
}

function DailyConsumptionReport() {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true); setError("");
    try { setData(await apiRequest(`/material-module/reports/daily-consumption?date=${date}`)); }
    catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} /></Field>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {!loading && data && (
        <>
          <div style={{ fontSize: 11.5, marginBottom: 10 }}>
            Operator-reported production: <strong>{data.operator_production_m3 != null ? `${fmtNum(data.operator_production_m3)} m³` : "not entered"}</strong>
            {" · "}Challan-derived volume (grade split source): <strong>{fmtNum(data.challan_production_m3)} m³</strong>
            <div style={{ color: "var(--slate)", fontSize: 10.5, marginTop: 2 }}>Two separate volume bases, shown side by side — never mixed (see the notes on cost/m³ below for why).</div>
          </div>
          <div className="card" style={{ overflowX: "auto", marginBottom: 10 }}>
            <table>
              <thead><tr><th>Material</th><th>Automatic (kg)</th><th>Manual (kg)</th></tr></thead>
              <tbody>
                {data.materials.map((m) => (
                  <tr key={m.material_id}><td>{m.name}</td><td>{m.automatic_qty_kg != null ? fmtNum(m.automatic_qty_kg) : "–"}</td><td>{m.manual_qty_kg != null ? fmtNum(m.manual_qty_kg) : "–"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.challan_by_grade.length > 0 && (
            <div className="card" style={{ overflowX: "auto" }}>
              <table>
                <thead><tr><th>Grade</th><th>Challan volume (m³)</th></tr></thead>
                <tbody>{data.challan_by_grade.map((g) => <tr key={g.grade}><td>{g.grade}</td><td>{fmtNum(g.m3)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Round 142 — the mockup's "Daily consumption — mix vs actual" report
// (project/Reports.dc.html), which round 139 left out entirely. Theoretical
// quantities come from each grade's approved mix design × that grade's m³ on
// the day's delivery challans (the only place the grade split is recorded);
// cost per m³ elsewhere uses the Plant Operator's own production figure
// instead, and both volumes are shown here so the two are never confused.
const MIX_TOLERANCE_PCT = 1;

function MixVsActualReport() {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true); setError("");
    try { setData(await apiRequest(`/material-module/reports/mix-vs-actual?date=${date}`)); }
    catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  const compared = data ? data.materials.filter((m) => m.diff_pct != null) : [];
  const withinTolerance = compared.filter((m) => Math.abs(m.diff_pct) <= MIX_TOLERANCE_PCT);
  const worst = compared.length
    ? compared.reduce((a, b) => (Math.abs(b.diff_pct) > Math.abs(a.diff_pct) ? b : a))
    : null;

  return (
    <div>
      <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} /></Field>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {loading && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading...</div>}
      {!loading && data && (
        <>
          <div style={kpiGridStyle}>
            <KpiCard
              label="Concrete produced"
              tone="dark"
              value={data.operator_production_m3 != null ? `${fmtNum(data.operator_production_m3)} m³` : "not entered"}
              sub={`plant operator · challans ${fmtNum(data.challan_production_m3)} m³`}
            />
            <KpiCard
              label="Grades poured"
              value={data.grades.length ? data.grades.map((g) => `${g.grade} ${fmtNum(g.m3)}`).join(" · ") : "none"}
              sub="m³ from delivery challans"
            />
            <KpiCard
              label={`Within ±${MIX_TOLERANCE_PCT}%`}
              value={compared.length ? `${withinTolerance.length} of ${compared.length}` : "–"}
              sub="materials comparable today"
            />
            <KpiCard
              label="Needs a look"
              tone={worst && Math.abs(worst.diff_pct) > MIX_TOLERANCE_PCT ? "warn" : undefined}
              value={worst && Math.abs(worst.diff_pct) > MIX_TOLERANCE_PCT ? worst.name : "nothing"}
              sub={worst && Math.abs(worst.diff_pct) > MIX_TOLERANCE_PCT ? `${worst.diff_pct > 0 ? "+" : ""}${fmtNum(worst.diff_pct, 2)}% against mix design` : "every comparable material is within tolerance"}
            />
          </div>

          {data.grades_missing_design.length > 0 && (
            <div className="card" style={{ background: "var(--amber-bg)", fontSize: 11.5, padding: 10, marginBottom: 10, lineHeight: 1.5 }}>
              No approved mix design for {data.grades_missing_design.join(", ")} — those grades contribute nothing to the mix design total below, so it is a partial figure for the day.
            </div>
          )}
          {data.unmapped_materials.length > 0 && (
            <div className="card" style={{ background: "var(--amber-bg)", fontSize: 11.5, padding: 10, marginBottom: 10, lineHeight: 1.5 }}>
              Not linked to a mix design ingredient: {data.unmapped_materials.join(", ")}. Set each one's mix component in the Materials master to bring it into this comparison.
            </div>
          )}

          <div className="card" style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Material</th>
                  {data.grades.map((g) => <th key={g.grade} style={{ textAlign: "right" }}>{g.grade} · {fmtNum(g.m3)} m³</th>)}
                  <th style={{ textAlign: "right" }}>Mix design total</th>
                  <th style={{ textAlign: "right" }}>Actual used</th>
                  <th style={{ textAlign: "right" }}>Difference</th>
                  <th style={{ textAlign: "right" }}>%</th>
                </tr>
              </thead>
              <tbody>
                {data.materials.map((m) => {
                  const over = m.diff_pct != null && Math.abs(m.diff_pct) > MIX_TOLERANCE_PCT;
                  const perM3 = m.per_grade.filter((g) => g.per_m3 != null).map((g) => fmtNum(g.per_m3, 2)).join(" / ");
                  return (
                    <tr key={m.material_id} style={over ? { background: "#FFFCF5" } : undefined}>
                      <td>
                        <b>{m.name}</b>
                        <div style={{ fontSize: 10.5, color: "var(--slate)" }}>{perM3 ? `${perM3} kg per m³` : "no mix design figure"}</div>
                      </td>
                      {data.grades.map((g) => {
                        const cell = m.per_grade.find((p) => p.grade === g.grade);
                        return <td key={g.grade} style={{ textAlign: "right" }}>{cell && cell.qty_kg != null ? fmtNum(cell.qty_kg, 0) : "–"}</td>;
                      })}
                      <td style={{ textAlign: "right" }}>{m.theoretical_kg != null ? <b>{fmtNum(m.theoretical_kg, 0)}</b> : "–"}</td>
                      <td style={{ textAlign: "right" }}>{m.actual_kg != null ? <b>{fmtNum(m.actual_kg, 0)}</b> : "–"}</td>
                      <td style={{ textAlign: "right", color: over ? "var(--alert-red)" : undefined, fontWeight: over ? 600 : 400 }}>
                        {m.diff_kg != null ? `${m.diff_kg > 0 ? "+" : ""}${fmtNum(m.diff_kg, 0)}` : "–"}
                      </td>
                      <td style={{ textAlign: "right", color: over ? "var(--alert-red)" : undefined, fontWeight: over ? 600 : 400 }}>
                        {m.diff_pct != null ? `${m.diff_pct > 0 ? "+" : ""}${fmtNum(m.diff_pct, 2)}%` : "–"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ fontSize: 10.5, color: "var(--slate)", lineHeight: 1.55, padding: "10px 2px 2px" }}>
              Mix design total = each grade's approved design quantity per m³ × m³ of that grade, taken from the delivery challans (the only
              place the grade split is recorded). Cost per m³ uses the plant operator's own production figure instead, which leaves out
              rejected or duplicated loads — {data.operator_production_m3 != null ? `${fmtNum(data.operator_production_m3)} m³` : "not entered"} against {fmtNum(data.challan_production_m3)} m³ on the challans.
              All figures in kg. Admixture is the total of the design's own admixture rows.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MonthlyConsumptionReport() {
  const [month, setMonth] = useState(thisMonthStr());
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true); setError("");
    try { setRows((await apiRequest(`/material-module/reports/monthly-consumption-summary?month=${month}`)).materials); }
    catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={inputStyle} /></Field>
      <ReportShell error={error} loading={loading} empty={!loading && rows.length === 0}>
        <table>
          <thead><tr><th>Material</th><th>Automatic total (kg)</th><th>Manual total (kg)</th><th>Consumed total (kg)</th></tr></thead>
          <tbody>{rows.map((m) => <tr key={m.material_id}><td>{m.name}</td><td>{fmtNum(m.automatic_total_kg)}</td><td>{fmtNum(m.manual_total_kg)}</td><td>{fmtNum(m.consumed_total_kg)}</td></tr>)}</tbody>
        </table>
      </ReportShell>
    </div>
  );
}

// Round 142 — rebuilt to the mockup (project/StockReport.dc.html): adds the
// average rate and cost-of-actual-consumption columns, a total row, and the
// four summary cards. Cost per m³ uses the Plant Operator's production for
// the month, never the challan total.
function MonthlyPhysicalStockReport() {
  const [month, setMonth] = useState(thisMonthStr());
  const [rows, setRows] = useState([]);
  const [productionM3, setProductionM3] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true); setError("");
    try {
      const data = await apiRequest(`/material-module/reports/monthly-physical-stock?month=${month}`);
      setRows(data.materials);
      setProductionM3(data.production_m3);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every total is summed only over rows that actually have the figure, so a
  // material nobody has counted yet lowers no total silently — the count of
  // counted materials is printed beside them.
  const valued = rows.filter((r) => r.rate_per_kg != null);
  const costPlant = valued.reduce((s, r) => s + Number(r.cost_plant_consumption || 0), 0);
  const costActualRows = valued.filter((r) => r.cost_actual_consumption != null);
  const costActual = costActualRows.reduce((s, r) => s + Number(r.cost_actual_consumption), 0);
  const costDiff = costActualRows.reduce((s, r) => s + Number(r.cost_of_diff || 0), 0);
  const biggest = rows
    .filter((r) => r.diff_kg != null)
    .reduce((a, b) => (a == null || Math.abs(b.diff_kg) > Math.abs(a.diff_kg) ? b : a), null);
  const perM3 = (total) => (productionM3 ? `${fmtMoney(total / productionM3)} per m³` : "no production recorded");

  return (
    <div>
      <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={inputStyle} /></Field>
      <ReportShell error={error} loading={loading} empty={!loading && rows.length === 0}>
        <table>
          <thead>
            <tr>
              <th>Raw material</th>
              <th style={{ textAlign: "right" }}>Opening stock</th>
              <th style={{ textAlign: "right" }}>Purchase</th>
              <th style={{ textAlign: "right" }}>Plant consumption</th>
              <th style={{ textAlign: "right" }}>Book stock</th>
              <th style={{ textAlign: "right" }}>Physical stock</th>
              <th style={{ textAlign: "right" }}>Actual consumption</th>
              <th style={{ textAlign: "right" }}>Diff (kg)</th>
              <th style={{ textAlign: "right" }}>Diff %</th>
              <th style={{ textAlign: "right" }}>Avg rate</th>
              <th style={{ textAlign: "right" }}>Cost — actual consumption</th>
              <th style={{ textAlign: "right" }}>Cost of difference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const neg = m.diff_kg != null && m.diff_kg < 0;
              const negStyle = { textAlign: "right", color: neg ? "var(--alert-red)" : undefined, fontWeight: neg ? 600 : 400 };
              return (
                <tr key={m.material_id}>
                  <td><b>{m.name}</b></td>
                  <td style={{ textAlign: "right" }}>{fmtMass(m.opening_kg)}</td>
                  <td style={{ textAlign: "right" }}>{fmtMass(m.purchase_kg)}</td>
                  <td style={{ textAlign: "right" }}>{fmtMass(m.plant_consumption_kg)}</td>
                  <td style={{ textAlign: "right" }}>{fmtMass(m.book_stock_kg)}</td>
                  <td style={{ textAlign: "right" }}>{m.physical_stock_kg != null ? fmtMass(m.physical_stock_kg) : "–"}</td>
                  <td style={{ textAlign: "right" }}>{m.actual_consumption_kg != null ? fmtMass(m.actual_consumption_kg) : "–"}</td>
                  <td style={negStyle}>{m.diff_kg != null ? fmtNum(m.diff_kg, 0) : "–"}</td>
                  <td style={negStyle}>{m.diff_pct != null ? `${fmtNum(m.diff_pct, 2)}%` : "–"}</td>
                  <td style={{ textAlign: "right" }}>{m.rate_per_kg != null ? `${fmtMoney(m.rate_per_kg)}/kg` : "–"}</td>
                  <td style={{ textAlign: "right" }}>{m.cost_actual_consumption != null ? fmtMoney(m.cost_actual_consumption) : "–"}</td>
                  <td style={negStyle}>{m.cost_of_diff != null ? fmtMoney(m.cost_of_diff) : "–"}</td>
                </tr>
              );
            })}
            {costActualRows.length > 0 && (
              <tr>
                <td colSpan={10} style={{ fontWeight: 700 }}>Total ({costActualRows.length} counted &amp; valued)</td>
                <td style={{ textAlign: "right", fontWeight: 700 }}>{fmtMoney(costActual)}</td>
                <td style={{ textAlign: "right", fontWeight: 700, color: costDiff < 0 ? "var(--alert-red)" : undefined }}>{fmtMoney(costDiff)}</td>
              </tr>
            )}
          </tbody>
        </table>

        <div style={{ ...kpiGridStyle, marginTop: 14, marginBottom: 8 }}>
          <KpiCard label="Cost as per plant consumption" value={fmtMoney(costPlant)} sub={perM3(costPlant)} />
          <KpiCard label="Cost as per actual consumption" value={costActualRows.length ? fmtMoney(costActual) : "–"} sub={costActualRows.length ? perM3(costActual) : "nothing counted yet"} />
          <KpiCard
            label="Cost of difference"
            tone={costDiff < 0 ? "danger" : undefined}
            value={costActualRows.length ? fmtMoney(costDiff) : "–"}
            sub={costActualRows.length && costPlant ? `${fmtNum(Math.abs((costDiff / costPlant) * 100), 2)}% of the month's material cost` : "–"}
          />
          <KpiCard
            label="Biggest gap"
            value={biggest ? biggest.name : "–"}
            sub={biggest ? `${fmtNum(biggest.diff_kg, 0)} kg${biggest.diff_pct != null ? ` · ${fmtNum(biggest.diff_pct, 2)}%` : ""}` : "nothing counted yet"}
          />
        </div>
        <div style={{ fontSize: 10.5, color: "var(--slate)", lineHeight: 1.6 }}>
          Actual consumption = opening + purchase − physical stock. Difference = plant consumption − actual consumption, so a minus means the
          plant actually used more than it reported (or material was lost). Values use each material's weighted average rate for the month.
          Cost per m³ divides by the plant operator's production for the month{productionM3 ? ` (${fmtNum(productionM3)} m³)` : ""}, not by the delivery challans.
        </div>
      </ReportShell>
    </div>
  );
}

function RateHistoryReport() {
  const [materials, setMaterials] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    apiRequest("/material-module/reports/weighted-average-rate-history").then(setMaterials).catch((err) => setError(err.message)).finally(() => setLoading(false));
  }, []);
  return (
    <div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {!loading && materials.length === 0 && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>No valuation history yet.</div>}
      {materials.map((m) => (
        <div key={m.material_id} className="card" style={{ marginBottom: 8, overflowX: "auto" }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{m.name}</div>
          <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 6 }}>Opening rate: {m.opening_stock_rate_per_kg != null ? fmtMoney(m.opening_stock_rate_per_kg) : "not set"} / kg</div>
          {m.months.length > 0 && (
            <table>
              <thead><tr><th>Month</th><th>Weighted avg rate (₹/kg)</th></tr></thead>
              <tbody>{m.months.map((mo) => <tr key={mo.month}><td>{mo.month}</td><td>{fmtMoney(mo.rate)}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

function SupplierSummaryReport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true); setError("");
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from_date", from);
      if (to) qs.set("to_date", to);
      setRows(await apiRequest(`/material-module/reports/supplier-purchase-summary?${qs}`));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <DateRangeBar from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <button type="button" onClick={run} style={{ fontSize: 12, padding: "6px 12px", marginBottom: 10 }}>Run</button>
      <ReportShell error={error} loading={loading} empty={!loading && rows.length === 0}>
        <table>
          <thead><tr><th>Supplier</th><th>Receipts</th><th>Total qty (kg)</th><th>Total value</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.supplier_id}><td>{r.supplier_name}</td><td>{r.receipt_count}</td><td>{fmtNum(r.total_qty_kg)}</td><td>{fmtMoney(r.total_value)}</td></tr>)}</tbody>
        </table>
      </ReportShell>
    </div>
  );
}

function TransporterFreightReport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true); setError("");
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from_date", from);
      if (to) qs.set("to_date", to);
      setRows(await apiRequest(`/material-module/reports/transporter-freight?${qs}`));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <DateRangeBar from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <button type="button" onClick={run} style={{ fontSize: 12, padding: "6px 12px", marginBottom: 10 }}>Run</button>
      <ReportShell error={error} loading={loading} empty={!loading && rows.length === 0}>
        <table>
          <thead><tr><th>Transporter</th><th>Trips</th><th>Total freight</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.transporter_id}><td>{r.transporter_name}</td><td>{r.trip_count}</td><td>{fmtMoney(r.total_freight)}</td></tr>)}</tbody>
        </table>
      </ReportShell>
    </div>
  );
}

function CostPerM3Report() {
  // Round 155 — was `d.setDate(1); d.toISOString().slice(0,10)`, which is the
  // UTC day of the 1st. Ironic in this file: lines 68-78 already carry a
  // comment saying "Deliberately NOT toISOString().slice(...)" and define a
  // correct helper, which CostPerM3Report then ignored. Now it uses the shared
  // one, which is that same reasoning in one place.
  const [from, setFrom] = useState(() => monthStartStr());
  const [to, setTo] = useState(todayStr());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true); setError(""); setData(null);
    try {
      setData(await apiRequest(`/material-module/reports/cost-per-m3?from_date=${from}&to_date=${to}`));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <DateRangeBar from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <button type="button" onClick={run} style={{ fontSize: 12, padding: "6px 12px", marginBottom: 10 }}>Run</button>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {loading && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading...</div>}
      {data && (
        <>
          <div className="card" style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11.5, color: "var(--slate)" }}>Total material cost</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{fmtMoney(data.total_material_cost)}</div>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 8 }}>
              Cost/m³ (operator's production basis): <strong>{data.cost_per_m3_operator_basis != null ? `${fmtMoney(data.cost_per_m3_operator_basis)}/m³` : "–"}</strong>
              {" "}on {fmtNum(data.operator_production_m3)} m³
            </div>
            <div style={{ fontSize: 10.5, color: "var(--slate)", marginTop: 6 }}>
              Grade split below uses the SEPARATE challan-derived volume ({fmtNum(data.challan_production_m3)} m³) — the only place grade-wise
              volume is recorded. The two m³ figures are deliberately kept apart, never mixed into one number.
            </div>
          </div>
          <div className="card" style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Grade</th><th>Challan volume (m³)</th><th>Allocated cost (proportional)</th></tr></thead>
              <tbody>
                {data.grade_split_challan_basis.map((g) => (
                  <tr key={g.grade}><td>{g.grade}</td><td>{fmtNum(g.challan_m3)}</td><td>{g.allocated_cost != null ? fmtMoney(g.allocated_cost) : "–"}</td></tr>
                ))}
              </tbody>
            </table>
            {data.grade_split_challan_basis.length === 0 && <div style={{ fontSize: 12.5, color: "var(--slate)", padding: 8 }}>No challan volume in this range.</div>}
          </div>
        </>
      )}
    </div>
  );
}

// ===================== Cost Dashboard tab (Administrator, item 8) =====================
// 5 KPI cards, a 6-month cost/m³ trend, a per-material cost/m³ breakdown, and
// a grouped material -> supplier weighted-rate table with short-supply% —
// matching the mockup's Dashboard.dc.html. Single-series chart, one hue
// (var(--rebar), the app's own accent) with direct value labels — no legend
// needed for one series (dataviz skill's form/color rules).

// Round 142 — tones extended past the original "dark" so the KPI row can
// carry the mockup's red/amber alert cards (below reorder level, cost of
// difference) instead of every tile looking the same.
const KPI_TONES = {
  dark: { background: "var(--charcoal)", color: "#fff", label: "#B8BFC7", sub: "#C9CDD2" },
  danger: { background: "#F8E9E7", color: "var(--alert-red)", label: "var(--alert-red)", sub: "var(--alert-red)", border: "1px solid #E9C6C1" },
  warn: { background: "#F5EDDD", color: "#8A5E0F", label: "#8A5E0F", sub: "#8A5E0F", border: "1px solid #E7D8AE" },
};

function KpiCard({ label, value, sub, tone }) {
  const t = KPI_TONES[tone] || {};
  return (
    <div className="card" style={{ padding: 12, background: t.background, color: t.color, border: t.border }}>
      <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: t.label || "var(--slate)", fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 700, marginTop: 3 }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: t.sub || "var(--slate)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function TrendChart({ trend }) {
  const values = trend.map((t) => t.cost_per_m3).filter((v) => v != null);
  const max = values.length ? Math.max(...values) : 0;
  const [hover, setHover] = useState(null);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 120, padding: "0 2px" }}>
        {trend.map((t, i) => {
          const h = max > 0 && t.cost_per_m3 != null ? Math.max(4, (t.cost_per_m3 / max) * 100) : 0;
          const label = new Date(`${t.month}-01T00:00:00Z`).toLocaleDateString([], { month: "short" });
          return (
            <div key={t.month} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%", position: "relative" }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h2) => (h2 === i ? null : h2))}>
              {hover === i && t.cost_per_m3 != null && (
                <div style={{ position: "absolute", bottom: h + 8, background: "var(--charcoal)", color: "#fff", fontSize: 10.5, padding: "3px 7px", borderRadius: 5, whiteSpace: "nowrap", zIndex: 1 }}>
                  {fmtMoney(t.cost_per_m3)}/m³
                </div>
              )}
              <div style={{ width: "100%", maxWidth: 28, height: `${h}%`, minHeight: t.cost_per_m3 != null ? 4 : 0, background: "var(--rebar)", borderRadius: "4px 4px 0 0", opacity: t.cost_per_m3 == null ? 0.15 : 1 }} />
              <div style={{ fontSize: 10, color: "var(--slate)", marginTop: 4 }}>{label}</div>
            </div>
          );
        })}
      </div>
      {values.length === 0 && <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 8 }}>No consumption/production data in the last 6 months yet.</div>}
    </div>
  );
}

function CostDashboardTab() {
  const [month, setMonth] = useState(thisMonthStr());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true); setError("");
    try { setData(await apiRequest(`/material-module/reports/cost-dashboard?month=${month}`)); }
    catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  const maxMaterialCost = data ? Math.max(1, ...data.per_material.map((m) => m.cost || 0)) : 1;

  return (
    <div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={inputStyle} /></Field>

      {loading && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading...</div>}
      {!loading && data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
            <KpiCard label="Cost / m³ this month" value={data.kpis.cost_per_m3 != null ? `${fmtMoney(data.kpis.cost_per_m3)}` : "–"} sub={`on ${fmtNum(data.kpis.month_m3)} m³ produced`} tone="dark" />
            <KpiCard label="Stock value" value={fmtMoney(data.kpis.stock_value)} sub="as of today" />
            <KpiCard label="This month's purchases" value={fmtMoney(data.kpis.month_purchase_value)} />
            <KpiCard label="Debit notes due" value={fmtMoney(data.kpis.debit_notes_due)} sub="this month" />
          </div>
          {data.kpis.over_tolerance_count > 0 && (
            <div className="card" style={{ marginBottom: 16, background: "var(--alert-red-bg)", padding: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--alert-red)" }}>{data.kpis.over_tolerance_count} receipt{data.kpis.over_tolerance_count === 1 ? "" : "s"} beyond tolerance this month</div>
              <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 2 }}>See Reports → Weighbridge comparison for details.</div>
            </div>
          )}

          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Cost / m³ — last 6 months</div>
            <TrendChart trend={data.trend} />
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Cost / m³ by material — this month</div>
            <div style={{ fontSize: 10.5, color: "var(--slate)", marginBottom: 10 }}>Divides by the operator's own production figure ({fmtNum(data.kpis.month_m3)} m³) — the grade split isn't tracked here, see Reports → Cost per m³ for the challan-basis grade breakdown.</div>
            {data.per_material.length === 0 && <div style={{ fontSize: 12, color: "var(--slate)" }}>No consumption entered this month yet.</div>}
            {data.per_material.map((m) => (
              <div key={m.material_id} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 3 }}>
                  <span>{m.name}</span>
                  <span style={{ fontWeight: 600 }}>{m.cost_per_m3 != null ? `${fmtMoney(m.cost_per_m3)}/m³` : "–"}</span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: "var(--surface-2, #F0EEE7)" }}>
                  <div style={{ height: 6, borderRadius: 3, background: "var(--rebar)", width: `${Math.max(2, ((m.cost || 0) / maxMaterialCost) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ overflowX: "auto" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Material → supplier weighted rate — this month</div>
            {data.grouped_supplier_table.length === 0 && <div style={{ fontSize: 12, color: "var(--slate)" }}>No receipts this month yet.</div>}
            {data.grouped_supplier_table.map((g) => (
              <div key={g.material_id} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: 700, padding: "4px 0", borderBottom: "1px solid var(--border, #DEDAD1)" }}>
                  <span>{g.name}</span>
                  <span>{fmtMoney(g.blended_rate_per_kg)}/kg blended · {fmtNum(g.total_qty_kg)} kg</span>
                </div>
                {g.suppliers.map((s) => (
                  <div key={s.supplier_id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, padding: "4px 0 4px 12px", color: "var(--slate)" }}>
                    <span>{s.name}{s.short_supply_pct != null && s.short_supply_pct > 0 && <span style={{ color: "var(--alert-red)" }}> · short {fmtNum(s.short_supply_pct, 1)}%</span>}</span>
                    <span>{fmtMoney(s.rate_per_kg)}/kg · {fmtNum(s.qty_kg)} kg</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
