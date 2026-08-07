import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function formatDateTime(d) {
  if (!d) return "–";
  return new Date(d).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function sumAmount(rows) {
  return rows.reduce((s, r) => s + Number(r.amount || 0), 0).toFixed(2);
}

export default function TripAllowanceReport() {
  const [drivers, setDrivers] = useState([]);
  const [filters, setFilters] = useState({ from_date: todayStr(), to_date: todayStr(), driver_id: "" });
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/master/drivers").then(setDrivers).catch((err) => setError(err.message));
  }, []);

  async function runReport(newPage = 1) {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ ...filters, page: newPage, page_size: 100 });
      Object.keys(filters).forEach((k) => { if (!filters[k]) params.delete(k); });
      const data = await apiRequest(`/accountant/trip-allowance-report?${params.toString()}`);
      setResult(data);
      setPage(newPage);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function fetchExportRows() {
    const params = new URLSearchParams(filters);
    Object.keys(filters).forEach((k) => { if (!filters[k]) params.delete(k); });
    return apiRequest(`/accountant/trip-allowance-report/export?${params.toString()}`);
  }

  async function exportPdf() {
    setExporting("pdf"); setError("");
    try {
      const rows = await fetchExportRows();
      if (rows.length === 0) { setError("Nothing to export for these filters."); return; }
      const [{ default: jsPDF }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
      const doc = new jsPDF();
      doc.setFontSize(14);
      doc.text("Our Own Ready Mix — Driver Trip Allowance Report", 14, 15);
      doc.setFontSize(9);
      doc.text(`${filters.from_date} to ${filters.to_date}`, 14, 21);
      doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 26);

      doc.autoTable({
        startY: 30,
        head: [["Date", "DC No.", "Driver", "Truck", "Customer", "Site", "Qty (m³)", "Allowance"]],
        body: rows.map((r) => [
          formatDateTime(r.earned_at), r.ticket_number, r.driver_name, r.truck_number || "–",
          r.customer_name, r.site_name, r.loaded_quantity_m3, `Rs. ${r.amount}`,
        ]),
        foot: [["", "", "", "", "", "Total", "", `Rs. ${sumAmount(rows)}`]],
        styles: { fontSize: 8, overflow: "linebreak" },
        headStyles: { fillColor: [199, 91, 18] },
        rowPageBreak: "avoid",
      });
      doc.save(`Trip_Allowance_Report_${filters.from_date}to${filters.to_date}.pdf`);
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
        Date: formatDateTime(r.earned_at), "DC No.": r.ticket_number, Driver: r.driver_name,
        Truck: r.truck_number || "", Customer: r.customer_name, Site: r.site_name,
        "Quantity (m³)": r.loaded_quantity_m3, "Allowance (Rs.)": r.amount, "Paid out": r.paid_out ? "Yes" : "No",
      }));
      const ws = XLSX.utils.json_to_sheet(sheetRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Trip Allowances");
      XLSX.writeFile(wb, `Trip_Allowance_Report_${filters.from_date}to${filters.to_date}.xlsx`);
    } catch (err) {
      setError(err.message || "Couldn't export Excel.");
    } finally {
      setExporting("");
    }
  }

  return (
    <>
      <TopBar title="Driver trip allowance report" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
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
            <div style={{ color: "var(--slate)" }}>Driver</div>
            <select value={filters.driver_id} onChange={(e) => setFilters({ ...filters, driver_id: e.target.value })}>
              <option value="">All</option>
              {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <button onClick={() => runReport(1)} disabled={loading}>{loading ? "Loading..." : "Run report"}</button>
          <button onClick={exportPdf} disabled={exporting !== ""}>{exporting === "pdf" ? "Exporting..." : "Export PDF"}</button>
          <button onClick={exportExcel} disabled={exporting !== ""}>{exporting === "xlsx" ? "Exporting..." : "Export Excel"}</button>
        </div>

        {error && <div style={{ color: "var(--alert-red)", marginBottom: 12 }}>{error}</div>}

        {result && (
          <div className="card" style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 12 }}>
              <thead>
                <tr><th>Date</th><th>DC No.</th><th>Driver</th><th>Truck</th><th>Customer</th><th>Site</th><th>Qty</th><th>Allowance</th></tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDateTime(r.earned_at)}</td>
                    <td>{r.ticket_number}</td>
                    <td>{r.driver_name}</td>
                    <td>{r.truck_number || "–"}</td>
                    <td>{r.customer_name}</td>
                    <td>{r.site_name}</td>
                    <td>{r.loaded_quantity_m3} m³</td>
                    <td>₹{r.amount}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600 }}>
                  <td colSpan={6}>Totals ({result.totals.trip_count} trips)</td>
                  <td></td>
                  <td>₹{result.totals.total_amount}</td>
                </tr>
              </tfoot>
            </table>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button disabled={page <= 1 || loading} onClick={() => runReport(page - 1)}>Previous</button>
              <span style={{ fontSize: 12, alignSelf: "center" }}>Page {page}</span>
              <button disabled={result.rows.length < result.page_size || loading} onClick={() => runReport(page + 1)}>Next</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
