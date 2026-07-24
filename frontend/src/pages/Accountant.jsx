import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { RatesPanel } from "../lib/MasterDataPanels.jsx";

export default function Accountant() {
  const [stats, setStats] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [allowances, setAllowances] = useState([]);
  const [payingInvoice, setPayingInvoice] = useState(null);
  const [showRates, setShowRates] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [s, l, a] = await Promise.all([
        apiRequest("/accountant/dashboard"),
        apiRequest("/accountant/ledger"),
        apiRequest("/accountant/trip-allowances"),
      ]);
      setStats(s); setLedger(l); setAllowances(a);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  if (payingInvoice) {
    return (
      <>
        <TopBar title="Accountant · Record payment" />
        <div style={{ maxWidth: 400, margin: "0 auto", padding: "0 16px 32px" }}>
          <PaymentForm invoice={payingInvoice} onDone={() => { setPayingInvoice(null); load(); }} />
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
      <Link to="/fuel" style={{ marginLeft: 12, fontSize: 13 }}>Fuel filling</Link>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16 }}>
        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Customer ledger</div>
          <table>
            <thead>
              <tr><th>Customer</th><th>Ticket</th><th>Amount</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {ledger.map((row) => (
                <tr key={row.id}>
                  <td>{row.customer_name}</td>
                  <td>{row.ticket_number}</td>
                  <td>₹{row.total_amount}</td>
                  <td><span className={`badge ${row.status === "paid" ? "badge-success" : row.status === "pending" ? "badge-danger" : "badge-warning"}`}>{row.status.replace("_", " ")}</span></td>
                  <td>
                    {row.status !== "paid" && <button onClick={() => setPayingInvoice(row)}>Record payment</button>}
                  </td>
                </tr>
              ))}
              {ledger.length === 0 && <tr><td colSpan={5} style={{ color: "var(--slate)" }}>No invoices yet.</td></tr>}
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

function PaymentForm({ invoice, onDone }) {
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState("cash");
  const [reference, setReference] = useState("");
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await apiRequest("/accountant/payments", {
        method: "POST",
        body: { invoice_id: invoice.id, amount, mode, reference_number: reference, remarks },
      });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Record payment</div>
      <div style={{ fontSize: 13, color: "var(--slate)", marginBottom: 16 }}>
        {invoice.customer_name} &middot; {invoice.ticket_number} &middot; Total ₹{invoice.total_amount}
      </div>
      <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
        <div>
          <div style={{ color: "var(--slate)" }}>Amount received</div>
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} required />
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
          <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
        <div style={{ fontSize: 12, color: "var(--slate)" }}>
          You can record another receipt against this same invoice later — payments don't need to cover the full amount in one entry.
        </div>
        {error && <div style={{ color: "var(--alert-red)" }}>{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save payment"}</button>
          <button type="button" onClick={onDone}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
