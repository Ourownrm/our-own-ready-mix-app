// Round 153, punch-list item 1 — today's delivery notes, with open/print.
//
// One component, used on the Plant Operator screen, the Lab Technician screen
// and the QC Engineer screen. Deliberately one component and not three copies:
// the list, the permission check and the print call are the same everywhere,
// and three copies would drift the moment one of them was fixed.
//
// It renders NOTHING at all when the person does not hold
// orders.challan-print / view. That is the Super Admin's switch (Access
// Control page), and it is enforced on the server too — the routes behind
// this carry requirePermission, so hiding the list here is tidiness, not
// security. A person who kept a URL still gets a 403.
//
// Collapsed by default. This sits underneath the Plant Operator's working
// controls, and a plant screen that has to be scrolled past twenty notes to
// reach the breakdown button is worse than no list at all. The header shows
// the count, so the useful part is visible without opening it.
import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "./api.js";
import { usePermissions } from "./PermissionContext.jsx";

function fmtTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function TodaysDeliveryNotes({ style }) {
  const { can, ready } = usePermissions();
  const allowed = ready && can("orders.challan-print", "view");

  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [printing, setPrinting] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await apiRequest("/delivery-notes/today"));
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoaded(true);
    }
  }, []);

  // Fetch once the person is known to be allowed — not before, so a role
  // without the permission never fires a request that would only 403.
  useEffect(() => {
    if (!allowed) return;
    load();
    // Slower than the Plant Operator screen's own 20s refresh on purpose:
    // this is a reference list, not a working queue, and it is usually shut.
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [allowed, load]);

  async function print(id) {
    setPrinting(id);
    setError("");
    try {
      const { generateDeliveryChallanPdf } = await import("./deliveryChallanPdf.js");
      // "delivery-notes" — the permission-gated endpoint. Passing the
      // Administrator one here would 403 for every role this component exists
      // for, which is the whole point of the second source.
      await generateDeliveryChallanPdf(id, "delivery-notes");
    } catch (err) {
      setError(err.message);
    } finally {
      setPrinting(null);
    }
  }

  if (!allowed) return null;

  return (
    <div className="card" style={{ marginTop: 16, ...style }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                 background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer" }}
        aria-expanded={open}
      >
        <span style={{ fontSize: 14, fontWeight: 700 }}>
          Today&rsquo;s delivery notes{loaded ? ` (${rows.length})` : ""}
        </span>
        <span aria-hidden="true" style={{ fontSize: 12, color: "var(--slate)" }}>{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 8 }}>{error}</div>}
          {!loaded ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading&hellip;</div>
          ) : rows.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>No delivery notes raised yet today.</div>
          ) : (
            rows.map((r) => (
              <div
                key={r.id}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                         padding: "8px 0", borderBottom: "1px solid var(--hairline, #E4E1DA)" }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {r.ticket_number} &middot; {r.truck_number}
                    <span style={{ fontWeight: 400, color: "var(--slate)" }}> &middot; {fmtTime(r.created_at)}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--slate)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.customer_name} &middot; {r.site_name} &middot; {r.mix_grade_name} &middot; {Number(r.loaded_quantity_m3 || 0).toFixed(2)} m&sup3;
                  </div>
                </div>
                <button
                  type="button"
                  style={{ flex: "0 0 auto", padding: "6px 12px", fontSize: 12 }}
                  disabled={printing === r.id}
                  onClick={() => print(r.id)}
                  title="Open the Delivery Challan as a PDF — print it from there"
                >
                  {printing === r.id ? "Opening…" : "Open / print"}
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
