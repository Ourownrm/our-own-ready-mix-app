import { useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function DelayJustificationReport() {
  const [filters, setFilters] = useState({ from_date: todayStr(), to_date: todayStr() });
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState("");
  const [error, setError] = useState("");

  async function run() {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams(filters);
      setRows(await apiRequest(`/reports/delay-justification?${params.toString()}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function exportPdf() {
    if (!rows || rows.length === 0) { setError("Run the report first — nothing to export."); return; }
    setExporting("pdf"); setError("");
    try {
      const [{ default: jsPDF }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
      const doc = new jsPDF({ orientation: "landscape" });
      doc.setFontSize(14);
      doc.text("Our Own Ready Mix — Delay Justification Report", 14, 15);
      doc.setFontSize(9);
      doc.text(`${filters.from_date} to ${filters.to_date}`, 14, 21);
      doc.autoTable({
        startY: 26,
        head: [["Date", "Customer", "Site", "Delay type", "Planned/reference", "Actual", "Reason", "Recorded by", "Recorded at"]],
        body: rows.map((r) => [
          new Date(r.date).toLocaleDateString([], { day: "2-digit", month: "short" }), r.customer_name, r.site_name, r.delay_type,
          r.planned_time || "–", r.actual_time || "–", r.reason || "No reason recorded", r.reason_by_name || "–",
          r.reason_at ? new Date(r.reason_at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "–",
        ]),
        styles: { fontSize: 8, overflow: "linebreak" },
        headStyles: { fillColor: [199, 91, 18] },
        rowPageBreak: "avoid",
      });
      doc.save(`Delay_Justification_${filters.from_date}to${filters.to_date}.pdf`);
    } catch (err) {
      setError(err.message || "Couldn't export PDF.");
    } finally {
      setExporting("");
    }
  }

  async function exportExcel() {
    if (!rows || rows.length === 0) { setError("Run the report first — nothing to export."); return; }
    setExporting("xlsx"); setError("");
    try {
      const XLSX = await import("xlsx");
      const sheetRows = rows.map((r) => ({
        Date: r.date, Customer: r.customer_name, Site: r.site_name, "Delay type": r.delay_type,
        "Planned/reference": r.planned_time || "", Actual: r.actual_time || "",
        Reason: r.reason || "No reason recorded", "Recorded by": r.reason_by_name || "",
        "Recorded at": r.reason_at || "",
      }));
      const ws = XLSX.utils.json_to_sheet(sheetRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Delay Justification");
      XLSX.writeFile(wb, `Delay_Justification_${filters.from_date}to${filters.to_date}.xlsx`);
    } catch (err) {
      setError(err.message || "Couldn't export Excel.");
    } finally {
      setExporting("");
    }
  }

  return (
    <>
      <TopBar title="Delay justification report" />
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>
          Pump departure delays, site-ready timing, batching-not-started alerts, and trucks over 2 hours at
          site — each with its recorded reason, who recorded it, and when.
        </div>
        <div className="card field-input" style={{ marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", fontSize: 13 }}>
          <div>
            <div style={{ color: "var(--slate)" }}>From</div>
            <input type="date" value={filters.from_date} onChange={(e) => setFilters({ ...filters, from_date: e.target.value })} />
          </div>
          <div>
            <div style={{ color: "var(--slate)" }}>To</div>
            <input type="date" value={filters.to_date} onChange={(e) => setFilters({ ...filters, to_date: e.target.value })} />
          </div>
          <button onClick={run} disabled={loading}>{loading ? "Loading..." : "Run report"}</button>
          <button onClick={exportPdf} disabled={exporting !== ""}>{exporting === "pdf" ? "Exporting..." : "Export PDF"}</button>
          <button onClick={exportExcel} disabled={exporting !== ""}>{exporting === "xlsx" ? "Exporting..." : "Export Excel"}</button>
        </div>

        {error && <div style={{ color: "var(--alert-red)", marginBottom: 12 }}>{error}</div>}

        {rows && (
          rows.length === 0 ? (
            <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>No delays recorded for this range.</div>
          ) : (
            <div className="card" style={{ overflowX: "auto" }}>
              <table style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Date</th><th>Customer</th><th>Site</th><th>Delay type</th>
                    <th>Planned/reference</th><th>Actual</th><th>Reason</th><th>Recorded by</th><th>Recorded at</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td>{new Date(r.date).toLocaleDateString([], { day: "2-digit", month: "short" })}</td>
                      <td>{r.customer_name}</td>
                      <td>{r.site_name}</td>
                      <td><span className="badge badge-warning">{r.delay_type}</span></td>
                      <td>{r.planned_time || "–"}</td>
                      <td>{r.actual_time || "–"}</td>
                      <td>{r.reason || <span style={{ color: "var(--alert-red)" }}>No reason recorded</span>}</td>
                      <td>{r.reason_by_name || "–"}</td>
                      <td>{r.reason_at ? new Date(r.reason_at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </>
  );
}
