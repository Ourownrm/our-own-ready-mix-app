// Lab Technician (round 118) — new role. Owns cube compressive-strength
// testing (downstream of QC Engineer's plant-side slump/temp/cube-casting,
// which is unchanged) and the mix design library both PDF reports are built
// from. Single-file, internal-view-state dashboard, matching the pattern
// used by every other role's own screen (QcEngineer.jsx, Accountant.jsx, etc).
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { generateMixDesignPdf } from "../lib/mixDesignPdf.js";
import { generateCubeTestPdf, generateCombinedPourCubeTestPdf } from "../lib/cubeTestPdf.js";
import { useAuth } from "../lib/AuthContext.jsx";
import { formatOrderNumber } from "../lib/orderNumber.js";

// IS 516 doesn't mandate a fixed vocabulary for failure mode, but these are
// the patterns a lab technician actually sees in practice — kept as
// suggestions (a free-text fallback is always available) rather than a hard
// enum, since this is an observational note, not a constrained data field.
const FAILURE_TYPES = ["Cone", "Cone & Split", "Columnar", "Shear", "Side Fracture", "Explosive"];

const CUBE_VOLUME_M3 = 0.003375; // 150mm cube
const CUBE_FACE_AREA_MM2 = 150 * 150;

function computeDensity(weightKg) {
  const w = Number(weightKg);
  if (!w) return "";
  return (w / CUBE_VOLUME_M3).toFixed(1);
}
function computeStrength(loadKn) {
  const l = Number(loadKn);
  if (!l) return "";
  return ((l * 1000) / CUBE_FACE_AREA_MM2).toFixed(1);
}
function fmtDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

const STATUS_LABEL = {
  done: "Done",
  overdue: "Overdue",
  due_today: "Due today",
  upcoming: "Not yet due",
};
const STATUS_COLOR = {
  done: "badge-success",
  overdue: "badge-danger",
  due_today: "badge-warning",
  upcoming: "badge-neutral",
};

export default function LabTechnician() {
  const [tab, setTab] = useState("batches"); // batches | site-cast | mix-designs | assignments
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Round 134, item 7 — jumping straight to a specific pour/cast (originally
  // from the inline due-testing panel; Round 135 moved that panel to its own
  // "Samples Due for Testing" page, so this is now driven off URL query
  // params instead — see LabDueToday.jsx's "Enter results"/"Open" links,
  // which navigate here as /lab-technician?focusOrder=<id> or ?focusCast=<id>.
  const [focusPlantOrderId, setFocusPlantOrderId] = useState(null);
  const [focusSiteCastId, setFocusSiteCastId] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const focusOrder = searchParams.get("focusOrder");
    const focusCast = searchParams.get("focusCast");
    if (focusOrder) {
      setFocusPlantOrderId(Number(focusOrder));
      setTab("batches");
    } else if (focusCast) {
      setFocusSiteCastId(Number(focusCast));
      setTab("site-cast");
    }
    if (focusOrder || focusCast) setSearchParams({}, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <TopBar title="Lab Technician" />
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "0 16px 32px" }}>
        {/* Round 134, item 7 / Round 135 redesign — a compact KPI card
            (matching the app's own .se-strip pattern, e.g. SalesExecutive.jsx)
            replacing the old inline list, which grew into a wall of one-line
            rows above the tabs. Opens the full "Samples Due for Testing" page
            (LabDueToday.jsx) — everything the old panel's rows linked to is
            still reachable, plus what that page now shows that the panel
            never did: sample/cube count, both 7-day and 28-day due dates
            together, the poured/cast date, and a "Close — not testing"
            action right on each card. */}
        <DueTestingCard setError={setError} />

        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <button className={`btn-tab ${tab === "batches" ? "active" : ""}`} onClick={() => setTab("batches")}>Cube Testing</button>
          {/* Round 120, items 4b/4e — cubes prepared at the customer's site,
              not plant-cast; a separate workflow since there's no delivery
              ticket to anchor it to. */}
          <button className={`btn-tab ${tab === "site-cast" ? "active" : ""}`} onClick={() => setTab("site-cast")}>Site-Cast Cubes</button>
          <button className={`btn-tab ${tab === "mix-designs" ? "active" : ""}`} onClick={() => setTab("mix-designs")}>Mix Designs</button>
          {/* Round 132, follow-up — read-only: which customer is assigned
              which design, and since when. Assigning/removing stays an
              Administrator/Manager action (Masters → Mix Design Assignments). */}
          <button className={`btn-tab ${tab === "assignments" ? "active" : ""}`} onClick={() => setTab("assignments")}>Assignments</button>
          <Link to="/lab-technician/cube-test-report"><button type="button" className="btn-tab">Cube Test Report</button></Link>
          <Link to="/lab-technician/raw-material-stock"><button type="button" className="btn-tab">Raw Material Stock</button></Link>
        </div>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 8 }}>{notice}</div>}

        {tab === "batches" && <CubeTestingTab setError={setError} setNotice={setNotice} focusOrderId={focusPlantOrderId} />}
        {tab === "site-cast" && <SiteCubeTestingTab setError={setError} setNotice={setNotice} focusCastId={focusSiteCastId} />}
        {tab === "mix-designs" && <MixDesignsTab setError={setError} setNotice={setNotice} />}
        {tab === "assignments" && <AssignmentsTab setError={setError} />}
      </div>
    </>
  );
}

