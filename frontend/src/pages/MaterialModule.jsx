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
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.jsx";

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
  return `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function thisMonthStr() {
  return new Date().toISOString().slice(0, 7);
}

const SCOPE_LABEL = { delivered: "Delivered", ex_factory: "Ex-factory" };
const FREIGHT_BASIS_LABEL = { per_purchase_unit: "Per purchase unit", per_trip: "Per trip", per_kg: "Per kg" };
const ORDER_STATUS_LABEL = { pending_approval: "Pending approval", approved: "Approved", rejected: "Rejected" };
const ORDER_STATUS_COLOR = { pending_approval: "var(--amber)", approved: "var(--signal-green)", rejected: "var(--alert-red)" };

function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 }} onClick={onClose}>
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
const TABS_BY_ROLE = {
  administrator: [
    { key: "materials", label: "Materials" },
    { key: "suppliers", label: "Suppliers" },
    { key: "orders", label: "Orders" },
    { key: "receipts", label: "Receipts" },
    { key: "consumption", label: "Consumption" },
    { key: "stock", label: "Stock" },
    { key: "physical-stock", label: "Physical Stock" },
    { key: "reports", label: "Reports" },
  ],
  store: [
    { key: "orders", label: "Orders" },
    { key: "receipts", label: "Receipts" },
    { key: "stock", label: "Stock" },
    { key: "physical-stock", label: "Physical Stock" },
  ],
  plant_operator: [
    { key: "consumption", label: "Consumption" },
    { key: "stock", label: "Stock" },
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
      <div style={{ maxWidth: 620, margin: "0 auto", padding: "0 16px 32px" }}>
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
        {tab === "stock" && <StockTab role={user.role} />}
        {tab === "physical-stock" && <PhysicalStockTab role={user.role} />}
        {tab === "reports" && <ReportsTab />}
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

  async function load() {
    try {
      setMaterials(await apiRequest("/material-module/materials"));
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  function openNew() {
    setForm({ name: "", category: "", sub_category: "", purchase_unit: "", kg_per_purchase_unit: "", tolerance_pct: "", reorder_level_kg: "", opening_stock_kg: "0", opening_stock_rate_per_kg: "" });
    setEditing({});
    setError(""); setNotice("");
  }
  function openEdit(m) {
    setForm({
      name: m.name, category: m.category || "", sub_category: m.sub_category || "",
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
    setAddingRate(false); setAddingLink(false);
    loadSupplierDetail(s.id);
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
              <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 4 }}>Material rates</div>
              {rates.length === 0 && <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 6 }}>No rates on file yet.</div>}
              {rates.map((r) => (
                <div key={r.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, padding: "4px 0" }}>
                  <span>{r.material_name} · {SCOPE_LABEL[r.scope]}</span>
                  <span style={{ fontWeight: 600 }}>{fmtMoney(r.rate)} / {r.purchase_unit}</span>
                </div>
              ))}
              {!addingRate ? (
                <button type="button" style={{ fontSize: 10.5, padding: "3px 8px", marginTop: 4 }} onClick={() => { setAddingRate(true); setRateForm({ material_id: "", scope: "delivered", rate: "" }); }}>+ Add / update rate</button>
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
  const isAdmin = role === "administrator";
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
  return { supplier_qty: "", weighbridge_weight_kg: "", accepted_qty: "", vehicle_number: "", challan_number: "", debit_note_amount: "", notes: "" };
}

function ReceiptsTab() {
  const [receivable, setReceivable] = useState([]);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  const [saving, setSaving] = useState(false);

  const [receiving, setReceiving] = useState(null); // order being received against
  const [form, setForm] = useState(blankReceiptForm());

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

  async function submitReceipt(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice(""); setWarning("");
    try {
      const result = await apiRequest("/material-module/receipts", { method: "POST", body: { order_id: receiving.id, ...form } });
      setNotice(`Receipt recorded — landed rate ${fmtMoney(result.landed_rate_per_kg)}/kg.`);
      if (result.tolerance_exceeded) setWarning("Short/excess quantity is beyond this material's tolerance — worth a second look.");
      setReceiving(null);
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
        </div>
      ))}

      {receiving && (
        <Modal title={`Receive — ${receiving.material_name}`} onClose={() => setReceiving(null)} wide>
          <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 10 }}>
            Outstanding on this order: {fmtNum(outstandingQty)} {outstandingUnit}
          </div>
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
            <Field label="Notes (optional)"><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, fontFamily: "inherit" }} /></Field>
            <button type="submit" disabled={saving} style={{ width: "100%" }}>{saving ? "Saving..." : "Confirm receipt"}</button>
          </form>
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

function StockTab({ role }) {
  const showValuation = role !== "store";
  const [month, setMonth] = useState(thisMonthStr());
  const [materials, setMaterials] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true); setError("");
    try {
      const data = await apiRequest(`/material-module/stock?month=${month}`);
      setMaterials(data.materials);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      <Field label="Rate as of month (for valuation)"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={inputStyle} /></Field>

      {loading ? (
        <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading...</div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Material</th><th>Book stock</th><th>Days remaining</th>
                {showValuation && <th>Rate/kg</th>}
                {showValuation && <th>Value</th>}
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.material_id}>
                  <td>
                    {m.name}
                    {m.low_stock && <span className="badge badge-danger" style={{ marginLeft: 6, fontSize: 9.5, padding: "1px 6px" }}>Low</span>}
                  </td>
                  <td>{fmtNum(m.book_stock_kg)} kg <span style={{ color: "var(--slate)" }}>({fmtNum(m.book_stock_purchase_units)} {m.purchase_unit})</span></td>
                  <td>{m.stock_days_remaining != null ? fmtNum(m.stock_days_remaining, 1) : "–"}</td>
                  {showValuation && <td>{m.rate_per_kg != null ? fmtMoney(m.rate_per_kg) : "–"}</td>}
                  {showValuation && <td>{m.stock_value != null ? fmtMoney(m.stock_value) : "–"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {materials.length === 0 && <div style={{ fontSize: 12.5, color: "var(--slate)", padding: 8 }}>No active materials yet.</div>}
        </div>
      )}
    </div>
  );
}

// ===================== Physical stock tab (monthly count & reconciliation) =====================
// Columns match the confirmed layout: Opening | Purchase | Plant Consumption
// | Book Stock | Physical Stock | Actual Consumption | Diff kg & % | Cost of
// Actual Consumption | Cost of Difference (the last three, valuation-based,
// are Administrator-only, same as the Stock tab above).

function PhysicalStockTab({ role }) {
  const showValuation = role !== "store";
  const canEnter = role === "store" || role === "administrator";
  const [month, setMonth] = useState(thisMonthStr());
  const [materials, setMaterials] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [counting, setCounting] = useState(null);
  const [countQty, setCountQty] = useState("");
  const [countNotes, setCountNotes] = useState("");

  async function load() {
    setLoading(true); setError("");
    try {
      const data = await apiRequest(`/material-module/physical-stock?month=${month}`);
      setMaterials(data.materials);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  function openCount(m) {
    setCounting(m);
    setCountQty(m.physical_stock_kg ?? "");
    setCountNotes("");
    setError(""); setNotice("");
  }

  async function submitCount(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await apiRequest("/material-module/physical-stock", { method: "POST", body: { material_id: counting.material_id, stock_month: month, physical_stock_kg: countQty, notes: countNotes || null } });
      setNotice("Count saved.");
      setCounting(null);
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 10 }}>{notice}</div>}
      <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={inputStyle} /></Field>

      {loading ? (
        <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Loading...</div>
      ) : (
        materials.map((m) => (
          <div key={m.material_id} className="card" style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.name}</div>
              {canEnter && <button type="button" style={{ fontSize: 11, padding: "4px 9px" }} onClick={() => openCount(m)}>{m.physical_stock_kg != null ? "Update count" : "Enter count"}</button>}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 4 }}>
              Opening {fmtNum(m.opening_kg)} · Purchase {fmtNum(m.purchase_kg)} · Plant consumption {fmtNum(m.plant_consumption_kg)} · Book stock {fmtNum(m.book_stock_kg)} kg
            </div>
            {m.physical_stock_kg != null ? (
              <>
                <div style={{ fontSize: 11.5, marginTop: 2 }}>
                  Physical stock {fmtNum(m.physical_stock_kg)} kg · Actual consumption {fmtNum(m.actual_consumption_kg)} kg
                </div>
                <div style={{ fontSize: 11.5, marginTop: 2, color: Math.abs(m.diff_pct || 0) > 2 ? "var(--alert-red)" : "var(--slate)" }}>
                  Diff {fmtNum(m.diff_kg)} kg ({fmtNum(m.diff_pct, 1)}%) — {m.diff_kg < 0 ? "more actually used than plant reported" : "less actually used than plant reported"}
                </div>
                {showValuation && m.rate_per_kg != null && (
                  <div style={{ fontSize: 11.5, marginTop: 2 }}>
                    Cost of actual consumption {fmtMoney(m.cost_actual_consumption)} · Cost of difference {fmtMoney(m.cost_of_diff)}
                  </div>
                )}
                <div style={{ fontSize: 10.5, color: "var(--slate)", marginTop: 3 }}>Counted by {m.stock_taken_by_name || "–"} · {fmtDateTime(m.taken_at)}</div>
              </>
            ) : (
              <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 2 }}>Not counted yet this month.</div>
            )}
          </div>
        ))
      )}
      {!loading && materials.length === 0 && <div style={{ fontSize: 12.5, color: "var(--slate)" }}>No active materials yet.</div>}

      {counting && (
        <Modal title={`Physical count — ${counting.name}`} onClose={() => setCounting(null)}>
          <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 10 }}>Book stock: {fmtNum(counting.book_stock_kg)} kg</div>
          <form onSubmit={submitCount}>
            <Field label="Counted quantity (kg)"><input required type="number" step="0.01" min="0" value={countQty} onChange={(e) => setCountQty(e.target.value)} style={inputStyle} /></Field>
            <Field label="Notes (optional)"><textarea rows={2} value={countNotes} onChange={(e) => setCountNotes(e.target.value)} style={{ ...inputStyle, fontFamily: "inherit" }} /></Field>
            <button type="submit" disabled={saving} style={{ width: "100%" }}>{saving ? "Saving..." : "Save count"}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ===================== Reports tab (Administrator only) =====================

const REPORT_LIST = [
  { key: "open-orders", label: "Open orders" },
  { key: "weighbridge", label: "Weighbridge comparison" },
  { key: "daily-consumption", label: "Daily consumption" },
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

function MonthlyPhysicalStockReport() {
  const [month, setMonth] = useState(thisMonthStr());
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true); setError("");
    try { setRows((await apiRequest(`/material-module/reports/monthly-physical-stock?month=${month}`)).materials); }
    catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={inputStyle} /></Field>
      <ReportShell error={error} loading={loading} empty={!loading && rows.length === 0}>
        <table>
          <thead><tr><th>Material</th><th>Opening</th><th>Purchase</th><th>Plant cons.</th><th>Book stock</th><th>Physical</th><th>Actual cons.</th><th>Diff kg</th><th>Diff %</th><th>Cost of diff</th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.material_id}>
                <td>{m.name}</td><td>{fmtNum(m.opening_kg)}</td><td>{fmtNum(m.purchase_kg)}</td><td>{fmtNum(m.plant_consumption_kg)}</td>
                <td>{fmtNum(m.book_stock_kg)}</td><td>{m.physical_stock_kg != null ? fmtNum(m.physical_stock_kg) : "–"}</td>
                <td>{m.actual_consumption_kg != null ? fmtNum(m.actual_consumption_kg) : "–"}</td>
                <td>{m.diff_kg != null ? fmtNum(m.diff_kg) : "–"}</td><td>{m.diff_pct != null ? fmtNum(m.diff_pct, 1) : "–"}</td>
                <td>{m.cost_of_diff != null ? fmtMoney(m.cost_of_diff) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); });
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
