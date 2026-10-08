// Round 194 — Raw Material Tests (Quality Control).
//
// One page, five tabs, plus the test entry screen (?card=<id>):
//   To test            the Lab Technician's cards, grouped by the GRN that
//                      issued them (the same idea as cube-test cards)
//   Awaiting approval  submitted results; an Administrator approves or sends
//                      back. The approving Administrator's name prints as
//                      "Approved by" on the report.
//   Register           every approved report, filterable, PDF + Excel
//   Closed             cards closed without testing, with the reason
//   Test plans         per material: which tests, how often (Administrator)
//
// Calculations come from lib/rmTestDefs.js — the same file the server uses to
// recompute and store the result (check-rm-test-defs.mjs keeps them equal).
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { istDay, daysAgoStr } from "../lib/istDate.js";
import {
  TEST_DEFS, TEST_ORDER, computeTest, rowsFor, defaultParams, VERDICT_LABEL, TRIGGERS, PERIODS, periodLabel,
} from "../lib/rmTestDefs.js";
import { generateRmTestPdf } from "../lib/rmTestPdf.js";

const VERDICT_BADGE = { conforms: "badge-success", non_conforming: "badge-danger", recorded: "badge-neutral" };

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}
function fmtDateTime(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}
function dueText(card) {
  if (!card.due_at) return null;
  const ms = new Date(card.due_at).getTime() - Date.now();
  const h = Math.round(Math.abs(ms) / 3600000);
  const span = h >= 48 ? `${Math.round(h / 24)} days` : `${h} h`;
  return ms < 0 ? `Overdue ${span}` : `Due in ${span}`;
}
// "YYYY-MM-DDTHH:mm" in the browser's own clock, for <input type=datetime-local>.
function toLocalInput(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt)) return "";
  const p = (x) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

export default function RawMaterialTests() {
  const { can, ready } = usePermissions();
  const [params, setParams] = useSearchParams();
  const cardId = params.get("card");
  const canEnter = can("quality.rm-tests", "view");
  const canRegister = can("quality.rm-test-register", "view");
  const canApprove = can("quality.rm-test-approve", "edit");
  const canPlans = can("quality.rm-test-plans", "view");
  const defaultTab = canEnter ? "todo" : canApprove ? "approval" : canRegister ? "done" : "plans";
  const tab = params.get("tab") || defaultTab;
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function loadSummary() {
    apiRequest("/rm-tests/summary").then(setSummary).catch(() => {});
  }
  useEffect(() => { loadSummary(); }, [tab, cardId]);

  const go = (next) => {
    setError(""); setNotice("");
    setParams(next, { replace: false });
  };

  if (!ready) return null;

  if (cardId) {
    return (
      <>
        <TopBar title="Raw Material Tests" />
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 32px" }}>
          <CardView id={Number(cardId)} onBack={() => go({ tab })} onDone={(msg, nextTab) => { go({ tab: nextTab || tab }); setNotice(msg); }} />
        </div>
      </>
    );
  }

  const tabs = [
    canEnter && ["todo", "To test", summary?.todo],
    (canEnter || canApprove || canRegister) && ["approval", "Awaiting approval", summary?.approval],
    (canRegister || canEnter) && ["done", "Register"],
    canEnter && ["closed", "Closed"],
    canPlans && ["plans", "Test plans"],
  ].filter(Boolean);

  return (
    <>
      <TopBar title="Raw Material Tests" />
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 32px" }}>
        {summary && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 14 }}>
            <Kpi label="Tests to do" value={summary.todo} />
            <Kpi label="Overdue" value={summary.overdue} danger={summary.overdue > 0} />
            <Kpi label="Awaiting approval" value={summary.approval} />
            <Kpi label="Stock on hold" value={summary.on_hold} note="until the test is approved" />
            <Kpi label="Failed · last 30 days" value={summary.nonconforming_30d} danger={summary.nonconforming_30d > 0} />
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {tabs.map(([key, label, count]) => (
            <button key={key} type="button" className={`btn-tab ${tab === key ? "active" : ""}`} onClick={() => go({ tab: key })}>
              {label}{count ? ` · ${count}` : ""}
            </button>
          ))}
        </div>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 8 }}>{notice}</div>}

        {tab === "todo" && canEnter && <TodoTab setError={setError} open={(id) => go({ tab, card: String(id) })} canCreate={can("quality.rm-tests", "create")} />}
        {tab === "approval" && <ApprovalTab setError={setError} open={(id) => go({ tab, card: String(id) })} canApprove={canApprove} />}
        {tab === "done" && <RegisterTab setError={setError} open={(id) => go({ tab, card: String(id) })} />}
        {tab === "closed" && <ClosedTab setError={setError} />}
        {tab === "plans" && canPlans && <PlansTab setError={setError} setNotice={setNotice} />}
      </div>
    </>
  );
}

