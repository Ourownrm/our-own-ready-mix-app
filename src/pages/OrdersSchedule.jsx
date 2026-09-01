import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import OrderDetailModal from "../lib/OrderDetailModal.jsx";
import { formatOrderNumber } from "../lib/orderNumber.js";

export default function OrdersSchedule() {
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");
  const [detailOrderId, setDetailOrderId] = useState(null);
  const { user } = useAuth();
  const canClose = user?.role === "manager" || user?.role === "administrator";

  async function load() {
    try {
      setOrders(await apiRequest("/orders"));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function closeOrder(order) {
    const reason = window.prompt(
      `Close order for ${order.customer_name} · ${order.site_name}?\n` +
      `This marks it as never-to-be-completed and removes it from the running lists.\n\n` +
      `Reason (optional):`
    );
    if (reason === null) return; // cancelled the prompt
    try {
      await apiRequest(`/orders/${order.id}/close`, { method: "POST", body: { reason } });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const today = orders.filter((o) => isSameDay(o.order_date, new Date()) && !["cancelled", "closed"].includes(o.status));
  const tomorrow = orders.filter((o) => isSameDay(o.order_date, addDays(new Date(), 1)) && !["cancelled", "closed"].includes(o.status));
  const overdue = orders.filter((o) =>
    new Date(o.order_date) < startOfDay(new Date()) &&
    !["completed", "cancelled", "closed"].includes(o.status)
  );

  return (
    <>
      <TopBar title="Today & Tomorrow's Orders" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {/* Round 120, item 2a — the picture-report share feature is a
            manager-specific tool (it's how a manager keeps site staff/
            customers in the loop on the day's schedule); everyone else who
            lands on this shared /orders page — site supervisors, drivers
            checking today's list, etc. — never sees it at all. */}
        {user?.role === "manager" && <PictureReportPanel orders={orders} />}

        {overdue.length > 0 && (
          <OrderTable
            title="Needs attention — carried forward, not yet completed"
            rows={overdue}
            canClose={canClose}
            onClose={closeOrder}
            onView={setDetailOrderId}
          />
        )}
        <OrderTable title="Running today" rows={today} canClose={canClose} onClose={closeOrder} onView={setDetailOrderId} />
        <OrderTable title="Scheduled tomorrow" rows={tomorrow} canClose={canClose} onClose={closeOrder} onView={setDetailOrderId} />
      </div>
      <OrderDetailModal orderId={detailOrderId} onClose={() => setDetailOrderId(null)} />
    </>
  );
}

function OrderTable({ title, rows, canClose, onClose, onView }) {
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No orders.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Customer</th><th>Site</th><th>Grade</th><th>Ordered</th><th>Delivered</th><th>Status</th>
                <th></th>
                {canClose && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td>{o.customer_name}</td>
                  <td>{o.site_name}</td>
                  <td>{o.mix_grade_name}</td>
                  <td>{o.order_quantity_m3} m³</td>
                  <td>{o.delivered_qty_m3} m³</td>
                  <td><StatusBadge status={o.status} /></td>
                  <td>
                    <button style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => onView(o.id)}>View details</button>
                  </td>
                  {canClose && (
                    <td>
                      {!["closed", "cancelled", "completed"].includes(o.status) && (
                        <button className="btn-danger" style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => onClose(o)}>
                          Close order
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    completed: "badge-success", planned: "badge-neutral", in_progress: "badge-info",
    partially_completed: "badge-info", cancelled: "badge-danger", closed: "badge-neutral", dispatched: "badge-info",
    reached_site: "badge-warning", unloading: "badge-progress", created: "badge-neutral",
    batching: "badge-neutral", returned: "badge-neutral", rejected: "badge-danger",
  };
  return <span className={`badge ${map[status] || "badge-neutral"}`}>{status.replace(/_/g, " ")}</span>;
}

function isSameDay(dateStr, d2) {
  const d1 = new Date(dateStr);
  return d1.toDateString() === d2.toDateString();
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Round 119, post-ship again, item 1 — a one-tap shareable image of a day's
// SCHEDULED orders (not yet started — status 'planned'; a running/dispatched
// or completed order drops off this report, per explicit feedback on the
// mockup) with the full order-form field set per order, not a summary.
// Reuses the same html2canvas capture pattern as
// lib/ShareableVisitReport.jsx rather than reinventing it.
function PictureReportPanel({ orders }) {
  // Round 120, item 2a — was defaulting to "today" and fetching/rendering the
  // report immediately on page load. Now nothing is selected (and nothing
  // fetched) until the manager explicitly taps "Today" or "Tomorrow" — the
  // card and Share button only appear after that tap.
  const [day, setDay] = useState(null);
  const [detailed, setDetailed] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState("");
  const captureRef = useRef(null);

  const targetDate = day === "tomorrow" ? addDays(new Date(), 1) : new Date();
  const scheduled = day ? orders.filter((o) => o.status === "planned" && isSameDay(o.order_date, targetDate)) : [];
  const scheduledIds = scheduled.map((o) => o.id).join(",");

  useEffect(() => {
    if (!scheduledIds) { setDetailed([]); return; }
    setLoading(true); setError("");
    Promise.all(scheduledIds.split(",").map((id) => apiRequest(`/orders/${id}`)))
      .then((rows) => setDetailed(rows.sort((a, b) => (a.scheduled_batching_time || "").localeCompare(b.scheduled_batching_time || ""))))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [scheduledIds]);

  async function share() {
    setSharing(true); setError("");
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(captureRef.current, { backgroundColor: "#ffffff", scale: 2 });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const filename = `oorm-${day}-orders-${new Date().toISOString().slice(0, 10)}.png`;
      const file = new File([blob], filename, { type: "image/png" });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: `${day === "today" ? "Today's" : "Tomorrow's"} scheduled orders` });
        } catch {
          // cancelled by the user — not an error
        }
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        window.alert("Sharing images isn't supported on this browser — the report was downloaded instead. Attach it to WhatsApp or email however you'd like to send it.");
      }
    } catch {
      setError("Couldn't create the report image — try again.");
    } finally {
      setSharing(false);
    }
  }

  const totalQty = detailed.reduce((sum, o) => sum + (Number(o.order_quantity_m3) || 0), 0);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Share scheduled orders as a picture</div>
        <div style={{ display: "flex", gap: 4, background: "var(--concrete)", borderRadius: 999, padding: 3 }}>
          <button
            type="button"
            onClick={() => setDay("today")}
            style={{ fontSize: 12, padding: "5px 12px", borderRadius: 999, border: "none", background: day === "today" ? "var(--rebar)" : "transparent", color: day === "today" ? "#fff" : "inherit" }}
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setDay("tomorrow")}
            style={{ fontSize: 12, padding: "5px 12px", borderRadius: 999, border: "none", background: day === "tomorrow" ? "var(--rebar)" : "transparent", color: day === "tomorrow" ? "#fff" : "inherit" }}
          >
            Tomorrow
          </button>
        </div>
      </div>

      {error && <div style={{ color: "var(--alert-red)", fontSize: 12, marginBottom: 8 }}>{error}</div>}

      {!day ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>Tap "Today" or "Tomorrow" above to build the report.</div>
      ) : scheduled.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No scheduled (not yet started) orders for {day}.</div>
      ) : (
        <>
          {/* Round 119, post-ship again — round 6, item 2: this is captured as
              a shared image, almost always viewed on a phone — so it's fixed
              to a mobile-card width regardless of how wide the page itself
              happens to be rendered (a manager's desktop browser, previously
              this stretched to a wide, mostly-empty banner for a single
              order). Orders stack one below another (see the order-list div
              below) rather than side-by-side, so it reads top-to-bottom like
              a phone screen either way — one order or several. */}
          <div ref={captureRef} style={{ background: "#fff", border: "1px solid #DEDAD1", borderRadius: 10, overflow: "hidden", maxWidth: 420, margin: "0 auto" }}>
            {/* Round 120, item 2d/2e — the order-count/total-qty tiles used
                to be a separate full-width strip below the header; moved into
                the header itself, right-aligned, so the header carries both
                identity and the headline numbers in one glance. The
                "generated HH:MM" timestamp used to live in this header's date
                line; it now lives in the footer below the order list (2e) so
                the header stays focused on "what report is this". */}
            <div style={{ background: "#1A1D21", color: "#fff", padding: "16px 18px", borderTop: "5px solid #C75B12", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "#E7E4DC" }}>Our Own Ready Mix</div>
                <div style={{ fontSize: 10.5, color: "#8A8F96", marginBottom: 10 }}>Scheduled orders · shared from OORM Smart App</div>
                <div style={{ fontSize: 26, fontWeight: 800, textTransform: "uppercase" }}>{day === "today" ? "Today" : "Tomorrow"}</div>
                <div style={{ fontSize: 12, color: "#C9CDD2", marginTop: 4 }}>
                  {targetDate.toLocaleDateString([], { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontFamily: "monospace", fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>{detailed.length}</div>
                <div style={{ fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", color: "#9AA0A8", whiteSpace: "nowrap" }}>Orders</div>
                <div style={{ fontFamily: "monospace", fontSize: 22, fontWeight: 800, lineHeight: 1.1, marginTop: 8 }}>{totalQty}</div>
                <div style={{ fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", color: "#9AA0A8", whiteSpace: "nowrap" }}>Total m³</div>
              </div>
            </div>
            <div style={{ padding: "14px 16px 4px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#7D8590", marginBottom: 10 }}>
                Scheduled — not yet started
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 14 }}>
                {loading && detailed.length === 0 && <div style={{ fontSize: 12, color: "var(--slate)" }}>Loading order details...</div>}
                {detailed.map((o) => <PictureReportOrderCard key={o.id} order={o} />)}
              </div>
            </div>
            <div style={{ padding: "8px 16px", borderTop: "1px solid #DEDAD1", textAlign: "center" }}>
              <div style={{ fontSize: 9.5, color: "#9AA0A8" }}>
                Generated {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
          </div>
          <button type="button" className="btn-primary" style={{ width: "100%", marginTop: 10 }} disabled={sharing || loading} onClick={share}>
            {sharing ? "Preparing..." : "Share as image"}
          </button>
        </>
      )}
    </div>
  );
}

// Round 120, item 2b/2c — field set trimmed to exactly what the manager asked
// to keep on the shared picture (everything else — truck interval, site
// contact, sales rep, QC engineer, casting location — is still visible in
// the in-app Order Details modal, just not on this image), reordered to the
// exact sequence requested, and rendered as compact label:value rows instead
// of the old two-column grid of stacked micro-labels — the old layout's
// biggest cost was a full text-height given to every label, which is what
// was reported as "a lot of white space"; a one-line-per-field list at a
// larger font fixes both complaints at once.
function PictureReportOrderCard({ order: o }) {
  const isOverdue = new Date(`${o.order_date?.slice(0, 10)}T${o.scheduled_batching_time || "00:00"}`) < new Date();
  const hasPump = o.pump_requirement !== "without_pump";
  return (
    <div style={{ border: "1px solid #DEDAD1", borderRadius: 8, padding: "11px 12px", background: isOverdue ? "#F8E9E7" : "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 600, color: "#A94B0C" }}>{formatOrderNumber(o.id)}</span>
        <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 8px", borderRadius: 999, background: isOverdue ? "#B03A2E" : "#F5EDDD", color: isOverdue ? "#fff" : "#9C6B12" }}>
          {isOverdue ? "Overdue" : o.scheduled_batching_time?.slice(0, 5)}
        </span>
      </div>
      <div style={{ fontWeight: 700, fontSize: 14.5 }}>{o.customer_name}</div>
      <div style={{ fontSize: 12.5, color: "#5B6470", marginBottom: 6 }}>{o.site_name}</div>
      <div style={{ paddingTop: 6, borderTop: "1px dashed #DEDAD1", fontSize: 13.5 }}>
        <PRRow label="Order date" value={o.order_date?.slice(0, 10)} />
        <PRRow label="Order Qty" value={`${o.order_quantity_m3} m³`} />
        <PRRow label="Mix Grade" value={o.mix_grade_name} />
        <PRRow label="Batching Time" value={o.scheduled_batching_time?.slice(0, 5)} />
        <PRRow label="Required at Site" value={o.required_at_site_time ? o.required_at_site_time.slice(0, 5) : "–"} />
        <PRRow label="Pump" value={hasPump ? (o.pump_code || o.pump_requirement) : "Without pump"} />
        {hasPump && <PRRow label="Pump Leaving Time" value={o.pump_departure_time ? o.pump_departure_time.slice(0, 5) : "–"} />}
        {hasPump && <PRRow label="Pump Crew" value={o.assigned_pump_crew || "–"} />}
        <PRRow label="Site Supervisor" value={o.site_supervisor_name || "None assigned"} />
        <PRRow label="Site Technician" value={o.site_technician_required ? "Required" : "Not required"} />
        <PRRow label="Cube Samples" value={o.cube_samples_required ?? "–"} />
        <PRRow label="Slump" value={o.specified_slump_mm ? `${o.specified_slump_mm} mm` : "–"} />
        <PRRow label="Remarks" value={o.remarks || "–"} stacked />
      </div>
    </div>
  );
}

function PRRow({ label, value, stacked }) {
  if (stacked) {
    return (
      <div style={{ padding: "4px 0" }}>
        <div style={{ color: "#7D8590", fontWeight: 600, fontSize: 11.5, marginBottom: 1 }}>{label}</div>
        <div style={{ fontWeight: 600 }}>{value}</div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "4px 0" }}>
      <span style={{ color: "#7D8590", fontWeight: 600 }}>{label}</span>
      <span style={{ fontWeight: 700, textAlign: "right" }}>{value}</span>
    </div>
  );
}
