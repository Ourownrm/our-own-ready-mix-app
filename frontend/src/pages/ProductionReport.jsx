import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";

const STATUS_OPTIONS = ["All", "Signed", "Pending", "Refused"];
const FILTER_KEYS = ["customer_id", "site_id", "truck_id", "driver_id", "salesperson_id", "pump_id", "supervisor_id"];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function formatDate(d) {
  if (!d) return "–";
  return new Date(d).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}
function inr(value) {
  if (value === null || value === undefined || value === "") return "–";
  return `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
function sumQty(rows) {
  return rows.reduce((s, r) => s + Number(r.quantity_m3 || 0), 0).toFixed(2);
}
function sumAmount(rows) {
  return rows.reduce((s, r) => s + Number(r.amount || 0), 0).toFixed(2);
}

export default function ProductionReport() {
  const [customers, setCustomers] = useState([]);
  const [sites, setSites] = useState([]);
  const [trucks, setTrucks] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [salespersons, setSalespersons] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [supervisors, setSupervisors] = useState([]);

  const [filters, setFilters] = useState({
    from_date: todayStr(), to_date: todayStr(),
    customer_id: "", site_id: "", truck_id: "", driver_id: "",
    salesperson_id: "", pump_id: "", supervisor_id: "",
  });
  const [statusFilter, setStatusFilter] = useState(new Set(["All"]));

  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState("");
  const [error, setError] = useState("");
  const [generated, setGenerated] = useState(false);

  useEffect(() => {
    Promise.all([
      apiRequest("/master/customers"), apiRequest("/master/sites"),
      apiRequest("/master/trucks"), apiRequest("/master/drivers"),
      apiRequest("/master/salespersons"), apiRequest("/master/pumps"),
      apiRequest("/master/site-supervisors"),
    ]).then(([c, s, t, d, sp, p, sup]) => {
      setCustomers(c); setSites(s); setTrucks(t); setDrivers(d);
      setSalespersons(sp); setPumps(p); setSupervisors(sup);
    }).catch((err) => setError(err.message));
  }, []);

  const sitesForCustomer = filters.customer_id
    ? sites.filter((s) => String(s.customer_id) === String(filters.customer_id))
    : sites;

  function set(key, value) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  function toggleStatus(opt) {
    setStatusFilter((prev) => {
      if (opt === "All") return new Set(["All"]);
      const next = new Set(prev);
      next.delete("All");
      if (next.has(opt)) next.delete(opt); else next.add(opt);
      return next.size === 0 ? new Set(["All"]) : next;
    });
  }

  function buildQuery(pageNum) {
    const params = new URLSearchParams();
    params.set("from_date", filters.from_date);
    params.set("to_date", filters.to_date);
    for (const key of FILTER_KEYS) {
      if (filters[key]) params.set(key, filters[key]);
    }
    if (!statusFilter.has("All")) {
      params.set("delivery_note_status", Array.from(statusFilter).join(","));
    }
    if (pageNum) params.set("page", pageNum);
    return params.toString();
  }

  async function generate(pageNum = 1) {
    if (!filters.from_date || !filters.to_date) {
      setError("Pick both a from date and a to date.");
      return;
    }
    setLoading(true); setError("");
    try {
      const data = await apiRequest(`/production-report?${buildQuery(pageNum)}`);
      setResult(data);
      setPage(pageNum);
      setGenerated(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function resetFilters() {
    setFilters({
      from_date: todayStr(), to_date: todayStr(),
      customer_id: "", site_id: "", truck_id: "", driver_id: "",
      salesperson_id: "", pump_id: "", supervisor_id: "",
    });
    setStatusFilter(new Set(["All"]));
    setResult(null);
    setGenerated(false);
    setError("");
  }

  function filterSummaryLines() {
    const lines = [`Date range: ${formatDate(filters.from_date)} to ${formatDate(filters.to_date)}`];
    const name = (list, id, field) => list.find((x) => String(x.id) === String(id))?.[field];
    const c = name(customers, filters.customer_id, "name"); if (c) lines.push(`Customer: ${c}`);
    const s = name(sites, filters.site_id, "name"); if (s) lines.push(`Site: ${s}`);
    const t = name(trucks, filters.truck_id, "truck_number"); if (t) lines.push(`Truck: ${t}`);
    const d = name(drivers, filters.driver_id, "name"); if (d) lines.push(`Driver: ${d}`);
    const sp = name(salespersons, filters.salesperson_id, "name"); if (sp) lines.push(`Salesperson: ${sp}`);
    const p = name(pumps, filters.pump_id, "pump_code"); if (p) lines.push(`Pump: ${p}`);
    const sup = name(supervisors, filters.supervisor_id, "name"); if (sup) lines.push(`Site supervisor: ${sup}`);
    if (!statusFilter.has("All")) lines.push(`Delivery note status: ${Array.from(statusFilter).join(", ")}`);
    return lines;
  }

  async function fetchExportRows() {
    return apiRequest(`/production-report/export?${buildQuery()}`);
  }

  async function exportPdf() {
    setExporting("pdf"); setError("");
    try {
      const rows = await fetchExportRows();
      if (rows.length === 0) { setError("Nothing to export for these filters."); return; }
      const { jsPDF } = await import("jspdf");
      await import("jspdf-autotable");
      const doc = new jsPDF({ orientation: "landscape" });
      doc.setFontSize(14);
      doc.text("Our Own Ready Mix", 14, 14);
      doc.setFontSize(11);
      doc.text("Production Report", 14, 21);
      doc.setFontSize(8);
      const lines = filterSummaryLines();
      lines.forEach((line, i) => doc.text(line, 14, 27 + i * 4));
      doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 27 + lines.length * 4);

      doc.autoTable({
        startY: 31 + lines.length * 4,
        head: [["Date", "DC No.", "Customer", "Site", "Truck", "Driver", "Sales Person", "Pump", "Supervisor", "Grade", "Qty (m³)", "Rate", "Amount", "Status"]],
        body: rows.map((r) => [
          formatDate(r.ticket_date), r.dc_no, r.customer_name, r.site_name, r.truck_number, r.driver_name,
          r.salesperson_name || "–", r.pump_code || "–", r.supervisor_name || "–", r.grade_name,
          r.quantity_m3, r.rate ?? "–", r.amount != null ? inr(r.amount) : "–", r.delivery_note_status || "–",
        ]),
        foot: [["", "", "", "", "", "", "", "", "", "Total", sumQty(rows), "", inr(sumAmount(rows)), `${rows.length} deliveries`]],
        styles: { fontSize: 7 },
        headStyles: { fillColor: [199, 91, 18] },
      });
      doc.save(`Production_Report_${filters.from_date}to${filters.to_date}.pdf`);
    } catch (err) {
      setError(err.message || "Couldn't export PDF.");
    } finally {
      setExporting("");
    }
  }

  async function exportExcel() {
    setExporting("xlsx"); setError("");
    try {
      const rows = await fetchExportRows();
      if (rows.length === 0) { setError("Nothing to export for these filters."); return; }
      const XLSX = await import("xlsx");
      const sheetRows = rows.map((r) => ({
        Date: formatDate(r.ticket_date), "DC No.": r.dc_no, Customer: r.customer_name, Site: r.site_name,
        Truck: r.truck_number, Driver: r.driver_name, "Sales Person": r.salesperson_name || "",
        Pump: r.pump_code || "", Supervisor: r.supervisor_name || "", Grade: r.grade_name,
        "Quantity (m³)": Number(r.quantity_m3), Rate: r.rate != null ? Number(r.rate) : "",
        Amount: r.amount != null ? Number(r.amount) : "", "Delivery Note Status": r.delivery_note_status || "",
      }));
      sheetRows.push({
        Date: "", "DC No.": "", Customer: "", Site: "", Truck: "", Driver: "", "Sales Person": "",
        Pump: "", Supervisor: "", Grade: "Total", "Quantity (m³)": Number(sumQty(rows)),
        Rate: "", Amount: Number(sumAmount(rows)), "Delivery Note Status": `${rows.length} deliveries`,
      });
      const ws = XLSX.utils.json_to_sheet(sheetRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Production Report");
      XLSX.writeFile(wb, `Production_Report_${filters.from_date}to${filters.to_date}.xlsx`);
    } catch (err) {
      setError(err.message || "Couldn't export Excel.");
    } finally {
      setExporting("");
    }
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.totals.delivery_count / result.page_size)) : 1;
  const canExport = generated && result && result.totals.delivery_count > 0 && !exporting;

  return (
    <>
      <TopBar title="Production Report" />
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Filters</div>
          <div className="field-input" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, fontSize: 13 }}>
            <div>
              <div style={{ color: "var(--slate)" }}>From date</div>
              <input type="date" value={filters.from_date} onChange={(e) => set("from_date", e.target.value)} />
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>To date</div>
              <input type="date" value={filters.to_date} onChange={(e) => set("to_date", e.target.value)} />
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Customer</div>
              <select value={filters.customer_id} onChange={(e) => { set("customer_id", e.target.value); set("site_id", ""); }}>
                <option value="">All</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Site</div>
              <select value={filters.site_id} onChange={(e) => set("site_id", e.target.value)}>
                <option value="">All</option>
                {sitesForCustomer.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Truck</div>
              <select value={filters.truck_id} onChange={(e) => set("truck_id", e.target.value)}>
                <option value="">All</option>
                {trucks.map((t) => <option key={t.id} value={t.id}>{t.truck_number}</option>)}
              </select>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Driver</div>
              <select value={filters.driver_id} onChange={(e) => set("driver_id", e.target.value)}>
                <option value="">All</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Salesperson</div>
              <select value={filters.salesperson_id} onChange={(e) => set("salesperson_id", e.target.value)}>
                <option value="">All</option>
                {salespersons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Pump</div>
              <select value={filters.pump_id} onChange={(e) => set("pump_id", e.target.value)}>
                <option value="">All</option>
                {pumps.map((p) => <option key={p.id} value={p.id}>{p.pump_code}</option>)}
              </select>
            </div>
            <div>
              <div style={{ color: "var(--slate)" }}>Site supervisor</div>
              <select value={filters.supervisor_id} onChange={(e) => set("supervisor_id", e.target.value)}>
                <option value="">All</option>
                {supervisors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={{ color: "var(--slate)", fontSize: 13, marginBottom: 6 }}>Delivery note status</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {STATUS_OPTIONS.map((opt) => {
                const active = statusFilter.has(opt);
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => toggleStatus(opt)}
                    style={{
                      padding: "5px 12px", borderRadius: 999, fontSize: 12,
                      border: active ? "1px solid var(--rebar)" : "1px solid var(--border, #ccc)",
                      background: active ? "var(--concrete)" : "transparent",
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button className="btn-primary" onClick={() => generate(1)} disabled={loading}>
              {loading ? "Generating..." : "Generate report"}
            </button>
            <button type="button" onClick={resetFilters}>Reset filters</button>
          </div>
        </div>

        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {generated && result ? `${result.totals.delivery_count} deliveries` : "Results"}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={exportPdf} disabled={!canExport}>
                {exporting === "pdf" ? "Exporting..." : "Export PDF"}
              </button>
              <button type="button" onClick={exportExcel} disabled={!canExport}>
                {exporting === "xlsx" ? "Exporting..." : "Export Excel"}
              </button>
            </div>
          </div>

          {!generated && <div style={{ fontSize: 13, color: "var(--slate)" }}>Set your filters and click "Generate report."</div>}
          {loading && <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>}
          {generated && !loading && result && result.rows.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>No deliveries match these filters.</div>
          )}

          {generated && !loading && result && result.rows.length > 0 && (
            <>
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Date</th><th>DC No.</th><th>Customer</th><th>Site</th><th>Truck</th><th>Driver</th>
                      <th>Sales Person</th><th>Pump</th><th>Supervisor</th><th>Grade</th><th>Quantity</th>
                      <th>Rate</th><th>Amount</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r) => (
                      <tr key={r.id}>
                        <td>{formatDate(r.ticket_date)}</td>
                        <td>{r.dc_no}</td>
                        <td>{r.customer_name}</td>
                        <td>{r.site_name}</td>
                        <td>{r.truck_number}</td>
                        <td>{r.driver_name}</td>
                        <td>{r.salesperson_name || "–"}</td>
                        <td>{r.pump_code || "–"}</td>
                        <td>{r.supervisor_name || "–"}</td>
                        <td>{r.grade_name}</td>
                        <td>{r.quantity_m3} m³</td>
                        <td>{r.rate != null ? inr(r.rate) : "–"}</td>
                        <td>{r.amount != null ? inr(r.amount) : "–"}</td>
                        <td>{r.delivery_note_status || "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 600 }}>
                      <td colSpan={10}>Totals ({result.totals.delivery_count} deliveries)</td>
                      <td>{result.totals.total_qty_m3} m³</td>
                      <td></td>
                      <td>{inr(result.totals.total_amount)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {totalPages > 1 && (
                <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12, marginTop: 12, fontSize: 13 }}>
                  <button type="button" disabled={page <= 1} onClick={() => generate(page - 1)}>Previous</button>
                  <span>Page {page} of {totalPages}</span>
                  <button type="button" disabled={page >= totalPages} onClick={() => generate(page + 1)}>Next</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