function Kpi({ label, value, danger, note }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${danger ? "danger" : ""}`}>{value ?? "—"}</div>
      {note && <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{note}</div>}
    </div>
  );
}

function StatusBadge({ card }) {
  if (card.status === "approved") return <span className={`badge ${VERDICT_BADGE[card.verdict] || "badge-neutral"}`}>{VERDICT_LABEL[card.verdict] || "Approved"}</span>;
  if (card.status === "submitted") return <span className="badge badge-info">Awaiting approval</span>;
  if (card.status === "closed") return <span className="badge badge-neutral">Closed</span>;
  if (card.sent_back_reason && card.status === "in_progress") return <span className="badge badge-warning">Sent back</span>;
  if (card.overdue) return <span className="badge badge-danger">{dueText(card)}</span>;
  if (card.status === "in_progress") return <span className="badge badge-progress">In progress</span>;
  return <span className="badge badge-warning">{dueText(card) || "To do"}</span>;
}

// ---------------------------------------------------------------------------
// To test — grouped by GRN
// ---------------------------------------------------------------------------
function TodoTab({ setError, open, canCreate }) {
  const [cards, setCards] = useState(null);
  const [adding, setAdding] = useState(false);
  function load() {
    apiRequest("/rm-tests/cards?bucket=todo").then(setCards).catch((e) => setError(e.message));
  }
  useEffect(() => { load(); }, []);

  const { groups, other } = useMemo(() => {
    const byGrn = new Map();
    const rest = [];
    for (const c of cards || []) {
      if (c.receipt_id) {
        if (!byGrn.has(c.receipt_id)) byGrn.set(c.receipt_id, []);
        byGrn.get(c.receipt_id).push(c);
      } else rest.push(c);
    }
    const g = [...byGrn.values()].sort((a, b) => {
      const oa = a.some((c) => c.overdue) ? 0 : 1, ob = b.some((c) => c.overdue) ? 0 : 1;
      return oa - ob || new Date(a[0].due_at) - new Date(b[0].due_at);
    });
    return { groups: g, other: rest };
  }, [cards]);

  if (!cards) return <div className="card">Loading…</div>;
  return (
    <>
      {canCreate && (
        <div style={{ marginBottom: 12 }}>
          {!adding
            ? <button type="button" onClick={() => setAdding(true)}>+ Add a test by hand</button>
            : <AddTestForm onCancel={() => setAdding(false)} onCreated={(card) => { setAdding(false); open(card.id); }} setError={setError} />}
        </div>
      )}
      {!groups.length && !other.length && (
        <div className="card" style={{ color: "var(--slate)" }}>Nothing to test. New cards appear here when Store books a material in.</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))", gap: 12 }}>
        {groups.map((g) => <GrnCard key={g[0].receipt_id} cards={g} open={open} />)}
      </div>
      {other.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Scheduled and added by hand</div>
          <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 8 }}>Not tied to a purchase: stock-pile moisture, periodic tests, and tests added by hand.</div>
          <div className="card" style={{ padding: 0 }}>
            {other.map((c) => <TestRow key={c.id} card={c} open={open} showMaterial />)}
          </div>
        </div>
      )}
    </>
  );
}

function GrnCard({ cards, open }) {
  const c0 = cards[0];
  const overdue = cards.some((c) => c.overdue);
  const hold = cards.some((c) => c.hold_stock);
  return (
    <div className="card" style={{ padding: 14, borderTop: `4px solid ${overdue ? "var(--alert-red)" : "var(--amber)"}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{c0.material_name}</div>
          <div style={{ fontSize: 13, color: "var(--slate)" }}>{c0.supplier_name || "—"}</div>
        </div>
        {hold && <span className="badge badge-danger" title="This plan asks for the stock to be held until the test is approved">Hold stock</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6, fontSize: 12.5, margin: "10px 0" }}>
        <div><div style={{ color: "var(--slate)" }}>GRN</div><div style={{ fontWeight: 500 }}>R-{String(c0.receipt_id).padStart(5, "0")}</div></div>
        <div><div style={{ color: "var(--slate)" }}>Truck</div><div style={{ fontWeight: 500 }}>{c0.vehicle_number || "—"}</div></div>
        <div><div style={{ color: "var(--slate)" }}>Received</div><div style={{ fontWeight: 500 }}>{fmtDate(c0.received_date)}</div></div>
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
        {cards.map((c) => <TestRow key={c.id} card={c} open={open} />)}
      </div>
    </div>
  );
}

function TestRow({ card, open, showMaterial }) {
  const action = card.status === "submitted" ? "Review" : card.status === "in_progress" ? "Continue" : card.test_code === "external" ? "Record result" : "Start test";
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{card.test_label}</div>
        <div style={{ fontSize: 12, color: "var(--slate)" }}>
          {showMaterial ? `${card.material_name}${card.supplier_name ? " · " + card.supplier_name : ""} · ` : ""}{card.reason}
        </div>
        {card.sent_back_reason && card.status === "in_progress" && (
          <div style={{ fontSize: 12, color: "var(--amber)", marginTop: 2 }}>Sent back: {card.sent_back_reason}</div>
        )}
        <div style={{ marginTop: 4 }}><StatusBadge card={card} /></div>
      </div>
      <button type="button" className={card.status === "pending" ? "btn-primary" : ""} style={{ flex: "none" }} onClick={() => open(card.id)}>{action}</button>
    </div>
  );
}