// Round 134, item 7, redesigned Round 135 — a single KPI-style strip (same
// visual pattern as the app's existing .se-strip "N overdue" cards, see
// SalesExecutive.jsx) instead of the old inline list. Fetches the same
// /lab-technician/due-testing endpoint (now one row per SAMPLE — pour or
// cast — not per age, see the backend route's own comment) purely to get
// counts; the full list lives on its own page (LabDueToday.jsx) so it can
// show each sample's full detail without turning this dashboard's landing
// view back into a wall of rows. Empty state collapses to a quiet single
// line rather than the strip, so a clear inbox doesn't look broken.
function DueTestingCard({ setError }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);

  useEffect(() => {
    apiRequest("/lab-technician/due-testing").then(setRows).catch((err) => setError(err.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (rows === null) return null; // avoid a flash of "nothing due" before the first load resolves
  if (rows.length === 0) {
    return (
      <div className="card" style={{ marginBottom: 16, fontSize: 12.5, color: "var(--slate)" }}>
        Nothing due for testing right now.
      </div>
    );
  }

  const overdueCount = rows.filter((r) => r.row_status === "overdue").length;
  const dueTodayCount = rows.length - overdueCount;

  return (
    <button
      type="button"
      className="se-strip"
      style={{ borderColor: overdueCount ? "var(--alert-red)" : undefined, cursor: "pointer" }}
      onClick={() => navigate("/lab-technician/due-today")}
    >
      <div className="se-strip-ic">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#B03A2E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 2v6.5L4.5 17a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L15 8.5V2" />
          <path d="M8 2h8" />
          <path d="M9.5 14h5" />
        </svg>
      </div>
      <div style={{ flex: 1 }}>
        <div className="se-strip-title">{rows.length} sample{rows.length === 1 ? "" : "s"} due for testing</div>
        <div className="se-strip-sub">
          {overdueCount > 0 && <span style={{ color: "var(--alert-red)" }}>{overdueCount} overdue</span>}
          {overdueCount > 0 && dueTodayCount > 0 && " · "}
          {dueTodayCount > 0 && <span>{dueTodayCount} due today</span>}
          {" — Open →"}
        </div>
      </div>
    </button>
  );
}

// ===== Assignments (read-only) =====
// Round 132, follow-up — "Lab Technician should be able to see assigned mix
// and customer details". Same data Administrator's "Mix Design Assignments"
// panel manages, but read-only here — no add/remove, since that's a
// business decision that stays with Administrator/Manager.
function AssignmentsTab({ setError }) {
  const [rows, setRows] = useState(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    apiRequest("/lab-technician/mix-design-assignments").then(setRows).catch((err) => setError(err.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (rows === null) return <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? rows.filter((a) => a.customer_name.toLowerCase().includes(q) || a.mix_grade_name.toLowerCase().includes(q) || a.design_ref_code.toLowerCase().includes(q))
    : rows;

  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12, lineHeight: 1.5 }}>
        Which specific, approved mix design each customer's grade resolves to. A customer+grade with
        no row here just uses that grade's standard design. Assigning or removing one is done from
        Administrator → Masters → Mix Design Assignments.
      </div>
      <input
        type="text" placeholder="Search customer, grade, or design ref..."
        value={search} onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 10, width: "100%", maxWidth: 320 }}
      />
      <div className="card">
        <table>
          <thead><tr><th>Customer</th><th>Grade</th><th>Assigned mix design</th><th>Since</th></tr></thead>
          <tbody>
            {filtered.map((a) => (
              <tr key={a.id}>
                <td>{a.customer_name}</td>
                <td>{a.mix_grade_name}</td>
                <td>
                  {a.design_ref_code}{" "}
                  {Number(a.design_shared_count) > 1 ? (
                    <span className="badge" style={{ background: "var(--info-bg, #E3EEF4)", color: "var(--info, #2A6F97)" }}>
                      Shared · {a.design_shared_count} customers
                    </span>
                  ) : (
                    <span className="badge badge-success">Custom</span>
                  )}
                </td>
                <td>{new Date(a.effective_from).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={4} style={{ color: "var(--slate)" }}>{rows.length === 0 ? "No customer-specific assignments yet — everyone gets the standard design per grade." : "No match."}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ===== Cube Testing =====

function CubeTestingTab({ setError, setNotice, focusOrderId }) {
  const [viewBucket, setViewBucket] = useState("active"); // active | completed | closed
  const [pours, setPours] = useState([]);
  const [openOrderId, setOpenOrderId] = useState(null);

  async function load() {
    try { setPours(await apiRequest(`/lab-technician/cube-pours?view=${viewBucket}`)); } catch (err) { setError(err.message); }
  }
  useEffect(() => { setOpenOrderId(null); load(); }, [viewBucket]);
  // Round 134, item 7 — jumping here from the due-testing panel opens that
  // specific pour directly, in the "active" bucket it's always in (a due,
  // not-yet-tested pour is never completed/closed).
  useEffect(() => {
    if (focusOrderId != null) { setViewBucket("active"); setOpenOrderId(focusOrderId); }
  }, [focusOrderId]);

  async function closePour(orderId) {
    const reason = window.prompt("Why is this pour not being tested? (optional — leave blank if you'd rather not say)");
    if (reason === null) return; // cancelled the prompt
    setError(""); setNotice("");
    try {
      await apiRequest(`/lab-technician/cube-pours/${orderId}/close`, { method: "POST", body: { reason } });
      setNotice("Pour closed — moved to the Closed list.");
      load();
    } catch (err) { setError(err.message); }
  }

  async function reopenPour(orderId) {
    setError(""); setNotice("");
    try {
      await apiRequest(`/lab-technician/cube-pours/${orderId}/reopen`, { method: "POST" });
      setNotice("Pour reopened — moved back to Active.");
      load();
    } catch (err) { setError(err.message); }
  }

  const EMPTY_LABEL = {
    active: "No active pours — cubes are cast and identified by QC Engineer at plant QC entry.",
    completed: "No completed pours yet — a pour moves here once both 7-day and 28-day results are entered.",
    closed: "No closed pours.",
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <button className={`btn-tab ${viewBucket === "active" ? "active" : ""}`} onClick={() => setViewBucket("active")}>Active</button>
        <button className={`btn-tab ${viewBucket === "completed" ? "active" : ""}`} onClick={() => setViewBucket("completed")}>Completed</button>
        <button className={`btn-tab ${viewBucket === "closed" ? "active" : ""}`} onClick={() => setViewBucket("closed")}>Closed</button>
      </div>
      {/* Round 122 — cube testing moved from per-DN to per-pour; every DN
          that contributed cubes to a pour shows up as a reference inside its
          own test card (see "Open" below) instead of being its own card. */}
      <div style={{ fontSize: 12, color: "var(--charcoal)", background: "var(--info-bg, #E3EEF4)", borderRadius: 8, padding: "8px 10px", margin: "8px 0 12px", lineHeight: 1.5 }}>
        Cube tests are grouped <b>by pour (order)</b>, not by delivery note. Every DN that contributed cubes to a pour
        shows up as a reference inside its test card.
      </div>
      {pours.map((p) => {
        const strength7 = p.result_7day_strength ?? p.legacy_7day_strength;
        const strength28 = p.result_28day_strength ?? p.legacy_28day_strength;
        return (
          <div key={p.order_id} className="card" style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {formatOrderNumber(p.order_id)} · {p.mix_grade_name} · {p.total_cubes} cube{Number(p.total_cubes) === 1 ? "" : "s"} across {p.dn_count} DN{Number(p.dn_count) === 1 ? "" : "s"}
                </div>
                <div style={{ fontSize: 12, color: "var(--slate)" }}>{p.customer_name} — {p.site_name}</div>
                <div style={{ fontSize: 11, color: "var(--slate)" }}>Poured {fmtDate(p.poured_at)}</div>
                {viewBucket === "closed" && (
                  <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>
                    Closed {fmtDate(p.closed_at)}{p.closed_by_name ? ` by ${p.closed_by_name}` : ""}{p.closed_reason ? ` — ${p.closed_reason}` : ""}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {viewBucket === "closed" ? (
                  <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => reopenPour(p.order_id)}>Reopen</button>
                ) : (
                  <>
                    {viewBucket === "active" && (
                      <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => closePour(p.order_id)}>Close — not testing</button>
                    )}
                    <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setOpenOrderId(openOrderId === p.order_id ? null : p.order_id)}>
                      {openOrderId === p.order_id ? "Hide" : "Open"}
                    </button>
                  </>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <AgeBadge label="7-day" status={p.status_7day} due={p.due_7day} strength={strength7} />
              <AgeBadge label="28-day" status={p.status_28day} due={p.due_28day} strength={strength28} />
            </div>
            {viewBucket !== "closed" && openOrderId === p.order_id && (
              <PourDetail
                orderId={p.order_id}
                setError={setError}
                setNotice={setNotice}
                onSaved={() => { load(); }}
              />
            )}
          </div>
        );
      })}
      {pours.length === 0 && <div style={{ fontSize: 13, color: "var(--slate)" }}>{EMPTY_LABEL[viewBucket]}</div>}
    </div>
  );
}

function AgeBadge({ label, status, due, strength }) {
  return (
    <div style={{ fontSize: 11 }}>
      <span className={`badge ${STATUS_COLOR[status] || "badge-neutral"}`}>{label}: {STATUS_LABEL[status] || status}</span>
      {status === "done" && strength != null && <span style={{ color: "var(--slate)", marginLeft: 4 }}>{Number(strength).toFixed(1)} MPa</span>}
      {status !== "done" && due && <span style={{ color: "var(--slate)", marginLeft: 4 }}>{fmtDate(due)}</span>}
    </div>
  );
}

// Round 130 — "generate combined or individual results for completed tests"
// (explicit feedback): once both ages of a pour/cast are tested, offer the
// combined report — before that, there's just the one result on file, so
// there's nothing to combine (View PDF next to that single result already
// covers it). Shared between PourDetail (plant) and SiteCastDetail
// (site-cast) below — same shape of `results` (an array of
// {id, testing_age_days, ...}) either way.
//
// Round 131, item 3b (explicit feedback) — once both ages are tested,
// Combined is the only report that makes sense: it supersedes the separate
// 7-day/28-day PDFs (and the individual "View PDF" buttons above are hidden
// at that point too), so those per-age buttons were dropped here.
function GenerateReportBar({ results, onCombined }) {
  const [busy, setBusy] = useState(false);
  const day7 = results.find((r) => r.testing_age_days === 7);
  const day28 = results.find((r) => r.testing_age_days === 28);
  if (!day7 || !day28) return null;

  async function run(fn) {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: "var(--concrete)", borderRadius: 8, padding: "8px 10px", marginBottom: 12 }}>
      <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--slate)" }}>Generate PDF for this pour:</span>
      <button type="button" disabled={busy} style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => run(onCombined)}>Combined (both ages)</button>
    </div>
  );
}

// Round 122 — one pour's expanded card: the DN reference list ("cube samples
// for this pour"), any results already on file (pour-level and legacy — see
// the backend route's own comment), and the entry form, which groups its
// cube rows by contributing DN rather than one flat list, matching the
// mockup this was built from.
function PourDetail({ orderId, setError, setNotice, onSaved }) {
  const { user } = useAuth();
  // Round 129 — date-change and delete on a recorded result used to be
  // administrator-only (Round 124/125); opened up to Lab Technician too,
  // since they're the ones who entered the result in the first place.
  const canManageResults = user?.role === "administrator" || user?.role === "lab_technician";
  const [detail, setDetail] = useState(null);
  const [age, setAge] = useState(7);
  const [mixDesignId, setMixDesignId] = useState("");
  const [groups, setGroups] = useState([]); // one per DN: { plant_qc_id, ticket_number, cubes: [...] }
  const [remarks, setRemarks] = useState("");
  const [failureType, setFailureType] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(""); // shown inline on this card, not just the page-top notice
  const [editingDateFor, setEditingDateFor] = useState(null); // result id currently being date-corrected
  const [dateDraft, setDateDraft] = useState("");
  const [savingDate, setSavingDate] = useState(false);

  function resetGroupsFor(d) {
    setGroups(d.dns.map((dn) => {
      const labels = (dn.sample_ids || "").split(",").map((s) => s.trim()).filter(Boolean);
      const count = dn.number_of_cubes || labels.length || 3;
      return {
        plant_qc_id: dn.plant_qc_id,
        ticket_number: dn.ticket_number,
        cubes: Array.from({ length: count }, (_, i) => ({
          cube_label: labels[i] || `${dn.ticket_number} · Cube ${i + 1}`, weight_kg: "", testing_load_kn: "",
        })),
      };
    }));
  }

  // Round 124, item 5 — rebuild the entry form's groups from a pour-level
  // result already on file, so reopening an already-tested age is an actual
  // edit (pre-filled, ready to correct one wrong figure and resave) instead
  // of forcing a blind full re-type of every cube. Grouped by DN in the same
  // order as detail.dns; a DN with no cubes in this particular result is
  // just left out (matches whatever was really submitted for this age).
  function groupsFromResult(d, result) {
    const byDn = new Map();
    for (const c of result.cubes || []) {
      if (!byDn.has(c.plant_qc_id)) byDn.set(c.plant_qc_id, []);
      byDn.get(c.plant_qc_id).push({ cube_label: c.cube_label, weight_kg: c.weight_kg ?? "", testing_load_kn: c.testing_load_kn ?? "" });
    }
    return d.dns.filter((dn) => byDn.has(dn.plant_qc_id)).map((dn) => ({
      plant_qc_id: dn.plant_qc_id, ticket_number: dn.ticket_number, cubes: byDn.get(dn.plant_qc_id),
    }));
  }

  // Picks pre-filled (editing) vs. blank (new) groups for whichever age is
  // now selected — called on initial load and again whenever the 7-day/
  // 28-day radio is switched by hand.
  function setGroupsForAge(d, ageValue) {
    const existing = (d.results || []).find((r) => r.is_pour_level && r.testing_age_days === ageValue);
    if (existing?.cubes?.length) setGroups(groupsFromResult(d, existing));
    else resetGroupsFor(d);
  }

  async function loadDetail() {
    try {
      const d = await apiRequest(`/lab-technician/cube-pours/${orderId}`);
      setDetail(d);
      setMixDesignId(d.resolved_mix_design_id || (d.approved_designs[0]?.id ?? ""));
      // Default the radio to whichever age isn't tested yet, so re-opening
      // after a save points straight at the next thing to do.
      const testedAges = d.results.map((r) => r.testing_age_days);
      const nextAge = testedAges.includes(7) && !testedAges.includes(28) ? 28 : 7;
      setAge(nextAge);
      setGroupsForAge(d, nextAge);
      return d;
    } catch (err) { setError(err.message); return null; }
  }

  useEffect(() => { loadDetail(); }, [orderId]);

  function chooseAge(next) {
    setAge(next);
    if (detail) setGroupsForAge(detail, next);
  }

  async function deleteResult(resultId) {
    // Round 127 — a pour's Completed/Active bucket is computed live from
    // whichever results are on file (see the GET /cube-pours comment), never
    // stored, so deleting the 7-day or 28-day result of an already-complete
    // pour correctly (and immediately) moves it back to Active until that
    // age is re-tested. That's by design, but it reads as "my data
    // vanished" if it's a surprise — so say it up front here instead.
    const testedAges = new Set((detail?.results || []).map((r) => r.testing_age_days));
    const wasComplete = testedAges.size >= 2;
    const msg = wasComplete
      ? "Delete this result? This can't be undone. Both ages are currently tested (this pour shows as Completed) — deleting this one will move the pour back to Active until it's re-tested."
      : "Delete this result? This can't be undone.";
    if (!window.confirm(msg)) return;
    setError(""); setNotice("");
    try {
      await apiRequest(`/lab-technician/cube-pours/${orderId}/results/${resultId}`, { method: "DELETE" });
      await loadDetail();
      onSaved();
    } catch (err) { setError(err.message); }
  }

  function updateCube(gi, ci, field, value) {
    setGroups((gs) => gs.map((g, gidx) => gidx === gi
      ? { ...g, cubes: g.cubes.map((c, cidx) => cidx === ci ? { ...c, [field]: value } : c) }
      : g));
  }

  const allCubes = groups.flatMap((g) => g.cubes);
  const avgStrength = (() => {
    const vals = allCubes.map((c) => Number(computeStrength(c.testing_load_kn))).filter((v) => v > 0);
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
  })();

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice(""); setSavedNotice("");
    try {
      const payload = {
        testing_age_days: age,
        mix_design_id: mixDesignId || null,
        remarks,
        failure_type: failureType || null,
        groups: groups.map((g) => ({
          plant_qc_id: g.plant_qc_id,
          cubes: g.cubes.map((c) => ({
            cube_label: c.cube_label,
            weight_kg: c.weight_kg || null,
            testing_load_kn: c.testing_load_kn || null,
            density_kgm3: computeDensity(c.weight_kg) || null,
            strength_mpa: computeStrength(c.testing_load_kn) || null,
          })),
        })),
      };
      await apiRequest(`/lab-technician/cube-pours/${orderId}/results`, { method: "POST", body: payload });
      setSavedNotice(`${age}-day result saved.`); // stays on this card, not just the top-of-page banner
      setRemarks("");
      setFailureType("");
      await loadDetail(); // pulls the new result into detail.results below, same card, no reopen needed
      onSaved(); // refreshes the pour list's status badges/counts
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function viewPdf(resultId) {
    try {
      const data = await apiRequest(`/lab-technician/cube-tests/${resultId}/pdf-data`);
      await generateCubeTestPdf(data);
    } catch (err) { setError(err.message); }
  }

  // Round 130 — the pour's single combined report (both ages, one page); see
  // GenerateReportBar and generateCombinedPourCubeTestPdf.
  async function viewCombinedPdf() {
    try {
      const data = await apiRequest(`/lab-technician/cube-pours/${orderId}/combined-pdf-data`);
      await generateCombinedPourCubeTestPdf(data);
    } catch (err) { setError(err.message); }
  }

  // Round 120, item 4a — not every internal test needs to reach the customer
  // module; defaults to visible (see the schema migration) so this is only
  // ever used to actively hide one.
  async function toggleVisible(resultId, visible) {
    setError("");
    try {
      await apiRequest(`/lab-technician/cube-tests/${resultId}/visibility`, { method: "PATCH", body: { visible_to_customer: visible } });
      await loadDetail();
    } catch (err) { setError(err.message); }
  }

  function startDateEdit(r) {
    setEditingDateFor(r.id);
    // Local calendar date, not toISOString()'s UTC date — the app's home
    // timezone is IST (UTC+5:30), so a result tested between 00:00-05:29
    // IST has a UTC date one day earlier; pre-filling from that would let
    // an admin silently save the wrong (earlier) day.
    const d = new Date(r.tested_at);
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setDateDraft(local);
  }

  async function saveDate(resultId) {
    if (!dateDraft) return;
    setSavingDate(true); setError("");
    try {
      await apiRequest(`/lab-technician/cube-pours/${orderId}/results/${resultId}/date`, {
        method: "PATCH",
        body: { tested_at: dateDraft },
      });
      setEditingDateFor(null);
      await loadDetail();
    } catch (err) { setError(err.message); } finally { setSavingDate(false); }
  }

  if (!detail) return <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 8 }}>Loading…</div>;

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--concrete)", paddingTop: 12 }}>
      {savedNotice && (
        <div style={{ color: "var(--signal-green)", fontSize: 12.5, marginBottom: 10, background: "var(--concrete)", borderRadius: 8, padding: "6px 10px" }}>
          ✓ {savedNotice}
        </div>
      )}

      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--rebar)", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 6 }}>
        Cube samples for this pour
      </div>
      <div style={{ marginBottom: 12 }}>
        {detail.dns.map((dn) => (
          <div key={`dn-${dn.plant_qc_id}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--concrete)", fontSize: 12.5 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="badge badge-info" style={{ fontSize: 10 }}>Plant</span>
                <span style={{ fontWeight: 600 }}>{dn.ticket_number}{dn.truck_number ? ` · Truck ${dn.truck_number}` : ""}</span>
              </div>
              <div style={{ color: "var(--slate)", fontSize: 11.5, marginTop: 1 }}>{dn.number_of_cubes || "?"} cubes · Sampled {fmtDate(dn.cast_at)}</div>
            </div>
          </div>
        ))}
        {/* Round 130 — a Site Supervisor's own independent cube recording
            (siteSupervisor.js's POST .../site-cubes) shows up here too,
            labeled "At Site" instead of a DN/truck, so it isn't missed when
            reviewing this pour's samples. Results for these are still
            entered from the separate Site-Cast Cubes tab (a different table
            underneath — see the backend route's comment), not this form. */}
        {(detail.site_casts || []).map((sc) => (
          <div key={`site-${sc.site_cube_cast_id}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--concrete)", fontSize: 12.5 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="badge badge-violet" style={{ fontSize: 10 }}>At Site</span>
                <span style={{ fontWeight: 600 }}>{sc.entered_by_name ? `Recorded by ${sc.entered_by_name}` : "Recorded at site"}</span>
              </div>
              <div style={{ color: "var(--slate)", fontSize: 11.5, marginTop: 1 }}>
                {sc.number_of_cubes || "?"} cubes · Sampled {fmtDate(sc.cast_date)} · enter results from the Site-Cast Cubes tab
              </div>
            </div>
          </div>
        ))}
      </div>

      {detail.results.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 6 }}>
            Recorded results
          </div>
          {/* Round 131, item 3b — once both ages are on file, Combined (below,
              via GenerateReportBar) supersedes the individual reports, so the
              per-result View PDF is hidden here; with only one age tested,
              it's still the only way to see that age's report early. */}
          {detail.results.map((r) => (
            <div key={r.id} style={{ fontSize: 12, marginBottom: 8, borderBottom: "1px solid var(--concrete)", paddingBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{r.testing_age_days}-day — {Number(r.average_strength_mpa).toFixed(1)} MPa avg, tested by {r.tested_by_name}</span>
                {!(detail.results.some((x) => x.testing_age_days === 7) && detail.results.some((x) => x.testing_age_days === 28)) && (
                  <button type="button" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => viewPdf(r.id)}>View PDF</button>
                )}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: "var(--slate)", fontSize: 11, marginTop: 2 }}>
                <span>
                  Tested on {fmtDate(r.tested_at)}{r.failure_type ? ` · Failure: ${r.failure_type}` : ""}
                  {!r.is_pour_level && " · legacy — recorded before pour-basis testing"}
                </span>
                {canManageResults && editingDateFor !== r.id && (
                  <span style={{ display: "flex", gap: 4 }}>
                    <button type="button" style={{ fontSize: 10.5, padding: "2px 6px" }} onClick={() => startDateEdit(r)}>Change date</button>
                    <button type="button" style={{ fontSize: 10.5, padding: "2px 6px", color: "var(--alert-red)", borderColor: "var(--alert-red)" }} onClick={() => deleteResult(r.id)}>
                      Delete
                    </button>
                  </span>
                )}
              </div>
              {r.is_pour_level && (
                <div style={{ color: "var(--slate)", fontSize: 10.5, marginTop: 2 }}>
                  Wrong entry? Pick {r.testing_age_days}-day below — it's pre-filled with these figures, ready to correct.
                </div>
              )}
              <label style={{ display: "flex", gap: 5, alignItems: "center", marginTop: 3, color: "var(--slate)" }}>
                <input type="checkbox" checked={r.visible_to_customer !== false} onChange={(e) => toggleVisible(r.id, e.target.checked)} />
                Visible in customer module
              </label>
              {canManageResults && editingDateFor === r.id && (
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                  <input type="date" value={dateDraft} onChange={(e) => setDateDraft(e.target.value)} style={{ fontSize: 11 }} />
                  <button type="button" style={{ fontSize: 10.5, padding: "2px 8px" }} disabled={savingDate} onClick={() => saveDate(r.id)}>
                    {savingDate ? "Saving..." : "Save"}
                  </button>
                  <button type="button" style={{ fontSize: 10.5, padding: "2px 8px" }} onClick={() => setEditingDateFor(null)}>Cancel</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <GenerateReportBar results={detail.results} onCombined={viewCombinedPdf} />

      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--slate)", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 6 }}>
        {detail.results.some((r) => r.is_pour_level && r.testing_age_days === age) ? `Editing the ${age}-day result` : `Enter ${age}-day results`}
      </div>
      {detail.results.some((r) => r.is_pour_level && r.testing_age_days === age) && (
        <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8 }}>
          Pre-filled with what's already on file — fix whatever's wrong and save to overwrite it.
        </div>
      )}
      <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
        <div style={{ display: "flex", gap: 16 }}>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="radio" checked={age === 7} onChange={() => chooseAge(7)} /> 7-day
          </label>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="radio" checked={age === 28} onChange={() => chooseAge(28)} /> 28-day
          </label>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Compare against mix design</div>
          <select value={mixDesignId} onChange={(e) => setMixDesignId(e.target.value)}>
            <option value="">— none on file —</option>
            {detail.approved_designs.map((d) => <option key={d.id} value={d.id}>{d.design_ref_code}</option>)}
          </select>
        </div>
        {groups.map((g, gi) => (
          <div key={g.plant_qc_id}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--rebar)", textTransform: "uppercase", letterSpacing: 0.3, margin: "6px 0" }}>
              From DN {g.ticket_number}
            </div>
            {g.cubes.map((c, ci) => (
              <div key={ci} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, alignItems: "end", marginBottom: 6 }}>
                <div>
                  <div style={{ color: "var(--slate)", fontSize: 11 }}>{ci === 0 ? "Cube" : ""}</div>
                  <input value={c.cube_label} onChange={(e) => updateCube(gi, ci, "cube_label", e.target.value)} style={{ width: "100%" }} />
                </div>
                <div>
                  <div style={{ color: "var(--slate)", fontSize: 11 }}>{ci === 0 ? "Weight (kg)" : ""}</div>
                  <input type="number" step="0.001" value={c.weight_kg} onChange={(e) => updateCube(gi, ci, "weight_kg", e.target.value)} style={{ width: "100%" }} />
                </div>
                <div>
                  <div style={{ color: "var(--slate)", fontSize: 11 }}>{ci === 0 ? "Load (kN)" : ""}</div>
                  <input type="number" step="0.01" value={c.testing_load_kn} onChange={(e) => updateCube(gi, ci, "testing_load_kn", e.target.value)} style={{ width: "100%" }} />
                </div>
                <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--slate)" }}>
                  {c.weight_kg && `Density: ${computeDensity(c.weight_kg)} kg/m³`} {c.testing_load_kn && `· Strength: ${computeStrength(c.testing_load_kn)} MPa`}
                </div>
              </div>
            ))}
          </div>
        ))}
        {avgStrength && (
          <div style={{ background: "var(--concrete)", borderRadius: 8, padding: "8px 10px", fontSize: 12.5 }}>
            Average strength so far: <b>{avgStrength} MPa</b>
          </div>
        )}
        <div>
          <div style={{ color: "var(--slate)" }}>Type of failure (optional)</div>
          <input
            list="failure-type-options"
            value={failureType}
            onChange={(e) => setFailureType(e.target.value)}
            placeholder="e.g. Cone, Shear — or describe what you observed"
            style={{ width: "100%" }}
          />
          <datalist id="failure-type-options">
            {FAILURE_TYPES.map((f) => <option key={f} value={f} />)}
          </datalist>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Remarks</div>
          <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
        <button type="submit" disabled={saving}>{saving ? "Saving..." : `Save ${age}-day results`}</button>
      </form>
    </div>
  );
}

