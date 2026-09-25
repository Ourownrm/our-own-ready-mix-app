import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { monthStartStr, todayStr } from "../lib/istDate.js";

// Round 158 — the two halves of "the weighbridge and the invoice disagree".
//
//   Waiting     — the decision. A Manager says which quantity stands, and only
//                 then does the load reach stock.
//   Variance    — the pattern. One light load is weather; forty light loads,
//                 always in the same direction, is a conversation to have with
//                 a supplier.
//
// They sit on one screen because they are the same subject seen at two
// distances, and because a Manager settling today's load benefits from seeing
// that this supplier has been 3% light all quarter.

function fmtQty(v, unit) {
  if (v == null) return "—";
  return `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}`;
}
function fmtMoney(v) {
  if (v == null) return "—";
  return `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}
function fmtWhen(ts) {
  return ts ? new Date(ts).toLocaleString([], { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
}
const TH = { padding: "9px 12px", textAlign: "left" };
const TD = { padding: "9px 12px" };

// Short = they billed more than we accepted, which is the direction that costs
// money, so it is the one that gets the alarming colour.
function varianceColour(v) {
  const n = Number(v || 0);
  if (n > 0) return "var(--alert-red)";
  if (n < 0) return "var(--signal-green)";
  return "var(--slate)";
}

// ---------------------------------------------------------------------------

function Waiting({ onSettled }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(null);
  const [custom, setCustom] = useState({});
  const [note, setNote] = useState({});

  async function load() {
    setError("");
    try { setRows(await apiRequest("/material-module/receipts/pending")); }
    catch (err) { setError(err.message || "Could not load the queue."); }
  }
  useEffect(() => { load(); }, []);

  async function confirm(r, basis) {
    setBusy(r.id); setError(""); setNotice("");
    try {
      const body = { basis, note: (note[r.id] || "").trim() || undefined };
      if (basis === "entered") {
        const q = Number(custom[r.id]);
        if (!Number.isFinite(q) || q <= 0) { setError("Enter the quantity you want accepted."); setBusy(null); return; }
        body.accepted_qty = q;
      }
      const res = await apiRequest(`/material-module/receipts/${r.id}/confirm`, { method: "POST", body });
      setNotice(`Receipt #${r.id} settled at ${fmtQty(res.accepted_qty, r.purchase_unit)}. It now counts towards stock.`);
      await load();
      onSettled?.();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  if (!rows) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 14, color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 14, color: "var(--signal-green)", fontSize: 13 }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
        <strong>These loads are in the yard, but not yet in stock.</strong> Each one was recorded with a
        weighed quantity and a billed quantity that disagree by more than the material's tolerance.
        Nothing is lost and nothing is blocked — the material arrived and the receipt is saved. It simply
        does not move stock or cost until somebody says which figure is the real one.
        <br />
        Loads where the two figures agree never appear here; they post themselves.
      </div>

      {!rows.length && (
        <div className="card" style={{ fontSize: 13 }}>
          Nothing waiting. Every load recorded so far has been within tolerance, or already settled.
        </div>
      )}

      {rows.map((r) => {
        const short = Number(r.variance_qty) > 0;
        return (
          <div key={r.id} className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "baseline", marginBottom: 10 }}>
              <strong style={{ fontSize: 15 }}>{r.material_name}</strong>
              <span style={{ fontSize: 13, color: "var(--slate)" }}>from {r.supplier_name}</span>
              <span style={{ fontSize: 12, color: "var(--slate)" }}>
                received {fmtWhen(r.received_at)} by {r.received_by_name}
                {r.vehicle_number ? ` · ${r.vehicle_number}` : ""}
                {r.challan_number ? ` · DC ${r.challan_number}` : ""}
              </span>
              <span style={{ marginLeft: "auto", fontWeight: 700, color: varianceColour(r.variance_qty) }}>
                {short ? "Short by " : "Over by "}
                {fmtQty(Math.abs(Number(r.variance_qty)), r.purchase_unit)} ({Math.abs(Number(r.variance_pct)).toFixed(1)}%)
              </span>
            </div>

            {r.short_reason && (
              <div style={{ fontSize: 13, marginBottom: 10, padding: "8px 10px", background: "var(--concrete)", borderRadius: 4 }}>
                <span style={{ color: "var(--slate)" }}>Store noted: </span>{r.short_reason}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div style={{ border: "1px solid var(--border)", borderRadius: 5, padding: "10px 12px" }}>
                <div className="kpi-label">Weighed here</div>
                <div style={{ fontSize: 19, fontWeight: 700 }}>{fmtQty(r.accepted_qty, r.purchase_unit)}</div>
                <div style={{ fontSize: 12, color: "var(--slate)" }}>
                  {r.weighbridge_weight_kg ? `${Number(r.weighbridge_weight_kg).toLocaleString()} kg on the weighbridge` : "no weighbridge reading"}
                  {" · "}{fmtMoney(r.value_if_weighed)}
                </div>
                <button type="button" className="btn-primary" style={{ marginTop: 8, fontSize: 13 }}
                        disabled={busy === r.id} onClick={() => confirm(r, "weighed")}>
                  Accept the weighed figure
                </button>
              </div>
              <div style={{ border: "1px solid var(--border)", borderRadius: 5, padding: "10px 12px" }}>
                <div className="kpi-label">Supplier billed</div>
                <div style={{ fontSize: 19, fontWeight: 700 }}>{fmtQty(r.supplier_qty, r.purchase_unit)}</div>
                <div style={{ fontSize: 12, color: "var(--slate)" }}>
                  their invoice / DC · {fmtMoney(r.value_if_supplier)}
                </div>
                <button type="button" style={{ marginTop: 8, fontSize: 13 }}
                        disabled={busy === r.id} onClick={() => confirm(r, "supplier")}>
                  Accept the billed figure
                </button>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input value={note[r.id] || ""} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })}
                     placeholder="Why this decision? (recorded against the receipt)"
                     style={{ flexGrow: 1, minWidth: 220, fontSize: 13 }} />
              {/* A third figure, for when neither number is right — a re-weigh,
                  or a load part-rejected at the gate. Rare, but when it happens
                  forcing a choice between two wrong numbers is worse. */}
              <input type="number" step="0.01" min="0" value={custom[r.id] || ""}
                     onChange={(e) => setCustom({ ...custom, [r.id]: e.target.value })}
                     placeholder={`or enter ${r.purchase_unit}`} style={{ width: 130, fontSize: 13 }} />
              <button type="button" style={{ fontSize: 13 }} disabled={busy === r.id || !custom[r.id]}
                      onClick={() => confirm(r, "entered")}>
                Accept that
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------

function Variance() {
  const [from, setFrom] = useState(monthStartStr());
  const [to, setTo] = useState(todayStr());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setError("");
    apiRequest(`/material-module/reports/variance?from_date=${from}&to_date=${to}`)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [from, to]);

  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;

  const t = data?.totals;

  return (
    <>
      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ fontSize: 12 }}>From<br />
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ fontSize: 13 }} />
        </label>
        <label style={{ fontSize: 12 }}>To<br />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ fontSize: 13 }} />
        </label>
        {t && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 22 }}>
            <div>
              <div className="kpi-label">Loads</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{t.loads}</div>
            </div>
            <div>
              <div className="kpi-label">Net variance</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: varianceColour(t.net_variance_qty) }}>
                {Number(t.net_variance_qty || 0) > 0 ? "+" : ""}{Number(t.net_variance_qty || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
            </div>
            <div>
              <div className="kpi-label">Worth</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: varianceColour(t.net_variance_value) }}>
                {fmtMoney(t.net_variance_value)}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16, fontSize: 12.5, color: "var(--slate)", lineHeight: 1.6 }}>
        <strong style={{ color: "var(--charcoal)" }}>Two columns worth understanding.</strong> <em>Net</em> is what
        you are actually out of pocket by — short loads and over loads cancel. <em>Mean difference</em> ignores
        direction and says how unreliable the weighing is. A supplier whose loads scatter either side nets out
        to nothing while being thoroughly unreliable, and that is a different conversation from one who is
        quietly light every single time. Which is why <em>short</em> against <em>over</em> matters: real
        mis-weighing lands on both sides.
      </div>

      {!data && <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>}

      {data && (
        <>
          {["by_supplier", "by_material"].map((key) => (
            <div key={key} style={{ marginBottom: 22 }}>
              <h3 style={{ fontSize: 15, margin: "0 0 10px" }}>
                {key === "by_supplier" ? "By supplier" : "By material"}
              </h3>
              <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "var(--concrete)" }}>
                      <th style={TH}>{key === "by_supplier" ? "Supplier" : "Material"}</th>
                      <th style={{ ...TH, textAlign: "right" }}>Loads</th>
                      <th style={{ ...TH, textAlign: "right" }}>Billed</th>
                      <th style={{ ...TH, textAlign: "right" }}>Accepted</th>
                      <th style={{ ...TH, textAlign: "right" }}>Net</th>
                      <th style={{ ...TH, textAlign: "right" }}>Mean difference</th>
                      <th style={{ ...TH, textAlign: "right" }}>Short / over</th>
                      <th style={{ ...TH, textAlign: "right" }}>Worth</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data[key].map((r) => (
                      <tr key={r.supplier_id ?? r.material_id} style={{ borderTop: "1px solid var(--border)" }}>
                        <td style={{ ...TD, fontWeight: 600 }}>{r.supplier_name || r.material_name}</td>
                        <td style={{ ...TD, textAlign: "right" }}>{r.loads}</td>
                        <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>{fmtQty(r.billed_qty, r.purchase_unit)}</td>
                        <td style={{ ...TD, textAlign: "right" }}>{fmtQty(r.accepted_qty, r.purchase_unit)}</td>
                        <td style={{ ...TD, textAlign: "right", fontWeight: 600, color: varianceColour(r.net_variance_qty) }}>
                          {Number(r.net_variance_qty) > 0 ? "+" : ""}{Number(r.net_variance_qty).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          <div style={{ fontSize: 11, fontWeight: 400 }}>{Number(r.net_variance_pct).toFixed(2)}%</div>
                        </td>
                        <td style={{ ...TD, textAlign: "right" }}>{Number(r.mean_abs_variance_pct ?? 0).toFixed(2)}%</td>
                        <td style={{ ...TD, textAlign: "right" }}>
                          <span style={{ color: r.short_loads && !r.over_loads ? "var(--alert-red)" : "inherit", fontWeight: r.short_loads && !r.over_loads ? 700 : 400 }}>
                            {r.short_loads}
                          </span>
                          {" / "}{r.over_loads}
                        </td>
                        <td style={{ ...TD, textAlign: "right", fontWeight: 600, color: varianceColour(r.net_variance_value) }}>
                          {fmtMoney(r.net_variance_value)}
                        </td>
                      </tr>
                    ))}
                    {!data[key].length && (
                      <tr><td colSpan={8} style={{ ...TD, color: "var(--slate)" }}>Nothing in this period.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <h3 style={{ fontSize: 15, margin: "0 0 10px" }}>Biggest differences, load by load</h3>
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--concrete)" }}>
                  <th style={TH}>When</th><th style={TH}>Material</th><th style={TH}>Supplier</th>
                  <th style={{ ...TH, textAlign: "right" }}>Billed</th>
                  <th style={{ ...TH, textAlign: "right" }}>Accepted</th>
                  <th style={{ ...TH, textAlign: "right" }}>Difference</th>
                  <th style={TH}>Settled as</th><th style={TH}>Note</th>
                </tr>
              </thead>
              <tbody>
                {data.detail.map((r) => (
                  <tr key={r.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmtWhen(r.received_at)}</td>
                    <td style={TD}>{r.material_name}</td>
                    <td style={TD}>{r.supplier_name}</td>
                    <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>{fmtQty(r.supplier_qty, r.purchase_unit)}</td>
                    <td style={{ ...TD, textAlign: "right" }}>{fmtQty(r.accepted_qty, r.purchase_unit)}</td>
                    <td style={{ ...TD, textAlign: "right", fontWeight: 600, color: varianceColour(r.variance_qty) }}>
                      {Number(r.variance_qty) > 0 ? "+" : ""}{Number(r.variance_qty).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      {" "}({Number(r.variance_pct).toFixed(1)}%)
                    </td>
                    <td style={{ ...TD, fontSize: 12 }}>
                      {r.accepted_basis === "weighed" ? "weighbridge"
                        : r.accepted_basis === "supplier" ? "supplier's figure"
                        : "entered by hand"}
                      {r.confirmed_by_name && <div style={{ color: "var(--slate)" }}>{r.confirmed_by_name}</div>}
                    </td>
                    <td style={{ ...TD, fontSize: 12, color: "var(--slate)", maxWidth: 240 }}>
                      {r.confirm_note || r.short_reason || ""}
                    </td>
                  </tr>
                ))}
                {!data.detail.length && (
                  <tr><td colSpan={8} style={{ ...TD, color: "var(--slate)" }}>No receipts in this period.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

export default function ReceiptVariance() {
  const { can, ready } = usePermissions();
  const [tab, setTab] = useState("waiting");
  const [pendingCount, setPendingCount] = useState(null);

  const canConfirm = ready && can("material.receipt-confirm", "view");
  const canReport = ready && can("material.reports", "view");

  useEffect(() => {
    if (!canConfirm) return;
    let alive = true;
    apiRequest("/material-module/receipts/pending")
      .then((r) => { if (alive) setPendingCount(r.length); })
      .catch(() => {});
    return () => { alive = false; };
  }, [canConfirm, tab]);

  useEffect(() => {
    if (ready && !canConfirm && canReport) setTab("variance");
  }, [ready, canConfirm, canReport]);

  if (!ready) return null;
  if (!canConfirm && !canReport) {
    return (
      <>
        <TopBar title="Receipt differences" />
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 32px" }}>
          <div className="card" style={{ fontSize: 13 }}>
            You don't have access to this. A Super Admin can grant it on the Access Control page.
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar title="Receipt differences" />
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 32px" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {canConfirm && (
            <button type="button" className={`btn-tab ${tab === "waiting" ? "active" : ""}`} onClick={() => setTab("waiting")}>
              Waiting for confirmation
              {pendingCount ? <span style={{ marginLeft: 6, fontWeight: 700, color: "var(--amber)" }}>({pendingCount})</span> : null}
            </button>
          )}
          {canReport && (
            <button type="button" className={`btn-tab ${tab === "variance" ? "active" : ""}`} onClick={() => setTab("variance")}>
              Variance over time
            </button>
          )}
        </div>

        {tab === "waiting" && canConfirm
          ? <Waiting onSettled={() => setPendingCount((n) => (n == null ? n : Math.max(0, n - 1)))} />
          : canReport ? <Variance /> : null}
      </div>
    </>
  );
}