function AddTestForm({ onCancel, onCreated, setError }) {
  const [meta, setMeta] = useState(null);
  const [f, setF] = useState({ material_id: "", supplier_id: "", test_code: "", name: "", reason: "" });
  useEffect(() => { apiRequest("/rm-tests/meta").then(setMeta).catch((e) => setError(e.message)); }, []);
  async function create() {
    try {
      const card = await apiRequest("/rm-tests/cards", { method: "POST", body: { ...f, supplier_id: f.supplier_id || null } });
      onCreated(card);
    } catch (e) { setError(e.message); }
  }
  if (!meta) return <div className="card">Loading…</div>;
  return (
    <div className="card field-input" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, alignItems: "end" }}>
      <label>Material
        <select value={f.material_id} onChange={(e) => setF({ ...f, material_id: e.target.value })}>
          <option value="">Choose…</option>
          {meta.materials.filter((m) => m.is_active).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      <label>Supplier (optional)
        <select value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}>
          <option value="">— Stock pile / none —</option>
          {meta.suppliers.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label>Test
        <select value={f.test_code} onChange={(e) => setF({ ...f, test_code: e.target.value })}>
          <option value="">Choose…</option>
          {TEST_ORDER.map((c) => <option key={c} value={c}>{TEST_DEFS[c].label}</option>)}
        </select>
      </label>
      {f.test_code === "external" && (
        <label>External test name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Los Angeles abrasion value" />
        </label>
      )}
      <label>Why (optional)
        <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Supplier changed quarry" />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn-primary" disabled={!f.material_id || !f.test_code} onClick={create}>Create card</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Awaiting approval
// ---------------------------------------------------------------------------
function ApprovalTab({ setError, open, canApprove }) {
  const [cards, setCards] = useState(null);
  useEffect(() => { apiRequest("/rm-tests/cards?bucket=approval").then(setCards).catch((e) => setError(e.message)); }, []);
  if (!cards) return <div className="card">Loading…</div>;
  if (!cards.length) return <div className="card" style={{ color: "var(--slate)" }}>Nothing waiting for approval.</div>;
  return (
    <div className="card" style={{ padding: 0 }}>
      {!canApprove && <div style={{ padding: "10px 14px", fontSize: 12.5, color: "var(--slate)", borderBottom: "1px solid var(--border)" }}>An Administrator approves these. You can open them to read.</div>}
      {cards.map((c) => (
        <div key={c.id} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{c.test_label} · <span style={{ fontWeight: 500 }}>{c.summary}</span></div>
            <div style={{ fontSize: 12.5, color: "var(--slate)" }}>
              {c.material_name}{c.supplier_name ? " · " + c.supplier_name : ""}{c.vehicle_number ? " · " + c.vehicle_number : ""} · submitted by {c.submitted_by_name} {fmtDateTime(c.submitted_at)}
            </div>
            <div style={{ marginTop: 4 }}><span className={`badge ${VERDICT_BADGE[c.verdict]}`}>{VERDICT_LABEL[c.verdict]}</span></div>
          </div>
          <button type="button" className={canApprove ? "btn-primary" : ""} onClick={() => open(c.id)}>{canApprove ? "Review & approve" : "Open"}</button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------
function RegisterTab({ setError, open }) {
  const [meta, setMeta] = useState(null);
  const [f, setF] = useState({ from: daysAgoStr(90), to: istDay(), material_id: "", supplier_id: "", test_code: "", verdict: "" });
  const [rows, setRows] = useState(null);
  useEffect(() => { apiRequest("/rm-tests/meta").then(setMeta).catch(() => {}); }, []);
  useEffect(() => {
    const q = new URLSearchParams({ bucket: "done", ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) });
    apiRequest(`/rm-tests/cards?${q}`).then(setRows).catch((e) => setError(e.message));
  }, [f]);

  async function pdf(row) {
    try { await generateRmTestPdf(await apiRequest(`/rm-tests/cards/${row.id}`)); } catch (e) { setError(e.message); }
  }
  async function exportExcel() {
    if (!rows || !rows.length) { setError("Nothing to export for these filters."); return; }
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.json_to_sheet(rows.map((r) => ({
      "Report no.": r.report_no, "Tested": r.tested_on, Material: r.material_name, Supplier: r.supplier_name || "",
      Truck: r.vehicle_number || "", GRN: r.receipt_id ? `R-${String(r.receipt_id).padStart(5, "0")}` : "",
      Test: r.test_label, Result: r.summary, Verdict: VERDICT_LABEL[r.verdict] || "", "Tested by": r.submitted_by_name || "",
      "Approved by": r.approved_by_name || "", "Approved on": fmtDateTime(r.approved_at),
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Raw Material Tests");
    XLSX.writeFile(wb, `Raw_Material_Tests_${f.from || "all"}_to_${f.to || "all"}.xlsx`);
  }

  return (
    <>
      <div className="card field-input" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12, alignItems: "end" }}>
        <label>From<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label>To<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <label>Material
          <select value={f.material_id} onChange={(e) => setF({ ...f, material_id: e.target.value })}>
            <option value="">All</option>
            {(meta?.materials || []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label>Supplier
          <select value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}>
            <option value="">All</option>
            {(meta?.suppliers || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>Test
          <select value={f.test_code} onChange={(e) => setF({ ...f, test_code: e.target.value })}>
            <option value="">All</option>
            {TEST_ORDER.map((c) => <option key={c} value={c}>{TEST_DEFS[c].short}</option>)}
          </select>
        </label>
        <label>Result
          <select value={f.verdict} onChange={(e) => setF({ ...f, verdict: e.target.value })}>
            <option value="">All</option>
            {Object.entries(VERDICT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <button type="button" onClick={exportExcel}>Export to Excel</button>
      </div>
      {!rows ? <div className="card">Loading…</div> : !rows.length ? (
        <div className="card" style={{ color: "var(--slate)" }}>No approved reports for these filters.</div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ minWidth: 900 }}>
            <thead><tr><th>Report</th><th>Tested</th><th>Material</th><th>Supplier · truck</th><th>Test</th><th>Result</th><th></th><th>Approved by</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: "nowrap" }}><button type="button" style={{ padding: "4px 8px" }} onClick={() => open(r.id)}>{r.report_no}</button></td>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDate(r.tested_on)}</td>
                  <td>{r.material_name}</td>
                  <td>{r.supplier_name || "—"}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{r.vehicle_number || ""}</div></td>
                  <td>{r.test_label}</td>
                  <td>{r.summary}</td>
                  <td><span className={`badge ${VERDICT_BADGE[r.verdict]}`}>{VERDICT_LABEL[r.verdict]}</span></td>
                  <td>{r.approved_by_name}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{fmtDateTime(r.approved_at)}</div></td>
                  <td><button type="button" style={{ padding: "4px 10px" }} onClick={() => pdf(r)}>PDF</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ClosedTab({ setError }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { apiRequest("/rm-tests/cards?bucket=closed").then(setRows).catch((e) => setError(e.message)); }, []);
  if (!rows) return <div className="card">Loading…</div>;
  if (!rows.length) return <div className="card" style={{ color: "var(--slate)" }}>No cards have been closed without testing.</div>;
  return (
    <div className="card" style={{ padding: 0, overflowX: "auto" }}>
      <table style={{ minWidth: 700 }}>
        <thead><tr><th>Closed</th><th>Material · supplier</th><th>Test</th><th>Reason</th><th>By</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(r.closed_at)}</td>
              <td>{r.material_name}{r.supplier_name ? " · " + r.supplier_name : ""}</td>
              <td>{r.test_label}</td>
              <td>{r.closed_reason}</td>
              <td>{r.closed_by_name}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The test card itself: entry, review, approval
// ---------------------------------------------------------------------------
function CardView({ id, onBack, onDone }) {
  const { can } = usePermissions();
  const [card, setCard] = useState(null);
  const [readings, setReadings] = useState({ head: {}, grid: {} });
  const [meta, setMeta] = useState({ sampled_by: "", sampled_at: "", tested_on: "", equipment: "", remarks: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [backReason, setBackReason] = useState("");

  function absorb(c) {
    setCard(c);
    setReadings({ head: { ...((c.readings && c.readings.head) || {}) }, grid: JSON.parse(JSON.stringify((c.readings && c.readings.grid) || {})) });
    setMeta({
      sampled_by: c.sampled_by || "", sampled_at: toLocalInput(c.sampled_at), tested_on: c.tested_on || istDay(),
      equipment: c.equipment || "", remarks: c.remarks || "",
    });
    setDirty(false);
  }
  useEffect(() => { apiRequest(`/rm-tests/cards/${id}`).then(absorb).catch((e) => setError(e.message)); }, [id]);

  const def = card && TEST_DEFS[card.test_code];
  const editable = card && ["pending", "in_progress"].includes(card.status) && can("quality.rm-tests", "edit");
  const live = useMemo(() => (card ? computeTest(card.test_code, readings, card.params) : null), [card, readings]);
  const shown = editable ? live : (card && card.result) || live;

  if (error && !card) return <div className="card" style={{ color: "var(--alert-red)" }}>{error} <button type="button" onClick={onBack}>Back</button></div>;
  if (!card) return <div className="card">Loading…</div>;

  const rows = rowsFor(card.test_code, card.params);
  const setGrid = (rk, fk, v) => {
    setReadings((r) => ({ ...r, grid: { ...r.grid, [rk]: { ...(r.grid[rk] || {}), [fk]: v } } }));
    setDirty(true);
  };
  const setHead = (k, v) => { setReadings((r) => ({ ...r, head: { ...r.head, [k]: v } })); setDirty(true); };
  const body = () => ({
    readings,
    sampled_by: meta.sampled_by, equipment: meta.equipment, remarks: meta.remarks, tested_on: meta.tested_on || null,
    sampled_at: meta.sampled_at ? new Date(meta.sampled_at).toISOString() : null,
  });
  async function act(path, payload, after) {
    setBusy(true); setError("");
    try {
      const c = await apiRequest(`/rm-tests/cards/${id}${path}`, { method: path ? "POST" : "PUT", body: payload });
      absorb(c);
      if (after) after(c);
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  }
  const save = () => act("", body());
  const submit = () => act("/submit", body(), () => onDone("Submitted — waiting for an Administrator to approve.", "todo"));
  const approve = () => act("/approve", {}, (c) => onDone(`Approved and filed as ${c.report_no}. ${c.verdict === "non_conforming" ? "Store and the plant manager have been told it does not conform." : ""}`, "approval"));
  const sendBack = () => act("/send-back", { reason: backReason }, () => onDone("Sent back to the Lab Technician.", "approval"));
  const withdraw = () => {
    const reason = window.prompt("Why is the approval being withdrawn?");
    if (reason) act("/withdraw-approval", { reason });
  };
  const close = () => {
    const reason = window.prompt("Why is this test not being done?");
    if (reason) act("/close", { reason }, () => onDone("Card closed.", "todo"));
  };

  const canApprove = can("quality.rm-test-approve", "edit");
  const inputStyle = { width: "100%", minWidth: 70, padding: "7px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, fontSize: 14, textAlign: "right", background: "#FFFDF6" };
  const ro = (v) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{v === null || v === undefined || v === "" ? "—" : v}</span>;
  const computed = (rk, f) => {
    const c = shown && shown.cells && shown.cells[rk];
    const v = c ? c[f.key] : null;
    if (f.key === "chk" && v) return <span className={`badge ${v === "Within" ? "badge-success" : v === "Outside" ? "badge-danger" : "badge-neutral"}`}>{v}</span>;
    if (typeof v === "number" && f.dp !== undefined) return ro(v.toFixed(f.dp));
    return ro(v);
  };
  const inputCell = (rk, f) => {
    const v = (readings.grid[rk] && readings.grid[rk][f.key]) ?? "";
    if (!editable) return ro(v);
    return (
      <input aria-label={`${f.label} — ${rk}`} type={f.type === "text" ? "text" : "number"} inputMode={f.type === "text" ? "text" : "decimal"}
        step="any" value={v} onChange={(e) => setGrid(rk, f.key, e.target.value)} style={{ ...inputStyle, textAlign: f.type === "text" ? "left" : "right" }} />
    );
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <button type="button" onClick={onBack} style={{ marginBottom: 8 }}>← Back</button>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{card.test_label}</div>
          <div style={{ fontSize: 12.5, color: "var(--slate)" }}>
            {def.method} · limits {def.spec}{card.form_no ? ` · form ${card.form_no}` : ""} · {card.report_no}
          </div>
        </div>
        <StatusBadge card={card} />
      </div>
      {card.sent_back_reason && card.status === "in_progress" && (
        <div className="card" style={{ background: "var(--amber-bg)", borderColor: "#E8C890", marginBottom: 12, fontSize: 13.5 }}>
          <b>Sent back by {card.sent_back_by_name}:</b> {card.sent_back_reason}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <div style={{ flex: "999 1 600px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          {(def.head || []).length > 0 && (
            <div className="card field-input" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
              {def.head.map((f) => (
                <label key={f.key} style={{ fontSize: 12.5, color: "var(--slate)" }}>{f.label}{f.unit ? ` (${f.unit})` : ""}
                  {!editable ? <div style={{ fontSize: 15, color: "var(--charcoal)", fontWeight: 600, marginTop: 4 }}>{f.type === "select" ? ((f.options.find(([o]) => o === readings.head[f.key]) || [])[1] || "—") : readings.head[f.key] || "—"}</div>
                    : f.type === "select" ? (
                      <select value={readings.head[f.key] || ""} onChange={(e) => setHead(f.key, e.target.value)}>
                        <option value="">Choose…</option>
                        {f.options.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
                      </select>
                    ) : (
                      <input type={f.type === "date" ? "date" : f.type === "text" ? "text" : "number"} step="any" placeholder={f.placeholder || ""}
                        value={readings.head[f.key] || ""} onChange={(e) => setHead(f.key, e.target.value)} />
                    )}
                </label>
              ))}
            </div>
          )}

          {def.layout === "rows" && (
            <div className="card" style={{ padding: 0, overflowX: "auto" }}>
              <table style={{ minWidth: 640 }}>
                <thead><tr><th>{def.code.startsWith("sieve") ? "IS sieve" : def.code === "cement_strength" ? "Age" : def.code === "moisture" ? "Reading" : "Fraction"}</th>
                  {def.fields.map((f) => <th key={f.key} style={{ textAlign: f.input ? "left" : "right" }}>{f.label}{f.unit ? ` (${f.unit})` : ""}</th>)}</tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{r.label}</td>
                      {def.fields.map((f) => <td key={f.key} style={{ textAlign: "right" }}>{f.input ? inputCell(r.key, f) : computed(r.key, f)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {def.layout === "trials" && (
            <div className="card" style={{ padding: 0, overflowX: "auto" }}>
              <table style={{ minWidth: 420 }}>
                <thead><tr><th>Description</th>{rows.map((r) => <th key={r.key} style={{ textAlign: "right" }}>{r.label}</th>)}</tr></thead>
                <tbody>
                  {def.fields.map((f) => (
                    <tr key={f.key}>
                      <td style={{ fontSize: 13 }}>{f.label}{f.unit ? ` (${f.unit})` : ""}</td>
                      {rows.map((r) => <td key={r.key} style={{ textAlign: "right", minWidth: 96 }}>{f.input ? inputCell(r.key, f) : computed(r.key, f)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card field-input" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
            {[
              ["sampled_by", "Sampled by", "text"], ["sampled_at", "Sampled on", "datetime-local"], ["tested_on", "Date of testing", "date"],
              ["equipment", "Equipment used (ID, calibration)", "text"],
            ].map(([k, l, t]) => (
              <label key={k} style={{ fontSize: 12.5, color: "var(--slate)" }}>{l}
                {editable ? <input type={t} value={meta[k]} onChange={(e) => { setMeta({ ...meta, [k]: e.target.value }); setDirty(true); }} />
                  : <div style={{ fontSize: 14, color: "var(--charcoal)", marginTop: 4 }}>{k === "sampled_at" ? fmtDateTime(card.sampled_at) : k === "tested_on" ? fmtDate(card.tested_on) : card[k] || "—"}</div>}
              </label>
            ))}
            <label style={{ fontSize: 12.5, color: "var(--slate)", gridColumn: "1 / -1" }}>Remarks
              {editable ? <textarea rows={2} value={meta.remarks} onChange={(e) => { setMeta({ ...meta, remarks: e.target.value }); setDirty(true); }} />
                : <div style={{ fontSize: 14, color: "var(--charcoal)", marginTop: 4, whiteSpace: "pre-line" }}>{card.remarks || "—"}</div>}
            </label>
          </div>
        </div>

        <div style={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <ResultPanel result={shown} />
          <div className="card" style={{ fontSize: 13 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{card.receipt_id ? "From the GRN" : "Card"}</div>
            {[
              ["Material", card.material_name], ["Supplier", card.supplier_name || "—"], ["Truck", card.vehicle_number || "—"],
              ["GRN", card.receipt_id ? `R-${String(card.receipt_id).padStart(5, "0")}${card.challan_number ? " · DC " + card.challan_number : ""}` : "—"],
              ["Received", fmtDate(card.received_date)], ["Why this card", card.reason], ["Due", fmtDateTime(card.due_at)],
              card.submitted_by_name && ["Tested by", `${card.submitted_by_name} · ${fmtDateTime(card.submitted_at)}`],
              card.approved_by_name && ["Approved by", `${card.approved_by_name} (Administrator) · ${fmtDateTime(card.approved_at)}`],
            ].filter(Boolean).map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "5px 0", borderBottom: "1px solid #F1EEE7" }}>
                <span style={{ color: "var(--slate)" }}>{k}</span><span style={{ textAlign: "right", fontWeight: 500 }}>{v}</span>
              </div>
            ))}
            {card.hold_stock && card.status !== "approved" && <div style={{ marginTop: 8 }}><span className="badge badge-danger">Hold this stock until approved</span></div>}
          </div>
          {card.history && card.history.length > 0 && (
            <div className="card" style={{ fontSize: 13 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Last results · same test and supplier</div>
              {card.history.map((h) => (
                <div key={h.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0" }}>
                  <span>{fmtDate(h.tested_on)}</span><span style={{ textAlign: "right" }}>{h.summary} <span className={`badge ${VERDICT_BADGE[h.verdict]}`} style={{ marginLeft: 4 }}>{VERDICT_LABEL[h.verdict]}</span></span>
                </div>
              ))}
            </div>
          )}

          {error && <div style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
          {editable && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button type="button" className="btn-primary" disabled={busy || (live && live.errors.length > 0)} onClick={submit} style={{ minHeight: 46 }}>Submit for approval</button>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={busy || !dirty} onClick={save} style={{ flex: 1 }}>{dirty ? "Save draft" : "Saved"}</button>
                <button type="button" disabled={busy} onClick={() => generateRmTestPdf({ ...card, readings, result: live, verdict: live.verdict, summary: live.summary, status: card.status })} style={{ flex: 1 }}>Preview PDF</button>
              </div>
              <button type="button" disabled={busy} onClick={close} style={{ color: "var(--slate)" }}>Close — not testing</button>
            </div>
          )}
          {card.status === "submitted" && canApprove && (
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 13, color: "var(--slate)" }}>Approving prints <b>your name</b> as “Approved by” on the report and files it.</div>
              <button type="button" className="btn-primary" disabled={busy} onClick={approve} style={{ minHeight: 46, background: "var(--signal-green)", borderColor: "var(--signal-green)" }}>Approve</button>
              <div className="field-input"><input placeholder="What needs correcting?" value={backReason} onChange={(e) => setBackReason(e.target.value)} /></div>
              <button type="button" disabled={busy || !backReason.trim()} onClick={sendBack}>Send back to the Lab Technician</button>
            </div>
          )}
          {!editable && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => generateRmTestPdf(card)} style={{ flex: 1 }}>{card.status === "approved" ? "Print report (PDF)" : "Preview PDF"}</button>
              {card.status === "approved" && canApprove && <button type="button" disabled={busy} onClick={withdraw} style={{ color: "var(--alert-red)" }}>Withdraw approval</button>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ResultPanel({ result }) {
  if (!result) return null;
  const v = result.verdict;
  const tone = v === "conforms" ? ["var(--signal-green-bg)", "var(--signal-green)"] : v === "non_conforming" ? ["var(--alert-red-bg)", "var(--alert-red)"] : v === "recorded" ? ["#ECEAE4", "var(--slate)"] : ["var(--amber-bg)", "var(--amber)"];
  return (
    <div className="card" style={{ background: tone[0], borderColor: "transparent" }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase", color: tone[1] }}>Result</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: tone[1], margin: "2px 0 6px" }}>{v ? VERDICT_LABEL[v] : "Not complete yet"}</div>
      {(result.results || []).map((r) => (
        <div key={r.label} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, padding: "3px 0" }}>
          <span>{r.label}</span>
          <span style={{ fontWeight: 600, textAlign: "right", color: r.ok === false ? "var(--alert-red)" : "var(--charcoal)" }}>
            {r.text ? r.value : (r.value === null ? "—" : Number(r.value).toFixed(r.dp ?? 2))}{r.unit && !r.text ? " " + r.unit : ""}
            {r.limit && <span style={{ fontWeight: 400, color: "var(--slate)" }}> · {r.limit}</span>}
          </span>
        </div>
      ))}
      {(result.errors || []).map((e) => <div key={e} style={{ fontSize: 12.5, color: "var(--amber)", marginTop: 4 }}>• {e}</div>)}
      {(result.warnings || []).map((w) => <div key={w} style={{ fontSize: 12.5, color: "var(--alert-red)", marginTop: 4 }}>⚠ {w}</div>)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test plans (Administrator)
// ---------------------------------------------------------------------------
function PlansTab({ setError, setNotice }) {
  const { can } = usePermissions();
  const [meta, setMeta] = useState(null);
  const [materialId, setMaterialId] = useState(null);
  const [plans, setPlans] = useState(null);
  const [adding, setAdding] = useState({ test_code: "", name: "" });
  const canEdit = can("quality.rm-test-plans", "edit");
  const canCreate = can("quality.rm-test-plans", "create");
  const canDelete = can("quality.rm-test-plans", "delete");

  function loadMeta() {
    apiRequest("/rm-tests/meta").then((m) => {
      setMeta(m);
      if (!materialId && m.materials.length) setMaterialId(m.materials[0].id);
    }).catch((e) => setError(e.message));
  }
  function loadPlans() {
    if (materialId) apiRequest(`/rm-tests/plans?material_id=${materialId}`).then(setPlans).catch((e) => setError(e.message));
  }
  useEffect(() => { loadMeta(); }, []);
  useEffect(() => { setPlans(null); loadPlans(); }, [materialId]);

  async function patch(p, change) {
    try {
      await apiRequest(`/rm-tests/plans/${p.id}`, { method: "PATCH", body: change });
      loadPlans(); loadMeta();
    } catch (e) { setError(e.message); }
  }
  async function add() {
    try {
      const params = adding.test_code === "external" ? { name: adding.name } : undefined;
      await apiRequest("/rm-tests/plans", { method: "POST", body: { material_id: materialId, test_code: adding.test_code, params } });
      setAdding({ test_code: "", name: "" }); loadPlans(); loadMeta();
    } catch (e) { setError(e.message); }
  }
  async function remove(p) {
    if (!window.confirm(`Remove "${p.test_label}" from this material's plan? Results already filed are kept.`)) return;
    try { await apiRequest(`/rm-tests/plans/${p.id}`, { method: "DELETE" }); loadPlans(); loadMeta(); } catch (e) { setError(e.message); }
  }
  async function loadStandard() {
    try {
      const r = await apiRequest("/rm-tests/plans/load-standard", { method: "POST", body: { material_id: materialId } });
      setNotice(r.added ? `${r.added} standard test(s) added.` : "This material already has every standard test."); loadPlans(); loadMeta();
    } catch (e) { setError(e.message); }
  }

  if (!meta) return <div className="card">Loading…</div>;
  const mat = meta.materials.find((m) => m.id === materialId);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
      <div className="card" style={{ flex: "1 1 220px", padding: 6 }}>
        {meta.materials.map((m) => (
          <button key={m.id} type="button" onClick={() => setMaterialId(m.id)}
            style={{ display: "flex", justifyContent: "space-between", width: "100%", border: "none", textAlign: "left", marginBottom: 2,
              background: m.id === materialId ? "var(--concrete)" : "transparent", fontWeight: m.id === materialId ? 600 : 400, opacity: m.is_active ? 1 : 0.55 }}>
            <span>{m.name}</span><span style={{ fontSize: 12, color: "var(--slate)" }}>{m.active_tests} tests</span>
          </button>
        ))}
      </div>
      <div style={{ flex: "999 1 700px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{mat?.name}</div>
            <div style={{ fontSize: 12.5, color: "var(--slate)" }}>Every GRN of this material is checked against this plan. Frequencies are per supplier.</div>
          </div>
          {canCreate && mat?.standard_kind && <button type="button" onClick={loadStandard}>Add missing standard tests</button>}
        </div>
        {!plans ? <div className="card">Loading…</div> : (
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ minWidth: 980 }}>
              <thead><tr><th>Test</th><th>Settings</th><th>Card issued</th><th>High rate</th><th>Low rate</th><th>Low after</th><th>Due within</th><th>Hold stock</th><th>On</th><th></th></tr></thead>
              <tbody>
                {plans.map((p) => <PlanRow key={p.id} p={p} canEdit={canEdit} canDelete={canDelete} patch={patch} remove={remove} />)}
                {!plans.length && <tr><td colSpan={10} style={{ color: "var(--slate)" }}>No tests planned — GRNs of this material issue no cards.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {canCreate && (
          <div className="card field-input" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "end" }}>
            <label style={{ flex: "1 1 220px" }}>Add a test
              <select value={adding.test_code} onChange={(e) => setAdding({ ...adding, test_code: e.target.value })}>
                <option value="">Choose…</option>
                {TEST_ORDER.map((c) => <option key={c} value={c}>{TEST_DEFS[c].label}</option>)}
              </select>
            </label>
            {adding.test_code === "external" && (
              <label style={{ flex: "1 1 220px" }}>External test name<input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></label>
            )}
            <button type="button" className="btn-primary" disabled={!adding.test_code} onClick={add}>Add</button>
          </div>
        )}
        <div style={{ fontSize: 12.5, color: "var(--slate)", lineHeight: 1.5 }}>
          <b>First GRN per supplier in the period</b> gives one card per supplier per period — ten lorries a week make one weekly card.
          A supplier with no result on record gets its card on its first load. <b>Low rate</b> (IS 4926 B-1.1): after the set number of approved results
          in tolerance, the period switches to the low rate; one result outside the limit switches it straight back.
          Cards go to the Lab Technician; an <b>Administrator</b> approves, and their name prints as “Approved by”.
        </div>
      </div>
    </div>
  );
}

function PlanRow({ p, canEdit, canDelete, patch, remove }) {
  const def = TEST_DEFS[p.test_code];
  const sel = (value, options, onChange, disabled) => (
    <select value={value ?? ""} disabled={!canEdit || disabled} onChange={(e) => onChange(e.target.value)} style={{ padding: "5px 6px", fontSize: 12.5, borderRadius: 6, border: "1px solid var(--border-strong)", maxWidth: 170 }}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
  const periodOpts = [["", "—"], ...PERIODS.map(([d, l]) => [String(d), l])];
  const periodOptsFor = (v) => (v && !PERIODS.some(([d]) => String(d) === String(v)) ? [...periodOpts, [String(v), periodLabel(v)]] : periodOpts);
  const usesPeriod = p.trigger === "period" || p.trigger === "scheduled";
  return (
    <tr style={{ opacity: p.is_active ? 1 : 0.5 }}>
      <td style={{ fontWeight: 600, minWidth: 190 }}>{p.test_label}<div style={{ fontSize: 11.5, color: "var(--slate)", fontWeight: 400 }}>{p.form_no || "no paper form"}</div></td>
      <td>
        {(def?.params || []).filter((x) => !x.free).map((x) => (
          <div key={x.key} style={{ marginBottom: 3 }}>{sel(p.params?.[x.key] ?? x.default, x.options, (v) => patch(p, { params: { [x.key]: v } }))}</div>
        ))}
        {(def?.params || []).filter((x) => x.free && x.key !== "name").map((x) => (
          <input key={x.key} defaultValue={p.params?.[x.key] || ""} disabled={!canEdit} placeholder={x.label}
            onBlur={(e) => e.target.value !== (p.params?.[x.key] || "") && patch(p, { params: { [x.key]: e.target.value } })}
            style={{ padding: "5px 6px", fontSize: 12.5, borderRadius: 6, border: "1px solid var(--border-strong)", maxWidth: 170 }} />
        ))}
      </td>
      <td>{sel(p.trigger, TRIGGERS, (v) => patch(p, { trigger: v, ...(v === "period" || v === "scheduled" ? { high_days: p.high_days || 30 } : {}) }))}</td>
      <td>{sel(p.high_days ? String(p.high_days) : "", periodOptsFor(p.high_days), (v) => patch(p, { high_days: v || null }), !usesPeriod)}</td>
      <td>{sel(p.low_days ? String(p.low_days) : "", periodOptsFor(p.low_days), (v) => patch(p, { low_days: v || null, low_after: v ? p.low_after || 4 : null }), p.trigger !== "period")}</td>
      <td>
        <input type="number" min="1" defaultValue={p.low_after || ""} disabled={!canEdit || !p.low_days} key={p.low_after}
          onBlur={(e) => Number(e.target.value || 0) !== Number(p.low_after || 0) && patch(p, { low_after: e.target.value || null })}
          style={{ width: 56, padding: "5px 6px", fontSize: 12.5, borderRadius: 6, border: "1px solid var(--border-strong)" }} />
        <div style={{ fontSize: 11, color: "var(--slate)" }}>results</div>
      </td>
      <td>
        <input type="number" min="1" defaultValue={p.due_hours} disabled={!canEdit} key={p.due_hours}
          onBlur={(e) => Number(e.target.value) !== Number(p.due_hours) && patch(p, { due_hours: e.target.value })}
          style={{ width: 60, padding: "5px 6px", fontSize: 12.5, borderRadius: 6, border: "1px solid var(--border-strong)" }} />
        <div style={{ fontSize: 11, color: "var(--slate)" }}>hours</div>
      </td>
      <td><input type="checkbox" checked={p.hold_stock} disabled={!canEdit} onChange={(e) => patch(p, { hold_stock: e.target.checked })} aria-label="Hold stock until approved" /></td>
      <td><input type="checkbox" checked={p.is_active} disabled={!canEdit} onChange={(e) => patch(p, { is_active: e.target.checked })} aria-label="Plan active" /></td>
      <td>{canDelete && <button type="button" style={{ padding: "4px 8px", color: "var(--alert-red)" }} onClick={() => remove(p)}>Remove</button>}</td>
    </tr>
  );
}