// ===== Site-cast cube tests (round 120, items 4b/4e) =====
// Cubes prepared at the customer's site rather than plant-cast — there's no
// delivery ticket to hang a batch off, so a cast record is created directly
// against an order instead. Everything downstream (age entry, averaging,
// PDF, visibility toggle) mirrors CubeTestingTab/BatchDetail above exactly;
// only the create-a-batch step is new (a plant batch is created implicitly
// by QC Engineer casting cubes — this one needs an explicit "record a cast"
// action since nothing else in the app would ever create it).

function SiteCubeTestingTab({ setError, setNotice, focusCastId }) {
  const [casts, setCasts] = useState([]);
  const [openCastId, setOpenCastId] = useState(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    try { setCasts(await apiRequest("/lab-technician/site-cube-casts")); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);
  // Round 134, item 7 — jumping here from the due-testing panel.
  useEffect(() => {
    if (focusCastId != null) setOpenCastId(focusCastId);
  }, [focusCastId]);

  if (creating) {
    return (
      <NewSiteCastForm
        setError={setError} setNotice={setNotice}
        onDone={(castId) => { setCreating(false); load(); setOpenCastId(castId); }}
        onCancel={() => setCreating(false)}
      />
    );
  }

  return (
    <div>
      <button type="button" className="btn-primary" style={{ marginBottom: 12 }} onClick={() => setCreating(true)}>+ Record a site cast</button>
      {casts.map((b) => (
        <div key={b.cast_id} className="card" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontWeight: 600 }}>{formatOrderNumber(b.order_id)} · {b.mix_grade_name} · {b.number_of_cubes || "?"} cubes</div>
              <div style={{ fontSize: 12, color: "var(--slate)" }}>{b.customer_name} — {b.site_name}</div>
              <div style={{ fontSize: 11, color: "var(--slate)" }}>Cast {fmtDate(b.cast_date)} · Sample IDs: {b.sample_ids || "—"}</div>
            </div>
            <button type="button" style={{ fontSize: 12, padding: "4px 10px", flexShrink: 0 }} onClick={() => setOpenCastId(openCastId === b.cast_id ? null : b.cast_id)}>
              {openCastId === b.cast_id ? "Hide" : "Open"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <AgeBadge label="7-day" status={b.result_7day_id ? "done" : "upcoming"} strength={b.result_7day_strength} />
            <AgeBadge label="28-day" status={b.result_28day_id ? "done" : "upcoming"} strength={b.result_28day_strength} />
          </div>
          {openCastId === b.cast_id && (
            <SiteCastDetail castId={b.cast_id} setError={setError} setNotice={setNotice} onSaved={() => load()} />
          )}
        </div>
      ))}
      {casts.length === 0 && <div style={{ fontSize: 13, color: "var(--slate)" }}>No site-cast cube batches recorded yet.</div>}
    </div>
  );
}

