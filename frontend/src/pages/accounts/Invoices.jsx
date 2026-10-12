// Round 204 — sales invoices with the tax shown inside the GST-inclusive rate;
// the Accountant's GST switch (off = the same total, no tax lines); loads held
// because the site has no price; and charges the Manager left out, for the
// Administrator to accept or charge after all.
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { inr, inr2, fmtDate } from "../../lib/quotationTerms.js";
import { daysAgoStr, todayStr } from "../../lib/istDate.js";
import { TH, TD, NUM, row, money, Banner, Empty, Table, Modal, Field } from "./ui.jsx";

export default function Invoices({ params, go }) {
  const view = params.get("view") || "invoices";
  const { can } = usePermissions();
  const VIEWS = [["invoices", "Invoices"], ["held", "Held — no price"], ["waivers", "Charges left out"]];
  return (
    <>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {VIEWS.map(([k, label]) => (
          <button key={k} type="button" className={`btn-tab ${view === k ? "active" : ""}`} onClick={() => go("invoices", { view: k })}>{label}</button>
        ))}
      </div>
      {view === "held" ? <Held canRetry={can("accounts.invoice-gst", "edit")} go={go} />
        : view === "waivers" ? <Waivers canReview={can("orders.charge-waiver-review", "edit")} />
        : <InvoiceList canGst={can("accounts.invoice-gst", "edit")} />}
    </>
  );
}

