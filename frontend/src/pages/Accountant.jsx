import { useEffect, useState } from "react";
import { useAuth } from "../lib/AuthContext.jsx";
import { apiRequest } from "../lib/api.js";

export default function Accountant() {
  const { user, logout } = useAuth();
  const [stats, setStats] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [allowances, setAllowances] = useState([]);
  const [payingInvoice, setPayingInvoice] = useState(null);
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
    return <PaymentForm invoice={payingInvoice} onDone={() => { setPayingInvoice(null); load(); }} />;
  }

  return (
    <div style={{ maxWidth: 900, margin: "24px auto", padding: "0 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: "#666" }}>Accountant &middot; {user?.name}</div>
        <button onClick={logout} style={{ fontSize: 12, color: "#999", background: "none", border: "none" }}>Sign out</button>
      </div>
      {error && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 8 }}>{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 20 }}>
        <Kpi label="Outstanding" value={`₹${stats?.outstanding ?? "–"}`} />
        <Kpi label="Collected today" value={`₹${stats?.collected_today ?? "–"}`} />
        <Kpi label="Pumping/waiting due" value={`₹${stats?.pumping_waiting_due ?? "–"}`} />
        <Kpi label="Trip allowance, this month" value={`₹${stats?.trip_allowance_this_month ?? "–"}`} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16 }}>
        <div>
          <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>Customer ledger</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#666" }}>
                <th style={{ padding: "6px 4px" }}>Customer</th>
                <th style={{ padding: "6px 4px" }}>Ticket</th>
                <th style={{ padding: "6px 4px" }}>Amount</th>
                <th style={{ padding: "6px 4px" }}>Status</th>
                <th style={{ padding: "6px 4px" }}></th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((row) => (
                <tr key={row.id} style={{ borderTop: "0.5px solid #ddd" }}>
                  <td style={{ padding: "6px 4px" }}>{row.customer_name}</td>
                  <td style={{ padding: "6px 4px" }}>{row.ticket_number}</td>
                  <td style={{ padding: "6px 4px" }}>₹{row.total_amount}</td>
                  <td style={{ padding: "6px 4px", color: row.status === "paid" ? "#1D9E75" : row.status === "pending" ? "#c0392b" : "#856404" }}>
                    {row.status.replace("_", " ")}
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    {row.status !== "paid" && <button onClick={() => setPayingInvoice(row)}>Record payment</button>}
                  </td>
                </tr>
              ))}
              {ledger.length === 0 && <tr><td colSpan={5} style={{ padding: 8, color: "#999" }}>No invoices yet.</td></tr>}
            </tbody>
          </table>
        </div>

        <div>
          <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>Driver trip allowance</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {allowances.map((a) => (
              <div key={a.driver_name} style={{ background: "#f5f5f5", borderRadius: 8, padding: 10, fontSize: 13, display: "flex", justifyContent: "space-between" }}>
                <span>{a.driver_name}</span>
                <span style={{ fontWeight: 500 }}>₹{a.total}</span>
              </div>
            ))}
            {allowances.length === 0 && <div style={{ fontSize: 13, color: "#999" }}>No completed trips yet this month.</div>}
          </div>
          <div style={{ fontSize: 12, color: "#999", marginTop: 8 }}>Based on completed deliveries only</div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value }) {
  return (
    <div style={{ background: "#f5f5f5", borderRadius: 12, padding: "1rem" }}>
      <div style={{ fontSize: 13, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 500 }}>{value}</div>
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
    <div style={{ maxWidth: 400, margin: "24px auto", padding: "0 16px" }}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>Record payment</div>
      <div style={{ fontSize: 13, color: "#666", marginBottom: 16 }}>
        {invoice.customer_name} &middot; {invoice.ticket_number} &middot; Total ₹{invoice.total_amount}
      </div>
      <form onSubmit={submit} className="field-input" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
        <div>
          <div style={{ color: "#666" }}>Amount received</div>
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
        <div>
          <div style={{ color: "#666" }}>Payment mode</div>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="cash">Cash</option>
            <option value="cheque">Cheque</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="upi">UPI</option>
          </select>
        </div>
        <div>
          <div style={{ color: "#666" }}>Reference number</div>
          <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div>
          <div style={{ color: "#666" }}>Remarks</div>
          <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
        <div style={{ fontSize: 12, color: "#666" }}>
          You can record another receipt against this same invoice later — payments don't need to cover the full amount in one entry.
        </div>
        {error && <div style={{ color: "#c0392b" }}>{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save payment"}</button>
          <button type="button" onClick={onDone}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