function NewSiteCastForm({ setError, setNotice, onDone, onCancel }) {
  const [orders, setOrders] = useState([]);
  const [orderId, setOrderId] = useState("");
  const [castDate, setCastDate] = useState(new Date().toISOString().slice(0, 10));
  const [numberOfCubes, setNumberOfCubes] = useState("");
  const [sampleIds, setSampleIds] = useState("");
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);

  // Round 121, item 4 — only orders that actually received supply are
  // selectable (see the backend route's own comment): a site cast can't
  // exist for concrete that was never delivered.
  useEffect(() => { apiRequest("/lab-technician/orders-with-supply").then(setOrders).catch((err) => setError(err.message)); }, []);

  async function submit(e) {
    e.preventDefault();
    if (!orderId) { setError("Select which order these cubes were cast for."); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      const created = await apiRequest("/lab-technician/site-cube-casts", {
        method: "POST",
        body: { order_id: orderId, cast_date: castDate, number_of_cubes: numberOfCubes || null, sample_ids: sampleIds || null, remarks: remarks || null },
      });
      setNotice("Site cast recorded — enter test results below once ready.");
      onDone(created.id);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
      <button type="button" onClick={onCancel} style={{ alignSelf: "flex-start" }}>← Cancel</button>
      <div>
        <div style={{ color: "var(--slate)" }}>Order</div>
        <select value={orderId} onChange={(e) => setOrderId(e.target.value)} required>
          <option value="">Select the order these cubes were cast for</option>
          {orders.map((o) => <option key={o.id} value={o.id}>{formatOrderNumber(o.id)} — {o.customer_name} — {o.site_name}</option>)}
        </select>
      </div>
      <div>
        <div style={{ color: "var(--slate)" }}>Cast date</div>
        <input type="date" value={castDate} onChange={(e) => setCastDate(e.target.value)} required />
      </div>
      <div>
        <div style={{ color: "var(--slate)" }}>Number of cubes</div>
        <input type="number" min="1" value={numberOfCubes} onChange={(e) => setNumberOfCubes(e.target.value)} />
      </div>
      <div>
        <div style={{ color: "var(--slate)" }}>Sample IDs (comma-separated, optional)</div>
        <input value={sampleIds} onChange={(e) => setSampleIds(e.target.value)} />
      </div>
      <div>
        <div style={{ color: "var(--slate)" }}>Remarks</div>
        <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </div>
      <button type="submit" disabled={saving}>{saving ? "Saving..." : "Record cast"}</button>
    </form>
  );
}

