import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { RatesPanel } from "../lib/MasterDataPanels.jsx";

export default function Accountant() {
  const [stats, setStats] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [allowances, setAllowances] = useState([]);
  const [payingCustomer, setPayingCustomer] = useState(null);
  const [showRates, setShowRates] = useState(false);
  const [showOpeningBalances, setShowOpeningBalances] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(null);

  async function load() {
    try {
      const [s, c, a] = await Promise.all([
        apiRequest("/accountant/dashboard"),
        apiRequest("/accountant/customers-outstanding"),
        apiRequest("/accountant/trip-allowances"),
      ]);
      setStats(s); setCustomers(c); setAllowances(a);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  function inrPdf(value) {
    return `Rs. ${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  }

  async function exportOutstandingPdf() {
    if (customers.length === 0) { setError("Nothing outstanding to export."); return; }
    setExporting("pdf"); setError("");
    try {
      const { jsPDF } = await import("jspdf");
      await import("jspdf-autotable");
      const doc = new jsPDF();
      doc.setFontSize(14);
      doc.text("Our Own Ready Mix", 14, 14);
      doc.setFontSize(11);
      doc.text("Customer-wise Outstanding Report", 14, 21);
      doc.setFontSize(8);
      doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 27);

      const totalInvoiced = customers.reduce((s, c) => s + Number(c.total_invoiced), 0);
      const totalPaid = customers.reduce((s, c) => s + Number(c.total_paid), 0);
      const totalBalance = customers.reduce((s, c) => s + Number(c.balance), 0);

      doc.autoTable({
        startY: 32,
        head: [["Customer", "Invoiced", "Paid", "Balance", "Oldest unpaid"]],
        body: customers.map((c) => [
          c.customer_name, inrPdf(c.total_invoiced), inrPdf(c.total_paid), inrPdf(c.balance),
          c.oldest_unpaid_date ? new Date(c.oldest_unpaid_date).toLocaleDateString() : "–",
        ]),
        foot: [["Total", inrPdf(totalInvoiced), inrPdf(totalPaid), inrPdf(totalBalance), `${customers.length} customers`]],
        styles: { fontSize: 9 },
        headStyles: { fillColor: [199, 91, 18] },
      });
      doc.save(`Customer_Outstanding_${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err) {
      setError(err.message || "Couldn't export PDF.");
    } finally {
      setExporting(null);
    }
  }

  async function exportOutstandingExcel() {
    if (customers.length === 0) { setError("Nothing outstanding to export."); return; }
    setExporting("excel"); setError("");
    try {
      const XLSX = await import("xlsx");
      const sheetRows = customers.map((c) => ({
        Customer: c.customer_name, Invoiced: Number(c.total_invoiced), Paid: Number(c.total_paid),
        Balance: Number(c.balance), "Oldest unpaid": c.oldest_unpaid_date ? new Date(c.oldest_unpaid_date).toLocaleDateString() : "",
      }));
      sheetRows.push({
        Customer: "Total", Invoiced: customers.reduce((s, c) => s + Number(c.total_invoiced), 0),
        Paid: customers.reduce((s, c) => s + Number(c.total_paid), 0),
        Balance: customers.reduce((s, c) => s + Number(c.balance), 0), "Oldest unpaid": `${customers.length} customers`,
      });
      const ws = XLSX.utils.json_to_sheet(sheetRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Outstanding");
      XLSX.writeFile(wb, `Customer_Outstanding_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (err) {
      setError(err.message || "Couldn't export Excel.");
    } finally {
      setExporting(null);
    }
  }

  if (payingCustomer) {
    return (
      <>
        <TopBar title="Accountant · Record payment" />
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
          <BulkPaymentForm customer={payingCustomer} onDone={() => { setPayingCustomer(null); load(); }} onCancel={() => setPayingCustomer(null)} />
        </div>
      </>
    );
  }

  if (showOpeningBalances) {
    return (
      <>
        <TopBar title="Accountant · Opening balances" />
        <div style={{ maxWidth: 700, margin: "0 auto", padding: "0 16px 32px" }}>
          <button onClick={() => setShowOpeningBalances(false)} style={{ marginBottom: 16 }}>← Back to dashboard</button>
          <OpeningBalancesPanel />
        </div>
      </>
    );
  }

  if (showRates) {
    return (
      <>
        <TopBar title="Accountant · Concrete grades and rates" />
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
          <button onClick={() => setShowRates(false)} style={{ marginBottom: 16 }}>← Back to dashboard</button>
          {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
          <RatesPanel setError={setError} />
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar title="Accountant" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 20 }}>
        <Kpi label="Outstanding" value={`₹${stats?.outstanding ?? "–"}`} />
        <Kpi label="Collected today" value={`₹${stats?.collected_today ?? "–"}`} />
        <Kpi label="Pumping/waiting due" value={`₹${stats?.pumping_waiting_due ?? "–"}`} />
        <Kpi label="Trip allowance, this month" value={`₹${stats?.trip_allowance_this_month ?? "–"}`} />
      </div>

      <button onClick={() => setShowRates(true)} style={{ marginBottom: 20 }}>Concrete grades and rates</button>
      <button onClick={() => setShowOpeningBalances(true)} style={{ marginBottom: 20, marginLeft: 8 }}>Opening balances</button>
      <Link to="/fuel" style={{ marginLeft: 12, fontSize: 13 }}>Fuel filling</Link>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16 }}>
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Customers — outstanding</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={exportOutstandingPdf} disabled={exporting} style={{ fontSize: 11, padding: "4px 8px" }}>
                {exporting === "pdf" ? "..." : "Export PDF"}
              </button>
              <button onClick={exportOutstandingExcel} disabled={exporting} style={{ fontSize: 11, padding: "4px 8px" }}>
                {exporting === "excel" ? "..." : "Export Excel"}
              </button>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8 }}>
            Record one payment against a customer — it's applied automatically across their oldest unpaid deliveries first, instead of paying each one individually.
          </div>
          <table>
            <thead>
              <tr><th>Customer</th><th>Invoiced</th><th>Paid</th><th>Balance</th><th>Oldest unpaid</th><th></th></tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.customer_id}>
                  <td>{c.customer_name}</td>
                  <td>₹{c.total_invoiced}</td>
                  <td>₹{c.total_paid}</td>
                  <td style={{ fontWeight: 600, color: "var(--alert-red)" }}>₹{c.balance}</td>
                  <td>{c.oldest_unpaid_date ? new Date(c.oldest_unpaid_date).toLocaleDateString([], { day: "2-digit", month: "short" }) : "–"}</td>
                  <td><button onClick={() => setPayingCustomer(c)}>Record payment</button></td>
                </tr>
              ))}
              {customers.length === 0 && <tr><td colSpan={6} style={{ color: "var(--slate)" }}>Nothing outstanding — everyone's paid up.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Driver trip allowance</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {allowances.map((a) => (
              <div key={a.driver_name} style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 13, display: "flex", justifyContent: "space-between" }}>
                <span>{a.driver_name}</span>
                <span style={{ fontWeight: 600 }}>₹{a.total}</span>
              </div>
            ))}
            {allowances.length === 0 && <div style={{ fontSize: 13, color: "var(--slate)" }}>No completed trips yet this month.</div>}
          </div>
          <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 8 }}>Based on completed deliveries only</div>
        </div>
      </div>
      </div>
    </>
  );
}

function Kpi({ label, value }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
    </div>
  );
}

function BulkPaymentForm({ customer, onDone, onCancel }) {
  const [invoices, setInvoices] = useState([]);
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState("cash");
  const [reference, setReference] = useState("");
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    apiRequest(`/accountant/customers/${customer.customer_id}/invoices`)
      .then((rows) => setInvoices(rows.filter((r) => r.status !== "paid")))
      .catch((err) => setError(err.message));
  }, []);

  // Live preview of what this amount would cover, oldest delivery first —
  // so the accountant can see exactly what they're paying off before submitting.
  const preview = [];
  {
    let remaining = Number(amount) || 0;
    for (const inv of invoices) {
      if (remaining <= 0.01) break;
      const invBalance = Number(inv.total_amount) - Number(inv.paid_amount);
      const applied = Math.min(remaining, invBalance);
      preview.push({ ticket_number: inv.ticket_number, ticket_date: inv.ticket_date, applied, invBalance, fullyPaid: applied >= invBalance - 0.01 });
      remaining -= applied;
    }
  }
  const leftover = Math.max(0, (Number(amount) || 0) - preview.reduce((s, p) => s + p.applied, 0));

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      const r = await apiRequest(`/accountant/customers/${customer.customer_id}/bulk-payment`, {
        method: "POST",
        body: { amount, payment_date: paymentDate, mode, reference_number: reference, remarks },
      });
      setResult(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (result) {
    return (
      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Payment recorded</div>
        <div style={{ fontSize: 13, marginBottom: 10 }}>₹{result.total_received} received from {customer.customer_name}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {result.applied.map((a, i) => (
            <div key={i} style={{ fontSize: 13, background: "var(--concrete)", borderRadius: 8, padding: 8 }}>
              {a.ticket_number} — ₹{a.amount_applied} applied {a.fully_paid ? "(fully paid)" : "(partial)"}
            </div>
          ))}
        </div>
        {result.unapplied_credit > 0.01 && (
          <div style={{ fontSize: 12, color: "var(--amber)", background: "var(--amber-bg)", padding: 8, borderRadius: 8, marginBottom: 12 }}>
            ₹{result.unapplied_credit} received beyond what was currently owed — this customer had no more outstanding invoices to apply it to. Keep this in mind for their next delivery/payment; it isn't tracked automatically as a credit balance.
          </div>
        )}
        <button onClick={onDone} style={{ width: "100%" }}>Done</button>
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Record payment — {customer.customer_name}</div>
      <div style={{ fontSize: 13, color: "var(--slate)", marginBottom: 16 }}>
        Currently owed: ₹{customer.balance}
      </div>
      <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
        <div>
          <div style={{ color: "var(--slate)" }}>Amount received</div>
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Payment date</div>
          <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} required />
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Payment mode</div>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="cash">Cash</option>
            <option value="cheque">Cheque</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="upi">UPI</option>
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Reference number</div>
          <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Remarks</div>
          <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. covers deliveries from 12–18 Jul" />
        </div>

        {Number(amount) > 0 && (
          <div style={{ background: "var(--concrete)", borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 6 }}>This will apply to (oldest first):</div>
            {preview.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--slate)" }}>Nothing outstanding to apply this to.</div>
            ) : (
              preview.map((p, i) => (
                <div key={i} style={{ fontSize: 12, display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span>{p.ticket_number} ({new Date(p.ticket_date).toLocaleDateString([], { day: "2-digit", month: "short" })})</span>
                  <span>₹{p.applied.toFixed(2)} {p.fullyPaid ? "" : "(partial)"}</span>
                </div>
              ))
            )}
            {leftover > 0.01 && (
              <div style={{ fontSize: 12, color: "var(--amber)", marginTop: 6 }}>
                ⚠ ₹{leftover.toFixed(2)} left over — beyond what's currently owed by this customer.
              </div>
            )}
          </div>
        )}

        <div style={{ fontSize: 11, color: "var(--slate)" }}>
          Any delivery that was rejected at site never generated an invoice in the first place, so it's never included here — only accepted, completed deliveries count toward what's owed.
        </div>

        {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save payment"}</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

function OpeningBalancesPanel() {
  const [balances, setBalances] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [showUpload, setShowUpload] = useState(false);

  async function load() {
    try {
      const [b, c] = await Promise.all([apiRequest("/accountant/opening-balances"), apiRequest("/master/customers")]);
      setBalances(b); setCustomers(c);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function remove(id) {
    if (!window.confirm("Delete this opening balance entry?")) return;
    setError("");
    try {
      await apiRequest(`/accountant/opening-balances/${id}`, { method: "DELETE" });
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--slate)", marginBottom: 16 }}>
        Pre-existing outstanding from before this app was in use — entered once here, it's
        blended into every outstanding/aging figure across the app automatically, and can be
        paid down through the normal "Record payment" flow just like any other delivery.
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={() => { setShowManual(!showManual); setShowUpload(false); }}>{showManual ? "Hide" : "+ Add one manually"}</button>
        <button onClick={() => { setShowUpload(!showUpload); setShowManual(false); }}>{showUpload ? "Hide" : "Upload from Excel"}</button>
      </div>

      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 12 }}>{notice}</div>}

      {showManual && (
        <ManualOpeningBalanceForm
          customers={customers}
          setError={setError}
          onDone={() => { setNotice("Added."); setShowManual(false); load(); }}
        />
      )}
      {showUpload && (
        <ExcelUploadForm
          customers={customers}
          setError={setError}
          onDone={(count) => { setNotice(`${count} opening balance(s) imported.`); setShowUpload(false); load(); }}
        />
      )}

      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>All opening balances on file</div>
        {balances.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>None entered yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 13 }}>
              <thead><tr><th>Customer</th><th>Amount</th><th>Paid</th><th>As of</th><th>Notes</th><th>Entered by</th><th></th></tr></thead>
              <tbody>
                {balances.map((b) => (
                  <tr key={b.id}>
                    <td>{b.customer_name}</td>
                    <td>₹{b.amount}</td>
                    <td>₹{b.paid_amount}</td>
                    <td>{new Date(b.as_of_date).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}</td>
                    <td>{b.notes || "–"}</td>
                    <td>{b.entered_by_name || "–"}</td>
                    <td>
                      {Number(b.paid_amount) === 0 && (
                        <button className="btn-danger" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => remove(b.id)}>Delete</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ManualOpeningBalanceForm({ customers, setError, onDone }) {
  const [customerId, setCustomerId] = useState("");
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await apiRequest("/accountant/opening-balances", {
        method: "POST",
        body: { customer_id: customerId, amount, days_outstanding: days, notes },
      });
      onDone();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13, marginBottom: 16 }}>
      <div>
        <div style={{ color: "var(--slate)" }}>Customer</div>
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
          <option value="">Select</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div><div style={{ color: "var(--slate)" }}>Outstanding amount (₹)</div><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
      <div><div style={{ color: "var(--slate)" }}>Days outstanding (as of today)</div><input type="number" value={days} onChange={(e) => setDays(e.target.value)} placeholder="e.g. 45" required /></div>
      <div><div style={{ color: "var(--slate)" }}>Notes (optional)</div><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. carried over from before this app" /></div>
      <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Add opening balance"}</button></div>
    </form>
  );
}

// Expects a spreadsheet with columns (any reasonable header name is
// recognized): Customer, Amount, Days Outstanding, and optionally Notes.
function ExcelUploadForm({ customers, setError, onDone }) {
  const [rows, setRows] = useState([]); // parsed + matched preview rows
  const [saving, setSaving] = useState(false);
  const [parsing, setParsing] = useState(false);

  function findHeader(headers, candidates) {
    return headers.find((h) => candidates.includes(h.toLowerCase().trim()));
  }

  function matchCustomer(name) {
    const norm = (s) => s.toLowerCase().trim();
    return customers.find((c) => norm(c.name) === norm(name || ""));
  }

  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setParsing(true); setError("");
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      if (data.length === 0) throw new Error("No rows found in that sheet.");
      const headers = Object.keys(data[0]);
      const customerCol = findHeader(headers, ["customer", "customer name", "name"]);
      const amountCol = findHeader(headers, ["amount", "outstanding amount", "outstanding", "balance"]);
      const daysCol = findHeader(headers, ["days outstanding", "days", "age", "age in days"]);
      const notesCol = findHeader(headers, ["notes", "remarks"]);
      if (!customerCol || !amountCol || !daysCol) {
        throw new Error(`Couldn't find the expected columns. Found: ${headers.join(", ")}. Expecting columns named something like "Customer", "Amount", and "Days Outstanding".`);
      }
      const parsed = data.map((row) => {
        const customerName = String(row[customerCol] || "").trim();
        const match = matchCustomer(customerName);
        return {
          customer_name: customerName,
          customer_id: match?.id || "",
          amount: row[amountCol],
          days_outstanding: row[daysCol],
          notes: notesCol ? row[notesCol] : "",
        };
      }).filter((r) => r.customer_name || r.amount);
      setRows(parsed);
    } catch (err) {
      setError(err.message || "Couldn't read that file.");
    } finally {
      setParsing(false);
      e.target.value = "";
    }
  }

  function updateRowCustomer(index, customerId) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, customer_id: customerId } : r)));
  }

  const unmatchedCount = rows.filter((r) => !r.customer_id).length;
  const readyCount = rows.filter((r) => r.customer_id && r.amount && r.days_outstanding !== "").length;

  async function confirmImport() {
    setSaving(true); setError("");
    try {
      const toImport = rows.filter((r) => r.customer_id && r.amount && r.days_outstanding !== "");
      const result = await apiRequest("/accountant/opening-balances/bulk", { method: "POST", body: { rows: toImport } });
      setRows([]);
      onDone(result.inserted);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Upload from Excel</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>
        Spreadsheet needs three columns: <strong>Customer</strong> (name, matched against your
        existing customer list), <strong>Amount</strong> (outstanding, in ₹), and{" "}
        <strong>Days Outstanding</strong> (how many days old that balance is, as of today) — plus
        an optional <strong>Notes</strong> column. Column names are matched loosely, so
        "Customer Name" or "Outstanding Amount" work fine too.
      </div>
      <input type="file" accept=".xlsx,.xls" onChange={handleFile} disabled={parsing} />

      {rows.length > 0 && (
        <>
          <div style={{ marginTop: 16, marginBottom: 8, fontSize: 12, color: unmatchedCount > 0 ? "var(--alert-red)" : "var(--signal-green)" }}>
            {readyCount} of {rows.length} row(s) ready to import
            {unmatchedCount > 0 ? ` — ${unmatchedCount} customer name(s) didn't match, fix them below before importing` : ""}
          </div>
          <div style={{ overflowX: "auto", marginBottom: 12 }}>
            <table style={{ fontSize: 12 }}>
              <thead><tr><th>Customer (from file)</th><th>Matched to</th><th>Amount</th><th>Days</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={!r.customer_id ? { background: "var(--alert-red-bg, #FBEAEA)" } : undefined}>
                    <td>{r.customer_name}</td>
                    <td>
                      <select value={r.customer_id} onChange={(e) => updateRowCustomer(i, e.target.value)}>
                        <option value="">— no match, select —</option>
                        {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </td>
                    <td>{r.amount || "–"}</td>
                    <td>{r.days_outstanding !== "" ? r.days_outstanding : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={confirmImport} disabled={saving || readyCount === 0}>
            {saving ? "Importing..." : `Import ${readyCount} opening balance(s)`}
          </button>
        </>
      )}
    </div>
  );
}
