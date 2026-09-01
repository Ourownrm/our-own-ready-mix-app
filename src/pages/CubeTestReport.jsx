// Cube test summary report (round 118) — a configurable, cross-batch table
// over every cube_test_results row, filterable by date range, customer,
// grade, and mix design ref code. Restricted to Lab Technician and
// Administrator only (see backend route + App.jsx ProtectedRoute) — unlike
// the single-batch detail in LabTechnician.jsx, this is a reporting view
// across the whole plant's testing history, so it's gated more narrowly.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { generateCubeTestPdf } from "../lib/cubeTestPdf.js";
import { formatOrderNumber } from "../lib/orderNumber.js";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function monthStartStr() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

const EMPTY_FILTERS = { from_date: monthStartStr(), to_date: todayStr(), customer_id: "", mix_grade_id: "", design_ref_code: "", testing_age_days: "" };

export default function CubeTestReport() {
  const [customers, setCustomers] = useState([]);
  const [grades, setGrades] = useState([]);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  // Round 120, item 4d — "pour-based reporting" scoped as a display-only
  // grouping over the existing flat result set (see the backend route's own
  // comment) — toggles between one row per test and one group per order/pour.
  const [groupByPour, setGroupByPour] = useState(false);

  useEffect(() => {
    Promise.all([apiRequest("/master/customers"), apiRequest("/master/mix-grades")])
      .then(([c, g]) => { setCustomers(c); setGrades(g); })
      .catch((err) => setError(err.message));
  }, []);

  function buildParams() {
    const params = new URLSearchParams(filters);
    Object.keys(filters).forEach((k) => { if (!filters[k]) params.delete(k); });
    return params;
  }

  async function runReport() {
    setLoading(true); setError("");
    try {
      setRows(await apiRequest(`/lab-technician/cube-test-report?${buildParams().toString()}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { runReport(); }, []); // run once with the default (this-month) range on load

  // Round 120, items 4b/4e — `source` ('plant' | 'site') picks which
  // pdf-data endpoint this result actually lives behind, since plant-cast
  // and site-cast results are two separate tables with their own id spaces.
  async function viewPdf(row) {
    try {
      const path = row.source === "site" ? `/lab-technician/site-cube-tests/${row.id}/pdf-data` : `/lab-technician/cube-tests/${row.id}/pdf-data`;
      const data = await apiRequest(path);
      await generateCubeTestPdf(data);
    } catch (err) { setError(err.message); }
  }

  // Round 120, item 4d — groups the same flat rows by order_id for the
  // "group by pour" view; each group also flags whether it already has both
  // a 7-day and 28-day result (same-day-or-not doesn't matter here — this is
  // the staff-facing report, not the customer-facing combine decision, which
  // lives in CustomerPortal.jsx/cubeTestPdf.js's generateCombinedCubeTestPdf).
  const grouped = useMemo(() => {
    if (!rows) return [];
    const byOrder = new Map();
    for (const r of rows) {
      if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
      byOrder.get(r.order_id).push(r);
    }
    return [...byOrder.entries()].map(([orderId, results]) => ({ orderId, results }));
  }, [rows]);

  async function exportExcel() {
    if (!rows || rows.length === 0) { setError("Nothing to export for these filters."); return; }
    setExporting(true); setError("");
    try {
      const XLSX = await import("xlsx");
      const sheetRows = rows.map((r) => ({
        "Test Date": fmtDate(r.tested_at),
        "Casting Date": fmtDate(r.cast_at),
        Source: r.source === "site" ? "Site cast" : "Plant cast",
        "Order": formatOrderNumber(r.order_id),
        "Ticket No.": r.ticket_number || "",
        Customer: r.customer_name,
        Site: r.site_name,
        Grade: r.mix_grade_name,
        "Design Ref": r.design_ref_code || "",
        "Testing Age (days)": r.testing_age_days,
        "Avg Strength (N/mm2)": r.average_strength_mpa,
        "f'ck (MPa)": r.fck_28day_mpa ?? "",
        "Meets Target": r.meets_target === null || r.meets_target === undefined ? "" : (r.meets_target ? "Yes" : "No"),
        "Avg Load (kN)": r.average_load_kn,
        "Avg Density (kg/m3)": r.average_density_kgm3,
        "Type of Failure": r.failure_type || "",
        "Tested By": r.tested_by_name,
      }));
      const ws = XLSX.utils.json_to_sheet(sheetRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Cube Test Report");
      XLSX.writeFile(wb, `Cube_Test_Report_${filters.from_date || "all"}_to_${filters.to_date || "all"}.xlsx`);
    } catch (err) {
      setError(err.message || "Couldn't export Excel.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <TopBar title="Cube Test Report" />
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="card field-input" style={{ marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", fontSize: 13 }}>
          <div>
            <div style={{ color: "var(--slate)" }}>From</div>
            <input type="date" value={filters.from_date} onChange={(e) => setFilters({ ...filters, from_date: e.target.value })} />
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>To</div>
            <input type="date" value={filters.to_date} onChange={(e) => setFilters({ ...filters, to_date: e.target.value })} />
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>Customer</div>
            <select value={filters.customer_id} onChange={(e) => setFilters({ ...filters, customer_id: e.target.value })}>
              <option value="">All</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>Grade</div>
            <select value={filters.mix_grade_id} onChange={(e) => setFilters({ ...filters, mix_grade_id: e.target.value })}>
              <option value="">All</option>
              {grades.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>Design ref code</div>
            <input type="text" placeholder="e.g. OR20F207" value={filters.design_ref_code} onChange={(e) => setFilters({ ...filters, design_ref_code: e.target.value })} style={{ width: 130 }} />
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>Testing age</div>
            <select value={filters.testing_age_days} onChange={(e) => setFilters({ ...filters, testing_age_days: e.target.value })}>
              <option value="">Both</option>
              <option value="7">7-day</option>
              <option value="28">28-day</option>
            </select>
          </div>
          <button onClick={runReport} disabled={loading}>{loading ? "Loading..." : "Run report"}</button>
          <button onClick={exportExcel} disabled={exporting || !rows || rows.length === 0}>{exporting ? "Exporting..." : "Export Excel"}</button>
          <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12.5 }}>
            <input type="checkbox" checked={groupByPour} onChange={(e) => setGroupByPour(e.target.checked)} />
            Group by pour
          </label>
        </div>

        {error && <div style={{ color: "var(--alert-red)", marginBottom: 12 }}>{error}</div>}

        {rows && !groupByPour && (
          <div className="card" style={{ overflowX: "auto" }}>
            <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 8 }}>
              {rows.length} result{rows.length === 1 ? "" : "s"}{rows.length === 1000 ? " (showing first 1000 — narrow the filters for a complete list)" : ""}
            </div>
            <table style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Test Date</th><th>Order</th><th>Source</th><th>Customer</th><th>Site</th><th>Grade</th><th>Design Ref</th>
                  <th>Age</th><th>Avg Strength</th><th>Result</th><th>Failure</th><th>Tested By</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.source}-${r.id}`}>
                    <td>{fmtDate(r.tested_at)}</td>
                    <td>{formatOrderNumber(r.order_id)}</td>
                    <td><span className={`badge ${r.source === "site" ? "badge-warning" : "badge-neutral"}`}>{r.source === "site" ? "Site" : "Plant"}</span></td>
                    <td>{r.customer_name}</td>
                    <td>{r.site_name}</td>
                    <td>{r.mix_grade_name}</td>
                    <td>{r.design_ref_code || "—"}</td>
                    <td>{r.testing_age_days}d</td>
                    <td>{Number(r.average_strength_mpa).toFixed(1)} N/mm²</td>
                    <td>
                      {r.meets_target === null || r.meets_target === undefined
                        ? <span style={{ color: "var(--slate)" }}>—</span>
                        : <span className={`badge ${r.meets_target ? "badge-success" : "badge-danger"}`}>{r.meets_target ? "Pass" : "Below target"}</span>}
                    </td>
                    <td>{r.failure_type || "—"}</td>
                    <td>{r.tested_by_name}</td>
                    <td><button type="button" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => viewPdf(r)}>PDF</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <div style={{ fontSize: 13, color: "var(--slate)", padding: "8px 0" }}>No cube test results match these filters.</div>}
          </div>
        )}

        {rows && groupByPour && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {grouped.map((g) => (
              <div key={g.orderId} className="card">
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                  {formatOrderNumber(g.orderId)} — {g.results[0].customer_name} — {g.results[0].site_name}
                </div>
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr><th>Test Date</th><th>Source</th><th>Age</th><th>Avg Strength</th><th>Result</th><th></th></tr>
                  </thead>
                  <tbody>
                    {g.results.map((r) => (
                      <tr key={`${r.source}-${r.id}`}>
                        <td>{fmtDate(r.tested_at)}</td>
                        <td><span className={`badge ${r.source === "site" ? "badge-warning" : "badge-neutral"}`}>{r.source === "site" ? "Site" : "Plant"}</span></td>
                        <td>{r.testing_age_days}d</td>
                        <td>{Number(r.average_strength_mpa).toFixed(1)} N/mm²</td>
                        <td>
                          {r.meets_target === null || r.meets_target === undefined
                            ? <span style={{ color: "var(--slate)" }}>—</span>
                            : <span className={`badge ${r.meets_target ? "badge-success" : "badge-danger"}`}>{r.meets_target ? "Pass" : "Below target"}</span>}
                        </td>
                        <td><button type="button" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => viewPdf(r)}>PDF</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {grouped.length === 0 && <div style={{ fontSize: 13, color: "var(--slate)" }}>No cube test results match these filters.</div>}
          </div>
        )}
      </div>
    </>
  );
}