function SiteCastDetail({ castId, setError, setNotice, onSaved }) {
  const { user } = useAuth();
  // Round 129 — delete on a recorded site-cast result opened up to Lab
  // Technician too, matching the plant-side change above (no date-change
  // route exists for site-cast results, so there's nothing to mirror there).
  const canManageResults = user?.role === "administrator" || user?.role === "lab_technician";
  const [detail, setDetail] = useState(null);
  const [age, setAge] = useState(7);
  const [mixDesignId, setMixDesignId] = useState("");
  const [cubes, setCubes] = useState([]);
  const [remarks, setRemarks] = useState("");
  const [failureType, setFailureType] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState("");

  function resetCubesFor(d) {
    const labels = (d.sample_ids || "").split(",").map((s) => s.trim()).filter(Boolean);
    const count = d.number_of_cubes || labels.length || 3;
    setCubes(Array.from({ length: count }, (_, i) => ({
      cube_label: labels[i] || `Cube ${i + 1}`, weight_kg: "", testing_load_kn: "",
    })));
  }

  // Round 124, item 5 — same pre-fill-to-edit fix as the plant pour form:
  // reopening an already-tested age loads what's on file instead of a blank
  // form, so correcting a wrong entry doesn't require blindly re-typing
  // every cube (which is how item 6's averaging bug went unnoticed).
  function setCubesForAge(d, ageValue) {
    const existing = (d.results || []).find((r) => r.testing_age_days === ageValue);
    if (existing?.cubes?.length) {
      setCubes(existing.cubes.map((c) => ({ cube_label: c.cube_label, weight_kg: c.weight_kg ?? "", testing_load_kn: c.testing_load_kn ?? "" })));
    } else {
      resetCubesFor(d);
    }
  }

  async function loadDetail() {
    try {
      const d = await apiRequest(`/lab-technician/site-cube-casts/${castId}`);
      setDetail(d);
      setMixDesignId(d.resolved_mix_design_id || (d.approved_designs[0]?.id ?? ""));
      const testedAges = d.results.map((r) => r.testing_age_days);
      const nextAge = testedAges.includes(7) && !testedAges.includes(28) ? 28 : 7;
      setAge(nextAge);
      setCubesForAge(d, nextAge);
      return d;
    } catch (err) { setError(err.message); return null; }
  }

  useEffect(() => { loadDetail(); }, [castId]);

  function chooseAge(next) {
    setAge(next);
    if (detail) setCubesForAge(detail, next);
  }

  async function deleteResult(resultId) {
    if (!window.confirm("Delete this result? This can't be undone.")) return;
    setError(""); setNotice("");
    try {
      await apiRequest(`/lab-technician/site-cube-tests/${resultId}`, { method: "DELETE" });
      await loadDetail();
      onSaved();
    } catch (err) { setError(err.message); }
  }

  function updateCube(i, field, value) {
    setCubes((cs) => cs.map((c, idx) => idx === i ? { ...c, [field]: value } : c));
  }

  const avgStrength = (() => {
    const vals = cubes.map((c) => Number(computeStrength(c.testing_load_kn))).filter((v) => v > 0);
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
  })();

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice(""); setSavedNotice("");
    try {
      const payload = {
        testing_age_days: age,
        mix_design_id: mixDesignId || null,
        remarks,
        failure_type: failureType || null,
        cubes: cubes.map((c) => ({
          cube_label: c.cube_label,
          weight_kg: c.weight_kg || null,
          testing_load_kn: c.testing_load_kn || null,
          density_kgm3: computeDensity(c.weight_kg) || null,
          strength_mpa: computeStrength(c.testing_load_kn) || null,
        })),
      };
      await apiRequest(`/lab-technician/site-cube-casts/${castId}/results`, { method: "POST", body: payload });
      setSavedNotice(`${age}-day result saved.`);
      setRemarks(""); setFailureType("");
      await loadDetail();
      onSaved();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function viewPdf(resultId) {
    try {
      const data = await apiRequest(`/lab-technician/site-cube-tests/${resultId}/pdf-data`);
      await generateCubeTestPdf(data);
    } catch (err) { setError(err.message); }
  }

  // Round 130 — the site cast's single combined report (both ages, one page).
  async function viewCombinedPdf() {
    try {
      const data = await apiRequest(`/lab-technician/site-cube-casts/${castId}/combined-pdf-data`);
      await generateCombinedPourCubeTestPdf(data);
    } catch (err) { setError(err.message); }
  }

  async function toggleVisible(resultId, visible) {
    setError("");
    try {
      await apiRequest(`/lab-technician/site-cube-tests/${resultId}/visibility`, { method: "PATCH", body: { visible_to_customer: visible } });
      await loadDetail();
    } catch (err) { setError(err.message); }
  }

  // Round 121, item 5 — delete a wrongly-entered site cast (wrong order,
  // duplicate entry, etc). Unlike a plant batch, a site cast has no delivery
  // ticket behind it — nothing else on record depends on it — so a real
  // delete is correct here, not a "close" flag.
  async function deleteCast() {
    if (!window.confirm("Delete this site cast? This removes it and any test results already entered against it — this can't be undone.")) return;
    setError("");
    try {
      await apiRequest(`/lab-technician/site-cube-casts/${castId}`, { method: "DELETE" });
      onSaved();
    } catch (err) { setError(err.message); }
  }

  if (!detail) return <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 8 }}>Loading…</div>;

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--concrete)", paddingTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button type="button" onClick={deleteCast} style={{ fontSize: 11, padding: "3px 9px", color: "var(--alert-red)", borderColor: "var(--alert-red)" }}>
          Delete this cast
        </button>
      </div>
      {savedNotice && (
        <div style={{ color: "var(--signal-green)", fontSize: 12.5, marginBottom: 10, background: "var(--concrete)", borderRadius: 8, padding: "6px 10px" }}>
          ✓ {savedNotice}
        </div>
      )}
      {detail.results.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {/* Round 131, item 3b — same rule as PourDetail: once both ages
              are on file, Combined (below) supersedes the per-age reports,
              so the individual View PDF is hidden once this cast is complete. */}
          {detail.results.map((r) => (
            <div key={r.id} style={{ fontSize: 12, marginBottom: 8, borderBottom: "1px solid var(--concrete)", paddingBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{r.testing_age_days}-day — {Number(r.average_strength_mpa).toFixed(1)} MPa avg, tested by {r.tested_by_name}</span>
                <span style={{ display: "flex", gap: 4 }}>
                  {!(detail.results.some((x) => x.testing_age_days === 7) && detail.results.some((x) => x.testing_age_days === 28)) && (
                    <button type="button" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => viewPdf(r.id)}>View PDF</button>
                  )}
                  {canManageResults && (
                    <button type="button" style={{ fontSize: 11, padding: "3px 8px", color: "var(--alert-red)", borderColor: "var(--alert-red)" }} onClick={() => deleteResult(r.id)}>
                      Delete
                    </button>
                  )}
                </span>
              </div>
              <div style={{ color: "var(--slate)", fontSize: 11, marginTop: 2 }}>
                Tested on {fmtDate(r.tested_at)}{r.failure_type ? ` · Failure: ${r.failure_type}` : ""}
              </div>
              <div style={{ color: "var(--slate)", fontSize: 10.5, marginTop: 2 }}>
                Wrong entry? Pick {r.testing_age_days}-day below — it's pre-filled with these figures, ready to correct.
              </div>
              <label style={{ display: "flex", gap: 5, alignItems: "center", marginTop: 3, color: "var(--slate)" }}>
                <input type="checkbox" checked={r.visible_to_customer !== false} onChange={(e) => toggleVisible(r.id, e.target.checked)} />
                Visible in customer module
              </label>
            </div>
          ))}
        </div>
      )}

      <GenerateReportBar results={detail.results} onCombined={viewCombinedPdf} />

      <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
        {detail.results.some((r) => r.testing_age_days === age) && (
          <div style={{ fontSize: 11, color: "var(--slate)" }}>
            Editing the {age}-day result — pre-filled with what's already on file, save to overwrite it.
          </div>
        )}
        <div style={{ display: "flex", gap: 16 }}>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="radio" checked={age === 7} onChange={() => chooseAge(7)} /> 7-day
          </label>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="radio" checked={age === 28} onChange={() => chooseAge(28)} /> 28-day
          </label>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Compare against mix design</div>
          <select value={mixDesignId} onChange={(e) => setMixDesignId(e.target.value)}>
            <option value="">— none on file —</option>
            {detail.approved_designs.map((d) => <option key={d.id} value={d.id}>{d.design_ref_code}</option>)}
          </select>
        </div>
        {cubes.map((c, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, alignItems: "end" }}>
            <div>
              <div style={{ color: "var(--slate)", fontSize: 11 }}>{i === 0 ? "Cube" : ""}</div>
              <input value={c.cube_label} onChange={(e) => updateCube(i, "cube_label", e.target.value)} style={{ width: "100%" }} />
            </div>
            <div>
              <div style={{ color: "var(--slate)", fontSize: 11 }}>{i === 0 ? "Weight (kg)" : ""}</div>
              <input type="number" step="0.001" value={c.weight_kg} onChange={(e) => updateCube(i, "weight_kg", e.target.value)} style={{ width: "100%" }} />
            </div>
            <div>
              <div style={{ color: "var(--slate)", fontSize: 11 }}>{i === 0 ? "Load (kN)" : ""}</div>
              <input type="number" step="0.01" value={c.testing_load_kn} onChange={(e) => updateCube(i, "testing_load_kn", e.target.value)} style={{ width: "100%" }} />
            </div>
            <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--slate)" }}>
              {c.weight_kg && `Density: ${computeDensity(c.weight_kg)} kg/m³`} {c.testing_load_kn && `· Strength: ${computeStrength(c.testing_load_kn)} MPa`}
            </div>
          </div>
        ))}
        {avgStrength && (
          <div style={{ background: "var(--concrete)", borderRadius: 8, padding: "8px 10px", fontSize: 12.5 }}>
            Average strength: <b>{avgStrength} MPa</b>
          </div>
        )}
        <div>
          <div style={{ color: "var(--slate)" }}>Type of failure (optional)</div>
          <input
            list="failure-type-options"
            value={failureType}
            onChange={(e) => setFailureType(e.target.value)}
            placeholder="e.g. Cone, Shear — or describe what you observed"
            style={{ width: "100%" }}
          />
          <datalist id="failure-type-options">
            {FAILURE_TYPES.map((f) => <option key={f} value={f} />)}
          </datalist>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Remarks</div>
          <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save test result"}</button>
      </form>
    </div>
  );
}

