import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";

function inr(value) {
  if (value === null || value === undefined) return "–";
  return `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
function inrPdf(value) {
  return `Rs. ${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

const BUCKET_COLORS = {
  bucket_0_7: { bg: "#E4F2EC", fg: "#1D7A55" },
  bucket_8_14: { bg: "#E3EEF4", fg: "#2A6F97" },
  bucket_15_30: { bg: "#F5EDDD", fg: "#9C6B12" },
  bucket_30_plus: { bg: "#FBEAEA", fg: "#B3261E" },
};

function Pill({ value, bucketKey }) {
  const n = Number(value);
  if (!n) return <span style={{ color: "#A8A498" }}>–</span>;
  const c = BUCKET_COLORS[bucketKey];
  return <span style={{ background: c.bg, color: c.fg, padding: "3px 9px", borderRadius: 6, fontWeight: n > 0 && bucketKey === "bucket_30_plus" ? 700 : 500 }}>{inr(n)}</span>;
}

export default function OutstandingCollectionReport() {
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState("");
  const [error, setError] = useState("");

  async function run() {
    setLoading(true); setError("");
    try {
      setRows(await apiRequest("/reports/outstanding-collection"));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { run(); }, []);

  const totals = (rows || []).reduce(
    (acc, r) => {
      acc.bucket_0_7 += Number(r.bucket_0_7);
      acc.bucket_8_14 += Number(r.bucket_8_14);
      acc.bucket_15_30 += Number(r.bucket_15_30);
      acc.bucket_30_plus += Number(r.bucket_30_plus);
      acc.total_outstanding += Number(r.total_outstanding);
      return acc;
    },
    { bucket_0_7: 0, bucket_8_14: 0, bucket_15_30: 0, bucket_30_plus: 0, total_outstanding: 0 }
  );
  const today = new Date().toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });

  async function exportPdf() {
    if (!rows || rows.length === 0) { setError("Nothing to export."); return; }
    setExporting("pdf"); setError("");
    try {
      const [{ default: jsPDF }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
      const doc = new jsPDF();
      doc.setFillColor(199, 91, 18);
      doc.rect(0, 0, 210, 22, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(15);
      doc.text("Our Own Ready Mix", 14, 12);
      doc.setFontSize(10);
      doc.text(`Outstanding Collection Report — as of ${today}`, 14, 18);
      doc.setTextColor(0, 0, 0);
      doc.autoTable({
        startY: 28,
        head: [["Customer", "0-7 days", "8-14 days", "15-30 days", "30+ days", "Total"]],
        body: rows.map((r) => [
          r.customer_name,
          Number(r.bucket_0_7) ? inrPdf(r.bucket_0_7) : "-",
          Number(r.bucket_8_14) ? inrPdf(r.bucket_8_14) : "-",
          Number(r.bucket_15_30) ? inrPdf(r.bucket_15_30) : "-",
          Number(r.bucket_30_plus) ? inrPdf(r.bucket_30_plus) : "-",
          inrPdf(r.total_outstanding),
        ]),
        foot: [["Total outstanding", inrPdf(totals.bucket_0_7), inrPdf(totals.bucket_8_14), inrPdf(totals.bucket_15_30), inrPdf(totals.bucket_30_plus), inrPdf(totals.total_outstanding)]],
        headStyles: { fillColor: [199, 91, 18] },
        footStyles: { fillColor: [250, 248, 243], textColor: [26, 26, 26], fontStyle: "bold" },
        styles: { fontSize: 9 },
      });
      doc.save(`Outstanding_Collection_${today.replace(/ /g, "")}.pdf`);
    } catch (err) {
      setError(err.message || "Couldn't export PDF.");
    } finally {
      setExporting("");
    }
  }

  async function exportExcel() {
    if (!rows || rows.length === 0) { setError("Nothing to export."); return; }
    setExporting("xlsx"); setError("");
    try {
      const XLSX = await import("xlsx");
      const sheetRows = rows.map((r) => ({
        Customer: r.customer_name, "0-7 days": Number(r.bucket_0_7) || "", "8-14 days": Number(r.bucket_8_14) || "",
        "15-30 days": Number(r.bucket_15_30) || "", "30+ days": Number(r.bucket_30_plus) || "", Total: Number(r.total_outstanding),
      }));
      sheetRows.push({ Customer: "Total outstanding", "0-7 days": totals.bucket_0_7, "8-14 days": totals.bucket_8_14, "15-30 days": totals.bucket_15_30, "30+ days": totals.bucket_30_plus, Total: totals.total_outstanding });
      const ws = XLSX.utils.json_to_sheet(sheetRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Outstanding Collection");
      XLSX.writeFile(wb, `Outstanding_Collection_${today.replace(/ /g, "")}.xlsx`);
    } catch (err) {
      setError(err.message || "Couldn't export Excel.");
    } finally {
      setExporting("");
    }
  }

  return (
    <>
      <TopBar title="Outstanding Collection" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <button onClick={run} disabled={loading}>{loading ? "Loading..." : "Refresh"}</button>
          <button onClick={exportPdf} disabled={exporting !== ""}>{exporting === "pdf" ? "Exporting..." : "Export PDF"}</button>
          <button onClick={exportExcel} disabled={exporting !== ""}>{exporting === "xlsx" ? "Exporting..." : "Export Excel"}</button>
        </div>

        {error && <div style={{ color: "var(--alert-red)", marginBottom: 12 }}>{error}</div>}

        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ background: "#C75B12", padding: "16px 20px", color: "#fff" }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Our Own Ready Mix</div>
            <div style={{ fontSize: 12, opacity: 0.9 }}>Outstanding Collection Report &middot; as of {today}</div>
          </div>

          <div style={{ padding: "16px 20px" }}>
            {!rows ? (
              <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>
            ) : rows.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing outstanding — every invoice is fully collected.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ fontSize: 12, width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1.5px solid var(--concrete)" }}>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>Customer</th>
                      <th style={{ textAlign: "right", padding: "6px 4px", color: BUCKET_COLORS.bucket_0_7.fg }}>0–7 days</th>
                      <th style={{ textAlign: "right", padding: "6px 4px", color: BUCKET_COLORS.bucket_8_14.fg }}>8–14 days</th>
                      <th style={{ textAlign: "right", padding: "6px 4px", color: BUCKET_COLORS.bucket_15_30.fg }}>15–30 days</th>
                      <th style={{ textAlign: "right", padding: "6px 4px", color: BUCKET_COLORS.bucket_30_plus.fg }}>30+ days</th>
                      <th style={{ textAlign: "right", padding: "6px 4px" }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} style={{ borderBottom: "0.5px solid var(--concrete)" }}>
                        <td style={{ padding: "8px 4px", fontWeight: 500 }}>{r.customer_name}</td>
                        <td style={{ textAlign: "right", padding: "8px 4px" }}><Pill value={r.bucket_0_7} bucketKey="bucket_0_7" /></td>
                        <td style={{ textAlign: "right", padding: "8px 4px" }}><Pill value={r.bucket_8_14} bucketKey="bucket_8_14" /></td>
                        <td style={{ textAlign: "right", padding: "8px 4px" }}><Pill value={r.bucket_15_30} bucketKey="bucket_15_30" /></td>
                        <td style={{ textAlign: "right", padding: "8px 4px" }}><Pill value={r.bucket_30_plus} bucketKey="bucket_30_plus" /></td>
                        <td style={{ textAlign: "right", padding: "8px 4px", fontWeight: 700 }}>{inr(r.total_outstanding)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: "2px solid #1A1A1A" }}>
                      <td style={{ padding: "12px 4px", fontWeight: 700, fontSize: 13 }}>Total outstanding</td>
                      <td style={{ textAlign: "right", padding: "12px 4px", fontWeight: 600, color: BUCKET_COLORS.bucket_0_7.fg }}>{inr(totals.bucket_0_7)}</td>
                      <td style={{ textAlign: "right", padding: "12px 4px", fontWeight: 600, color: BUCKET_COLORS.bucket_8_14.fg }}>{inr(totals.bucket_8_14)}</td>
                      <td style={{ textAlign: "right", padding: "12px 4px", fontWeight: 600, color: BUCKET_COLORS.bucket_15_30.fg }}>{inr(totals.bucket_15_30)}</td>
                      <td style={{ textAlign: "right", padding: "12px 4px", fontWeight: 600, color: BUCKET_COLORS.bucket_30_plus.fg }}>{inr(totals.bucket_30_plus)}</td>
                      <td style={{ textAlign: "right", padding: "12px 4px", fontWeight: 800, fontSize: 14 }}>{inr(totals.total_outstanding)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
          {rows && rows.length > 0 && (
            <div style={{ padding: "10px 20px", borderTop: "0.5px solid var(--concrete)", fontSize: 11, color: "var(--slate)", display: "flex", justifyContent: "space-between" }}>
              <span>{rows.length} customer{rows.length === 1 ? "" : "s"} with outstanding balance</span>
              <span>Generated by Our Own Ready Mix</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
