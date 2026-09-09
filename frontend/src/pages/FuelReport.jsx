import { useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function formatDateTime(d) {
  if (!d) return "–";
  return new Date(d).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
// Round 138, item 1 — Stock (purchase) rows are normalized server-side onto
// the same column shape as the existing fuel/lubricant issue rows (see
// supplyRequests.js's STOCK_REPORT_COLUMNS), but a vehicle/machine doesn't
// apply to a Store purchase — a supplier does — so this needs to branch.
function unitLabel(r) {
  if (r.source === "stock") return r.supplier_name || "–";
  return r.truck_number || r.pump_code || r.equipment_name || "–";
}
// For an issue row, "Station/Lubricant" already meant "fuel station, or
// which lubricant". For a stock row there's no station (nothing left the
// plant), only the item being restocked — server-side, lubricant_type_name
// already carries "Diesel (Plant Store)" for a fuel stock row, so this just
// picks the right field per source.
function itemLabel(r) {
  if (r.source === "stock") return r.lubricant_type_name || "–";
  return r.request_type === "fuel" ? (r.station_name || "–") : (r.lubricant_type_name || "–");
}
function refNumber(r) {
  if (r.source === "stock") return `STK-${r.id}`;
  return `${r.request_type === "fuel" ? "FR" : "LR"}-${r.id}`;
}
function sumQty(rows, type) {
  return rows.filter((r) => r.request_type === type).reduce((s, r) => s + Number(r.actual_quantity_issued || 0), 0).toFixed(2);
}
function sumCost(rows) {
  return rows.reduce((s, r) => s + Number(r.fuel_cost || 0), 0).toFixed(2);
}

export default function FuelReport() {
  const [filters, setFilters] = useState({
    from_date: todayStr(), to_date: todayStr(), request_type: "", status: "", equipment_type: "",
  });
  const [result, setResult] = useState(null);
  const [resultIsStock, setResultIsStock] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState("");
  const [error, setError] = useState("");

  const isStock = filters.request_type === "stock";

  function setType(request_type) {
    // Status options differ between the two modes (issued vs received) —
    // clear it on switch so a stale, invalid value never gets sent.
    setFilters({ ...filters, request_type, status: "" });
  }

  async function runReport(newPage = 1) {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ ...filters, page: newPage, page_size: 100 });
      Object.keys(filters).forEach((k) => { if (!filters[k]) params.delete(k); });
      const data = await apiRequest(`/supply-requests/report?${params.toString()}`);
      setResult(data);
      setResultIsStock(isStock);
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
    return apiRequest(`/supply-requests/report/export?${params.toString()}`);
  }

  async function exportPdf() {
    setExporting("pdf"); setError("");
    try {
      const rows = await fetchExportRows();
      if (rows.length === 0) { setError("Nothing to export for these filters."); return; }
      const [{ default: jsPDF }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
      const doc = new jsPDF({ orientation: "landscape" });
      doc.setFontSize(14);
      doc.text(`Our Own Ready Mix — ${isStock ? "Stock (Purchase) Report" : "Fuel and Lubricant Report"}`, 14, 15);
      doc.setFontSize(9);
      doc.text(`${filters.from_date} to ${filters.to_date}`, 14, 21);
      doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 26);

      if (isStock) {
        doc.autoTable({
          startY: 30,
          head: [["Ref", "Requested", "Type", "By", "Supplier", "Item", "Req qty", "Approved", "Approved by", "Received", "Received by", "Cost", "Status"]],
          body: rows.map((r) => [
            refNumber(r), formatDateTime(r.requested_at), r.request_type, r.requested_by_name, r.supplier_name || "–",
            itemLabel(r),
            r.requested_quantity, r.approved_quantity ?? "–", r.approved_by_name || "–",
            r.actual_quantity_issued ?? "–", r.issued_by_name || "–",
            r.fuel_cost != null ? `Rs. ${r.fuel_cost}` : "–", r.status,
          ]),
          foot: [["", "", "", "", "", "Total", "", "", "", `Fuel ${sumQty(rows, "fuel")} L / Lube ${sumQty(rows, "lubricant")}`, "", `Rs. ${sumCost(rows)}`, `${rows.length} requests`]],
          styles: { fontSize: 7, overflow: "linebreak" },
          headStyles: { fillColor: [199, 91, 18] },
          rowPageBreak: "avoid",
        });
      } else {
        doc.autoTable({
          startY: 30,
          head: [["Ref", "Requested", "Type", "By", "Vehicle/machine", "Reading", "Station/lubricant", "Req qty", "Approved", "Approved by", "Issued", "Issued by", "Cost", "Status"]],
          body: rows.map((r) => [
            refNumber(r), formatDateTime(r.requested_at), r.request_type, r.requested_by_name, unitLabel(r),
            r.odometer_reading ? `${r.odometer_reading} km` : r.hour_meter_reading ? `${r.hour_meter_reading} hrs` : "–",
            itemLabel(r),
            r.requested_quantity, r.approved_quantity ?? "–", r.approved_by_name || "–",
            r.actual_quantity_issued ?? "–", r.issued_by_name || "–",
            r.fuel_cost != null ? `Rs. ${r.fuel_cost}` : "–", r.status,
          ]),
          foot: [["", "", "", "", "", "", "Total", "", "", "", `Fuel ${sumQty(rows, "fuel")} L / Lube ${sumQty(rows, "lubricant")}`, "", `Rs. ${sumCost(rows)}`, `${rows.length} requests`]],
          styles: { fontSize: 7, overflow: "linebreak" },
          headStyles: { fillColor: [199, 91, 18] },
          rowPageBreak: "avoid",
        });
      }
      doc.save(`${isStock ? "Stock" : "Fuel"}_Report_${filters.from_date}to${filters.to_date}.pdf`);
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
      const sheetRows = rows.map((r) => isStock ? {
        "Ref": refNumber(r), "Requested": formatDateTime(r.requested_at), "Type": r.request_type,
        "Requested by": r.requested_by_name, "Supplier": r.supplier_name || "",
        "Item": itemLabel(r),
        "Requested qty": r.requested_quantity, "Approved qty": r.approved_quantity ?? "",
        "Received qty": r.actual_quantity_issued ?? "", "Cost (Rs.)": r.fuel_cost ?? "",
        "Status": r.status, "Approved by": r.approved_by_name || "", "Received by": r.issued_by_name || "",
        "Rejected reason": r.rejected_reason || "",
      } : {
        "Ref": refNumber(r), "Requested": formatDateTime(r.requested_at), "Type": r.request_type,
        "Requested by": r.requested_by_name, "Vehicle/machine": unitLabel(r),
        "Odometer (km)": r.odometer_reading || "", "Hour meter (hrs)": r.hour_meter_reading || "",
        "Station/Lubricant": itemLabel(r),
        "Requested qty": r.requested_quantity, "Approved qty": r.approved_quantity ?? "",
        "Actual issued": r.actual_quantity_issued ?? "", "Cost (Rs.)": r.fuel_cost ?? "",
        "Status": r.status, "Approved by": r.approved_by_name || "", "Issued by": r.issued_by_name || "",
        "Rejected reason": r.rejected_reason || "",
      });
      const ws = XLSX.utils.json_to_sheet(sheetRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, isStock ? "Stock Report" : "Fuel Report");
      XLSX.writeFile(wb, `${isStock ? "Stock" : "Fuel"}_Report_${filters.from_date}to${filters.to_date}.xlsx`);
    } catch (err) {
      setError(err.message || "Couldn't export Excel.");
    } finally {
      setExporting("");
    }
  }

  return (
    <>
      <TopBar title="Fuel and lubricant report" />
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
            <div style={{ color: "var(--slate)" }}>Type</div>
            <select value={filters.request_type} onChange={(e) => setType(e.target.value)}>
              <option value="">All</option>
              <option value="fuel">Fuel</option>
              <option value="lubricant">Lubricant</option>
              <option value="stock">Stock request</option>
            </select>
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>Status</div>
            <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              {isStock ? <option value="received">Received</option> : <option value="issued">Issued</option>}
              <option value="rejected">Rejected</option>
            </select>
          </div>
          <button onClick={() => runReport(1)} disabled={loading}>{loading ? "Loading..." : "Run report"}</button>
          <button onClick={exportPdf} disabled={exporting !== ""}>{exporting === "pdf" ? "Exporting..." : "Export PDF"}</button>
          <button onClick={exportExcel} disabled={exporting !== ""}>{exporting === "xlsx" ? "Exporting..." : "Export Excel"}</button>
        </div>
        {isStock && (
          <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>
            Showing Store's own stock purchase/restock requests — not fuel or lubricant issued to a vehicle or machine.
          </div>
        )}

        {error && <div style={{ color: "var(--alert-red)", marginBottom: 12 }}>{error}</div>}

        {result && (
          <div className="card" style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 12 }}>
              <thead>
                {resultIsStock ? (
                  <tr>
                    <th>Ref</th><th>Requested</th><th>Type</th><th>By</th><th>Supplier</th>
                    <th>Item</th><th>Req qty</th><th>Approved</th><th>Approved by</th>
                    <th>Received</th><th>Received by</th><th>Cost</th><th>Status</th>
                  </tr>
                ) : (
                  <tr>
                    <th>Ref</th><th>Requested</th><th>Type</th><th>By</th><th>Vehicle/machine</th>
                    <th>Reading</th><th>Station/Lubricant</th><th>Req qty</th><th>Approved</th><th>Approved by</th>
                    <th>Issued</th><th>Issued by</th><th>Cost</th><th>Status</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={`${r.source}-${r.id}`}>
                    <td>{refNumber(r)}</td>
                    <td>{formatDateTime(r.requested_at)}</td>
                    <td>{r.request_type}</td>
                    <td>{r.requested_by_name}</td>
                    <td>{unitLabel(r)}</td>
                    {!resultIsStock && <td>{r.odometer_reading ? `${r.odometer_reading} km` : r.hour_meter_reading ? `${r.hour_meter_reading} hrs` : "–"}</td>}
                    <td>{itemLabel(r)}</td>
                    <td>{r.requested_quantity}</td>
                    <td>{r.approved_quantity ?? "–"}</td>
                    <td>{r.approved_by_name || "–"}</td>
                    <td>{r.actual_quantity_issued ?? "–"}</td>
                    <td>{r.issued_by_name || "–"}</td>
                    <td>{r.fuel_cost != null ? `₹${r.fuel_cost}` : "–"}</td>
                    <td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600 }}>
                  <td colSpan={resultIsStock ? 6 : 7}>Totals ({result.totals.request_count} requests)</td>
                  <td colSpan={3}>Fuel {result.totals.total_fuel_litres} L</td>
                  <td colSpan={2}>Lube {result.totals.total_lubricant_qty}</td>
                  <td>₹{result.totals.total_cost}</td>
                  <td></td>
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