// ===== Mix Designs =====

function MixDesignsTab({ setError, setNotice }) {
  const { user } = useAuth();
  const [designs, setDesigns] = useState([]);
  const [creating, setCreating] = useState(false);
  const [editingDesign, setEditingDesign] = useState(null); // full design + admixtures, or null
  const [me, setMe] = useState(null);

  async function load() {
    try {
      setDesigns(await apiRequest("/lab-technician/mix-designs"));
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    // Best-effort: used only to grey out "Approve" on a design this same
    // user created (the backend enforces this regardless).
    try { const t = localStorage.getItem("oorm_user"); if (t) setMe(JSON.parse(t)); } catch { /* ignore */ }
  }, []);

  async function approve(id) {
    setError(""); setNotice("");
    try {
      await apiRequest(`/lab-technician/mix-designs/${id}/approve`, { method: "POST" });
      setNotice("Approved.");
      load();
    } catch (err) { setError(err.message); }
  }

  async function viewPdf(id) {
    try {
      const data = await apiRequest(`/lab-technician/mix-designs/${id}/pdf-data`);
      await generateMixDesignPdf(data);
    } catch (err) { setError(err.message); }
  }

  // Round 132, item 2 — a draft can be edited before it's approved, so a
  // typo doesn't have to be caught only after it's already gone out on a
  // PDF. Fetches the full row (including admixtures — the list endpoint
  // above doesn't return those) so the form opens pre-filled.
  async function startEdit(id) {
    setError("");
    try {
      const full = await apiRequest(`/lab-technician/mix-designs/${id}`);
      setEditingDesign(full);
    } catch (err) { setError(err.message); }
  }

  if (creating) {
    return <MixDesignForm setError={setError} setNotice={setNotice} onDone={() => { setCreating(false); load(); }} onCancel={() => setCreating(false)} />;
  }
  if (editingDesign) {
    return (
      <MixDesignForm
        setError={setError} setNotice={setNotice}
        editingDesign={editingDesign}
        onDone={() => { setEditingDesign(null); load(); }}
        onCancel={() => setEditingDesign(null)}
      />
    );
  }

  return (
    <div>
      <button type="button" className="btn-primary" style={{ marginBottom: 12 }} onClick={() => setCreating(true)}>+ New mix design</button>
      {designs.map((d) => (
        <div key={d.id} className="card" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontWeight: 600 }}>{d.design_ref_code} · {d.mix_grade_name}</div>
              <div style={{ fontSize: 12, color: "var(--slate)" }}>{d.mix_description || "—"}</div>
              <div style={{ fontSize: 11, color: "var(--slate)" }}>f'ck {d.fck_28day_mpa} MPa · target mean {Number(d.target_mean_strength_mpa).toFixed(1)} MPa</div>
              <div style={{ fontSize: 11, color: "var(--slate)" }}>Created by {d.created_by_name} on {fmtDate(d.created_at)}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
              <span className={`badge ${d.status === "approved" ? "badge-success" : "badge-warning"}`}>
                {d.status === "approved" ? "Approved" : "Pending approval"}
              </span>
              {d.is_standard_for_grade && <span className="badge badge-neutral">Standard for {d.mix_grade_name}</span>}
              {Number(d.assigned_customer_count) > 0 && <span className="badge badge-neutral">{d.assigned_customer_count} customer(s)</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {d.status === "draft" && (
              <>
                <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} disabled={me && d.created_by_name === me.name && user?.role !== "administrator"} onClick={() => approve(d.id)}>
                  Approve
                </button>
                <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => startEdit(d.id)}>Edit</button>
              </>
            )}
            {d.status === "approved" && (
              <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => viewPdf(d.id)}>View PDF</button>
            )}
          </div>
        </div>
      ))}
      {designs.length === 0 && <div style={{ fontSize: 13, color: "var(--slate)" }}>No mix designs yet.</div>}
    </div>
  );
}