function InvoiceList({ canGst }) {
  const [f, setF] = useState({ from: daysAgoStr(30), to: todayStr(), status: "all", gst: "", customer_id: "" });
  const [rows, setRows] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);
  const [open, setOpen] = useState(null);

  useEffect(() => { apiRequest("/master/customers").then(setCustomers).catch(() => {}); }, []);
  useEffect(() => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    setRows(null);
    apiRequest(`/accounts/invoices?${qs}`).then(setRows).catch((e) => setError(e.message));
  }, [f]);

  async function toggleGst(inv) {
    setBusy(inv.id); setError("");
    try {
      const r = await apiRequest(`/accounts/invoices/${inv.id}/gst`, { method: "POST", body: { gst_applied: !inv.gst_applied } });
      setRows((rs) => rs.map((x) => (x.id === inv.id ? { ...x, ...r } : x)));
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  const tot = (rows || []).reduce((t, r) => ({ total: t.total + Number(r.total), base: t.base + r.base, gst: t.gst + r.gst, balance: t.balance + r.balance }), { total: 0, base: 0, gst: 0, balance: 0 });
  const inp = { padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 7, fontSize: 13 };
  return (
    <>
      <Banner>{error}</Banner>
      <div className="card" style={{ marginBottom: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
        <select value={f.customer_id} onChange={(e) => setF({ ...f, customer_id: e.target.value })} style={inp}>
          <option value="">All customers</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} style={inp} />
        <span>to</span>
        <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} style={inp} />
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={inp}>
          <option value="all">Paid and unpaid</option><option value="unpaid">Unpaid</option><option value="part_paid">Part paid</option><option value="paid">Paid</option>
        </select>
        <label style={{ display: "flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={f.gst === "off"} onChange={(e) => setF({ ...f, gst: e.target.checked ? "off" : "" })} style={{ width: "auto" }} /> Without GST only</label>
        {rows && <span style={{ marginLeft: "auto" }}>{rows.length} invoices · <b>{money(tot.total)}</b> (base {money(tot.base)} + GST {money(tot.gst)}) · due {money(tot.balance)}</span>}
      </div>
      {!rows ? <Empty>Loading…</Empty> : !rows.length ? <Empty>No invoices in this period.</Empty> : (
        <Table minWidth={980} head={<>
          <th style={TH}>Ticket · date</th><th style={TH}>Customer · site</th><th style={TH}>Grade · m³</th><th style={{ ...TH, textAlign: "right" }}>Rate</th>
          <th style={{ ...TH, textAlign: "right" }}>Concrete</th><th style={{ ...TH, textAlign: "right" }}>Charges</th><th style={{ ...TH, textAlign: "right" }}>Total</th>
          <th style={{ ...TH, textAlign: "right" }}>Base · GST</th><th style={TH}>GST</th><th style={{ ...TH, textAlign: "right" }}>Due</th>
        </>}>
          {rows.map((r) => {
            const charges = Number(r.pumping_charge) + Number(r.part_load_charge) + Number(r.waiting_charge || 0);
            return (
              <tr key={r.id} style={{ ...row, cursor: "pointer" }} onClick={() => setOpen(r)}>
                <td style={TD}><b>{r.ticket_number}</b><div style={{ fontSize: 11.5, color: "var(--slate)" }}>{fmtDate(r.ticket_date)}</div></td>
                <td style={TD}>{r.billing_name || r.customer_name}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{r.site_name}</div></td>
                <td style={TD}>{r.grade_name} · {inr(r.loaded_quantity_m3, 2)}{Number(r.rejected_quantity_m3) > 0 && <div style={{ fontSize: 11, color: "var(--alert-red)" }}>{r.rejected_quantity_m3} returned</div>}</td>
                <td style={NUM}>{r.rate_per_m3 ? inr2(r.rate_per_m3) : "—"}<div style={{ fontSize: 11, color: "var(--slate)" }}>{r.quote_no || (r.rate_source === "rate_file" ? "rate file" : "")}</div></td>
                <td style={NUM}>{inr2(r.concrete_amount)}</td>
                <td style={NUM}>{charges ? inr2(charges) : "—"}</td>
                <td style={{ ...NUM, fontWeight: 700 }}>{inr2(r.total)}</td>
                <td style={{ ...NUM, fontSize: 12, color: "var(--slate)" }}>{r.gst_applied ? `${inr2(r.base)} · ${inr2(r.gst)}` : "no tax shown"}</td>
                <td style={TD} onClick={(e) => e.stopPropagation()}>
                  {canGst ? (
                    <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
                      <input type="checkbox" checked={r.gst_applied} disabled={busy === r.id} onChange={() => toggleGst(r)} style={{ width: "auto" }} />
                      {r.gst_applied ? "Applied" : "Off"}
                    </label>
                  ) : (r.gst_applied ? "Applied" : <span style={{ color: "var(--amber)" }}>Off</span>)}
                </td>
                <td style={{ ...NUM, color: r.balance > 0.01 ? "var(--alert-red)" : "var(--signal-green)" }}>{r.balance > 0.01 ? inr2(r.balance) : "Paid"}</td>
              </tr>
            );
          })}
        </Table>
      )}
      {open && <InvoiceDetail inv={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function InvoiceDetail({ inv, onClose }) {
  const lines = [
    ["Concrete", `${inr(inv.loaded_quantity_m3 - (inv.rejected_quantity_m3 || 0), 2)} m³ × ₹${inr2(inv.rate_per_m3)}`, inv.concrete_amount],
    ...(Number(inv.pumping_charge) ? [["Pump mobilization", "", inv.pumping_charge]] : []),
    ...(Number(inv.part_load_charge) ? [["Part load charge", "", inv.part_load_charge]] : []),
    ...(Number(inv.waiting_charge) ? [["Waiting charge", "", inv.waiting_charge]] : []),
  ];
  return (
    <Modal title={`Invoice · ${inv.ticket_number}`} onClose={onClose} width={520}>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        <b>{inv.billing_name || inv.customer_name}</b>{inv.billing_gstin && ` · GSTIN ${inv.billing_gstin}`}<br />
        {inv.site_name} · {inv.grade_name} · {fmtDate(inv.ticket_date)}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <tbody>
          {lines.map(([a, b, c]) => <tr key={a} style={row}><td style={TD}>{a}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{b}</div></td><td style={NUM}>{inr2(c)}</td></tr>)}
          {inv.gst_applied ? <>
            <tr style={row}><td style={{ ...TD, color: "var(--slate)" }}>Taxable value</td><td style={NUM}>{inr2(inv.base)}</td></tr>
            <tr><td style={{ ...TD, color: "var(--slate)" }}>CGST 9%</td><td style={NUM}>{inr2(inv.cgst)}</td></tr>
            <tr><td style={{ ...TD, color: "var(--slate)" }}>SGST 9%</td><td style={NUM}>{inr2(inv.sgst)}</td></tr>
          </> : <tr style={row}><td style={{ ...TD, color: "var(--amber)" }} colSpan={2}>Without GST — the customer pays the rate quoted; no tax is shown.</td></tr>}
          <tr style={{ ...row, fontWeight: 700 }}><td style={TD}>Total</td><td style={NUM}>{inr2(inv.total)}</td></tr>
          <tr><td style={TD}>Received</td><td style={NUM}>{inr2(inv.paid)}</td></tr>
          <tr style={{ fontWeight: 700 }}><td style={TD}>Due</td><td style={NUM}>{inr2(inv.balance)}</td></tr>
        </tbody>
      </table>
    </Modal>
  );
}

function Held({ canRetry, go }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => { apiRequest("/accounts/invoices/held").then(setRows).catch((e) => setError(e.message)); }, [tick]);
  async function retry() {
    setError(""); setMsg("");
    try { const r = await apiRequest("/accounts/invoices/held/retry", { method: "POST" }); setMsg(`${r.created} invoice(s) raised; ${r.still_held} still without a price.`); setTick((t) => t + 1); }
    catch (e) { setError(e.message); }
  }
  return (
    <>
      <Banner>{error}</Banner><Banner kind="ok">{msg}</Banner>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 13, color: "var(--slate)" }}>Delivered loads with no price for the customer, site and grade on the order date. They invoice as soon as a quotation for the site is accepted.</span>
        {canRetry && <button type="button" style={{ marginLeft: "auto" }} onClick={retry}>Try again now</button>}
      </div>
      {!rows ? <Empty>Loading…</Empty> : !rows.length ? <Empty>Nothing held.</Empty> : (
        <Table head={<><th style={TH}>Ticket · date</th><th style={TH}>Customer · site</th><th style={TH}>Grade</th><th style={{ ...TH, textAlign: "right" }}>m³</th><th style={TH}>Quotation</th></>}>
          {rows.map((r) => (
            <tr key={r.ticket_id} style={row}>
              <td style={TD}><b>{r.ticket_number}</b><div style={{ fontSize: 11.5, color: "var(--slate)" }}>{fmtDate(r.ticket_date)}</div></td>
              <td style={TD}>{r.customer_name}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{r.site_name}</div></td>
              <td style={TD}>{r.grade_name}</td>
              <td style={NUM}>{inr(r.loaded_quantity_m3, 2)}</td>
              <td style={TD}>
                {r.pending_quotation
                  ? <a href="#" onClick={(e) => { e.preventDefault(); go("quotations", { id: String(r.pending_quotation.id) }); }}>{r.pending_quotation.quote_no} ({r.pending_quotation.status.replace("_", " ")})</a>
                  : <a href="#" onClick={(e) => { e.preventDefault(); go("quotations", { new: "1", customer_id: String(r.customer_id), site_id: String(r.site_id) }); }}>No quotation — make one</a>}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

function Waivers({ canReview }) {
  const [status, setStatus] = useState("pending");
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (status === "pump") return;
    setRows(null); apiRequest(`/accounts/waivers?status=${status}`).then(setRows).catch((e) => setError(e.message));
  }, [status, tick]);
  const tabs = (
    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
      {[["pending", "To review"], ["accepted", "Accepted"], ["charged", "Charged after all"], ["pump", "Pump charge to recheck"]].map(([k, l]) => (
        <button key={k} type="button" className={`btn-tab ${status === k ? "active" : ""}`} style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setStatus(k)}>{l}</button>
      ))}
      {status !== "pump" && <span style={{ fontSize: 12.5, color: "var(--slate)", marginLeft: 8 }}>Orders where the Manager chose not to charge pump mobilization or part load.</span>}
    </div>
  );
  if (status === "pump") return <>{tabs}<PumpRecheck /></>;
  return (
    <>
      <Banner>{error}</Banner>
      {tabs}
      {!rows ? <Empty>Loading…</Empty> : !rows.length ? <Empty>Nothing here.</Empty> : (
        <Table minWidth={900} head={<>
          <th style={TH}>Order</th><th style={TH}>Customer · site</th><th style={TH}>Left out, and why</th><th style={TH}>Loads</th>
          <th style={{ ...TH, textAlign: "right" }}>Would add</th><th style={TH} />
        </>}>
          {rows.map((r) => (
            <tr key={r.order_id} style={row}>
              <td style={TD}>#{r.order_id}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{fmtDate(r.order_date)} · {r.grade_name} · {inr(r.order_quantity_m3)} m³</div></td>
              <td style={TD}>{r.customer_name}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{r.site_name}</div></td>
              <td style={{ ...TD, fontSize: 12.5 }}>
                {r.pump_charge_waiver_reason && <div><b>{r.pump_requirement === "boom_pump" ? "Boom" : "Line"} pump:</b> “{r.pump_charge_waiver_reason}”</div>}
                {r.part_load_waiver_reason && <div><b>Part load:</b> “{r.part_load_waiver_reason}”</div>}
                <div style={{ color: "var(--slate)", fontSize: 11.5 }}>by {r.created_by_name || "—"}</div>
              </td>
              <td style={{ ...TD, fontSize: 12 }}>{(r.loads || []).map((l) => `${l.ticket_number} ${l.m3} m³`).join(", ") || "none yet"}</td>
              <td style={NUM}>{money(r.would_add.pump + r.would_add.part_load)}</td>
              <td style={TD}>
                {status === "pending" && canReview ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button type="button" style={{ fontSize: 12, padding: "5px 10px" }} onClick={() => setActing({ r, action: "accept" })}>Accept</button>
                    <button type="button" style={{ fontSize: 12, padding: "5px 10px" }} disabled={r.payment_count > 0} title={r.payment_count > 0 ? "A payment is recorded on this order" : ""} onClick={() => setActing({ r, action: "charge" })}>Charge it</button>
                  </div>
                ) : <span style={{ fontSize: 12, color: "var(--slate)" }}>{r.reviewed_by_name}{r.charge_review_note ? ` — ${r.charge_review_note}` : ""}</span>}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {acting && <WaiverModal {...acting} onClose={() => setActing(null)} onDone={() => { setActing(null); setTick((t) => t + 1); }} />}
    </>
  );
}

// Round 205 — moved here from the Accountant home ("Pump charge review"):
// orders where a later load took the total past the pump's minimum after the
// mobilization charge was billed. Never corrected on its own.
function PumpRecheck() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(null);
  const load = () => apiRequest("/accountant/pump-charge-review").then(setRows).catch((e) => { setError(e.message); setRows([]); });
  useEffect(() => { load(); }, []);
  async function act(orderId, what) {
    if (what === "remove-charge" && !window.confirm("Remove the pump mobilization charge from this order's invoice?")) return;
    setBusy(orderId); setError(""); setNotice("");
    try {
      await apiRequest(`/accountant/pump-charge-review/${orderId}/${what}`, { method: "POST" });
      setNotice(what === "dismiss" ? "Left as it is." : "Pump charge removed.");
      load();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }
  return (
    <>
      <Banner>{error}</Banner>
      <Banner kind="ok">{notice}</Banner>
      <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 10 }}>
        A later load took the order past the pump's minimum quantity after the mobilization charge was billed. Decide whether the charge still stands.
      </div>
      {!rows ? <Empty>Loading…</Empty> : !rows.length ? <Empty>Nothing to recheck.</Empty> : (
        <Table minWidth={760} head={<>
          <th style={TH}>Order</th><th style={TH}>Customer · site</th><th style={TH}>Delivered</th><th style={{ ...TH, textAlign: "right" }}>Pump charge</th><th style={TH} />
        </>}>
          {rows.map((r) => (
            <tr key={r.order_id} style={row}>
              <td style={TD}>#{r.order_id}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{r.pump_requirement === "boom_pump" ? "Boom" : "Line"} pump{r.charged_ticket_number ? ` · on ${r.charged_ticket_number}` : ""}</div></td>
              <td style={TD}>{r.customer_name}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{r.site_name}</div></td>
              <td style={TD}>{inr(r.cumulative_qty)} of {inr(r.order_quantity_m3)} m³</td>
              <td style={NUM}>{r.pumping_charge ? money(r.pumping_charge) : "—"}</td>
              <td style={TD}>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" style={{ fontSize: 12, padding: "5px 10px" }} disabled={busy === r.order_id} onClick={() => act(r.order_id, "dismiss")}>Charge is right</button>
                  <button type="button" className="btn-danger" style={{ fontSize: 12, padding: "5px 10px" }}
                    disabled={busy === r.order_id || Number(r.payment_count) > 0 || !r.invoice_id}
                    title={Number(r.payment_count) > 0 ? "Money is already set against this invoice" : ""}
                    onClick={() => act(r.order_id, "remove-charge")}>Remove charge</button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

function WaiverModal({ r, action, onClose, onDone }) {
  const [note, setNote] = useState("");
  const [pumpAmt, setPumpAmt] = useState(r.would_add.pump || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError("");
    try {
      await apiRequest(`/accounts/waivers/${r.order_id}`, { method: "POST", body: { action, note, charge: { pump_amount: Number(pumpAmt) || undefined } } });
      onDone();
    } catch (e) { setError(e.message); setBusy(false); }
  }
  return (
    <Modal title={action === "accept" ? "Accept — no charge" : "Charge it after all"} onClose={onClose} width={460}>
      <Banner>{error}</Banner>
      {action === "charge" && (
        <div style={{ fontSize: 12.5, marginBottom: 10 }}>
          The order's invoices are re-priced now{r.part_load_waiver_reason ? " — each load below the minimum carries its part load charge" : ""}.
          {r.pump_charge_waiver_reason && <Field label="Pump charge ₹" style={{ marginTop: 8 }}><input type="number" value={pumpAmt} onChange={(e) => setPumpAmt(e.target.value)} /></Field>}
        </div>
      )}
      <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>{action === "accept" ? "Accept" : "Charge"}</button>
      </div>
    </Modal>
  );
}