function MixDesignForm({ setError, setNotice, onDone, onCancel, editingDesign }) {
  const isEditing = !!editingDesign;
  const [form, setForm] = useState(() => editingDesign ? {
    mix_grade_id: editingDesign.mix_grade_id ?? "", design_ref_code: editingDesign.design_ref_code ?? "", mix_description: editingDesign.mix_description ?? "",
    fck_28day_mpa: editingDesign.fck_28day_mpa ?? "", std_deviation_mpa: editingDesign.std_deviation_mpa ?? "4.0", max_agg_size_mm: editingDesign.max_agg_size_mm ?? "20", target_workability_mm: editingDesign.target_workability_mm ?? "", design_density_kgm3: editingDesign.design_density_kgm3 ?? "",
    cement_kgm3: editingDesign.cement_kgm3 ?? "", fly_ash_kgm3: editingDesign.fly_ash_kgm3 ?? "0", free_water_kgm3: editingDesign.free_water_kgm3 ?? "",
    fine_agg_kgm3: editingDesign.fine_agg_kgm3 ?? "", coarse_20mm_kgm3: editingDesign.coarse_20mm_kgm3 ?? "", coarse_12_5mm_kgm3: editingDesign.coarse_12_5mm_kgm3 ?? "",
    cement_type_source: editingDesign.cement_type_source ?? "", cement_sp_gr: editingDesign.cement_sp_gr ?? "3.15",
    fly_ash_type_source: editingDesign.fly_ash_type_source ?? "", fly_ash_sp_gr: editingDesign.fly_ash_sp_gr ?? "",
    fine_agg_type_source: editingDesign.fine_agg_type_source ?? "", fine_agg_sp_gr: editingDesign.fine_agg_sp_gr ?? "2.75",
    coarse_20mm_type_source: editingDesign.coarse_20mm_type_source ?? "", coarse_20mm_sp_gr: editingDesign.coarse_20mm_sp_gr ?? "2.72",
    coarse_12_5mm_type_source: editingDesign.coarse_12_5mm_type_source ?? "", coarse_12_5mm_sp_gr: editingDesign.coarse_12_5mm_sp_gr ?? "2.71",
    fine_moisture_pct: editingDesign.fine_moisture_pct ?? "", fine_absorption_pct: editingDesign.fine_absorption_pct ?? "",
    coarse_20mm_moisture_pct: editingDesign.coarse_20mm_moisture_pct ?? "", coarse_20mm_absorption_pct: editingDesign.coarse_20mm_absorption_pct ?? "",
    coarse_12_5mm_moisture_pct: editingDesign.coarse_12_5mm_moisture_pct ?? "", coarse_12_5mm_absorption_pct: editingDesign.coarse_12_5mm_absorption_pct ?? "",
    notes: editingDesign.notes ?? "",
  } : {
    mix_grade_id: "", design_ref_code: "", mix_description: "",
    fck_28day_mpa: "", std_deviation_mpa: "4.0", max_agg_size_mm: "20", target_workability_mm: "", design_density_kgm3: "",
    cement_kgm3: "", fly_ash_kgm3: "0", free_water_kgm3: "",
    fine_agg_kgm3: "", coarse_20mm_kgm3: "", coarse_12_5mm_kgm3: "",
    cement_type_source: "", cement_sp_gr: "3.15",
    fly_ash_type_source: "", fly_ash_sp_gr: "",
    fine_agg_type_source: "", fine_agg_sp_gr: "2.75",
    coarse_20mm_type_source: "", coarse_20mm_sp_gr: "2.72",
    coarse_12_5mm_type_source: "", coarse_12_5mm_sp_gr: "2.71",
    fine_moisture_pct: "", fine_absorption_pct: "",
    coarse_20mm_moisture_pct: "", coarse_20mm_absorption_pct: "",
    coarse_12_5mm_moisture_pct: "", coarse_12_5mm_absorption_pct: "",
    notes: "",
  });
  const [admixtures, setAdmixtures] = useState(() =>
    editingDesign?.admixtures?.length
      ? editingDesign.admixtures.map((a) => ({ type_brand: a.type_brand, qty_kgm3: a.qty_kgm3, sp_gr: a.sp_gr ?? "" }))
      : [{ type_brand: "", qty_kgm3: "", sp_gr: "" }]
  );
  const [grades, setGrades] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { apiRequest("/master/mix-grades").then(setGrades).catch((err) => setError(err.message)); }, []);

  function set(field, value) { setForm((f) => ({ ...f, [field]: value })); }
  function updateAdmixture(i, field, value) {
    setAdmixtures((as) => as.map((a, idx) => idx === i ? { ...a, [field]: value } : a));
  }

  const targetMean = form.fck_28day_mpa && form.std_deviation_mpa
    ? (Number(form.fck_28day_mpa) + 1.65 * Number(form.std_deviation_mpa)).toFixed(1)
    : null;
  const totalBinder = (Number(form.cement_kgm3) || 0) + (Number(form.fly_ash_kgm3) || 0);
  const wbRatio = totalBinder ? (Number(form.free_water_kgm3) / totalBinder).toFixed(3) : null;
  const flyAshPct = totalBinder && form.fly_ash_kgm3 ? ((Number(form.fly_ash_kgm3) / totalBinder) * 100).toFixed(1) : null;
  const totalAggregate = (Number(form.fine_agg_kgm3) || 0) + (Number(form.coarse_20mm_kgm3) || 0) + (Number(form.coarse_12_5mm_kgm3) || 0);
  const totalAdmixture = admixtures.reduce((sum, a) => sum + (Number(a.qty_kgm3) || 0), 0);
  const densitySum = totalBinder + (Number(form.free_water_kgm3) || 0) + totalAggregate + totalAdmixture;

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      if (isEditing) {
        await apiRequest(`/lab-technician/mix-designs/${editingDesign.id}`, {
          method: "PATCH",
          body: { ...form, admixtures: admixtures.filter((a) => a.type_brand && a.qty_kgm3) },
        });
        setNotice("Mix design updated.");
      } else {
        await apiRequest("/lab-technician/mix-designs", {
          method: "POST",
          body: { ...form, admixtures: admixtures.filter((a) => a.type_brand && a.qty_kgm3) },
        });
        setNotice("Mix design saved as draft.");
      }
      onDone();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
      <button type="button" onClick={onCancel} style={{ alignSelf: "flex-start" }}>← Cancel</button>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Identification</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <div style={{ color: "var(--slate)" }}>Mix grade</div>
            <select value={form.mix_grade_id} onChange={(e) => set("mix_grade_id", e.target.value)} required>
              <option value="">Select</option>
              {grades.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>Design ref. code</div>
            <input value={form.design_ref_code} onChange={(e) => set("design_ref_code", e.target.value)} required />
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <div style={{ color: "var(--slate)" }}>Mix description</div>
          <input value={form.mix_description} onChange={(e) => set("mix_description", e.target.value)} placeholder="e.g. M25 (OPC + Fly Ash) 340Kg" />
        </div>
        <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 8 }}>
          Not assigned to any customer here — assign it to one or more customers afterward from Approved Mix Assignments.
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Strength &amp; workability</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <div><div style={{ color: "var(--slate)" }}>f'ck, 28-day</div><input type="number" step="0.1" value={form.fck_28day_mpa} onChange={(e) => set("fck_28day_mpa", e.target.value)} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Std. deviation</div><input type="number" step="0.1" value={form.std_deviation_mpa} onChange={(e) => set("std_deviation_mpa", e.target.value)} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Max agg. size (mm)</div><input type="number" value={form.max_agg_size_mm} onChange={(e) => set("max_agg_size_mm", e.target.value)} /></div>
        </div>
        {targetMean && (
          <div style={{ background: "var(--info-bg, #E3EEF4)", borderRadius: 8, padding: "8px 10px", marginTop: 8 }}>
            Target mean strength (f'ck + 1.65σ): <b>{targetMean} MPa</b>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          <div><div style={{ color: "var(--slate)" }}>Target workability</div><input value={form.target_workability_mm} onChange={(e) => set("target_workability_mm", e.target.value)} placeholder="100 ± 25 mm" /></div>
          <div><div style={{ color: "var(--slate)" }}>Design density (kg/m³)</div><input type="number" value={form.design_density_kgm3} onChange={(e) => set("design_density_kgm3", e.target.value)} /></div>
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Mix proportions (SSD, per m³)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div><div style={{ color: "var(--slate)" }}>Cement (kg/m³)</div><input type="number" value={form.cement_kgm3} onChange={(e) => set("cement_kgm3", e.target.value)} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Fly ash (kg/m³)</div><input type="number" value={form.fly_ash_kgm3} onChange={(e) => set("fly_ash_kgm3", e.target.value)} /></div>
        </div>
        <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>
          Total binder: {totalBinder.toFixed(1)} kg/m³{wbRatio && ` · W/B ratio: ${wbRatio}`}{flyAshPct && ` · Fly ash: ${flyAshPct}% of binder`}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          <div><div style={{ color: "var(--slate)" }}>Free water (kg/m³)</div><input type="number" value={form.free_water_kgm3} onChange={(e) => set("free_water_kgm3", e.target.value)} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Fine aggregate (kg/m³)</div><input type="number" value={form.fine_agg_kgm3} onChange={(e) => set("fine_agg_kgm3", e.target.value)} required /></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          <div><div style={{ color: "var(--slate)" }}>Coarse 20mm (kg/m³)</div><input type="number" value={form.coarse_20mm_kgm3} onChange={(e) => set("coarse_20mm_kgm3", e.target.value)} required /></div>
          <div><div style={{ color: "var(--slate)" }}>Coarse 12.5mm (kg/m³)</div><input type="number" value={form.coarse_12_5mm_kgm3} onChange={(e) => set("coarse_12_5mm_kgm3", e.target.value)} required /></div>
        </div>
        <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>Total aggregate: {totalAggregate.toFixed(1)} kg/m³</div>
        {form.design_density_kgm3 && (
          <div style={{ fontSize: 11, color: Math.abs(densitySum - Number(form.design_density_kgm3)) > 30 ? "var(--alert-red)" : "var(--signal-green)", marginTop: 4 }}>
            Binder + water + aggregate + admixture = {densitySum.toFixed(1)} kg/m³ vs. design density {form.design_density_kgm3} kg/m³
            {Math.abs(densitySum - Number(form.design_density_kgm3)) > 30 ? " — check your figures" : " ✓"}
          </div>
        )}
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Admixtures</div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 6, fontSize: 11, color: "var(--slate)", marginBottom: 2 }}>
          <div>Type / brand</div><div>kg/m³</div><div>Sp. gr.</div><div>% of binder</div>
        </div>
        {admixtures.map((a, i) => {
          const dosagePct = totalBinder && a.qty_kgm3 ? ((Number(a.qty_kgm3) / totalBinder) * 100).toFixed(2) : null;
          return (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 6, marginBottom: 6, alignItems: "center" }}>
              <input placeholder="Type / brand" value={a.type_brand} onChange={(e) => updateAdmixture(i, "type_brand", e.target.value)} />
              <input type="number" step="0.01" placeholder="kg/m³" value={a.qty_kgm3} onChange={(e) => updateAdmixture(i, "qty_kgm3", e.target.value)} />
              <input type="number" step="0.01" placeholder="Sp. gr." value={a.sp_gr} onChange={(e) => updateAdmixture(i, "sp_gr", e.target.value)} />
              <div style={{ fontSize: 12.5, color: dosagePct ? "var(--charcoal)" : "var(--slate)" }}>
                {dosagePct ? `${dosagePct}%` : "—"}
              </div>
            </div>
          );
        })}
        <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 6 }}>
          Calculated automatically from quantity ÷ total binder ({totalBinder ? totalBinder.toFixed(1) : "—"} kg/m³) — not typed in.
        </div>
        <button type="button" style={{ fontSize: 12 }} onClick={() => setAdmixtures((as) => [...as, { type_brand: "", qty_kgm3: "", sp_gr: "" }])}>
          + Add another admixture
        </button>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Aggregate moisture &amp; absorption <span style={{ fontWeight: 400, color: "var(--slate)" }}>— baseline only</span></div>
        {[
          ["Fine — M-Sand", "fine_moisture_pct", "fine_absorption_pct"],
          ["Coarse — 20mm", "coarse_20mm_moisture_pct", "coarse_20mm_absorption_pct"],
          ["Coarse — 12.5mm", "coarse_12_5mm_moisture_pct", "coarse_12_5mm_absorption_pct"],
        ].map(([label, mKey, aKey]) => (
          <div key={mKey} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 6, alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 12 }}>{label}</div>
            <input type="number" step="0.1" placeholder="Moisture %" value={form[mKey]} onChange={(e) => set(mKey, e.target.value)} />
            <input type="number" step="0.1" placeholder="Absorption %" value={form[aKey]} onChange={(e) => set(aKey, e.target.value)} />
          </div>
        ))}
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Materials — type / source / sp. gr.</div>
        {[
          ["Cement", "cement_type_source", "cement_sp_gr"],
          ["Fly ash (SCM)", "fly_ash_type_source", "fly_ash_sp_gr"],
          ["Fine aggregate", "fine_agg_type_source", "fine_agg_sp_gr"],
          ["Coarse 20mm", "coarse_20mm_type_source", "coarse_20mm_sp_gr"],
          ["Coarse 12.5mm", "coarse_12_5mm_type_source", "coarse_12_5mm_sp_gr"],
        ].map(([label, tKey, sKey]) => (
          <div key={tKey} style={{ display: "grid", gridTemplateColumns: "1.1fr 1.6fr 0.7fr", gap: 6, alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 12 }}>{label}</div>
            <input placeholder="Type / source" value={form[tKey]} onChange={(e) => set(tKey, e.target.value)} />
            <input type="number" step="0.01" placeholder="Sp. gr." value={form[sKey]} onChange={(e) => set(sKey, e.target.value)} />
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <div style={{ color: "var(--slate)" }}>Notes</div>
          <textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </div>
      </div>

      <button type="submit" className="btn-primary" disabled={saving}>
        {saving ? "Saving..." : isEditing ? "Save changes" : "Save as draft"}
      </button>
      <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center" }}>
        {isEditing ? "Still a draft until a second person approves it." : "Draft designs show \"Pending approval\" until a second person approves them."}
      </div>
    </form>
  );
}
