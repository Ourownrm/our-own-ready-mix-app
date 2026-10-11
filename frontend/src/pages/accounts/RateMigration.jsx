// Round 204 — one-time check of the Accountant's rate file before the price
// list is kept by quotations. Each live rate is kept, moved from "all sites"
// onto the customer's sites, or left out (it stops applying from today; its
// history stays). Complete locks direct rate edits — from then on a rate
// changes only through an accepted quotation.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { inr, inr2, fmtDate } from "../../lib/quotationTerms.js";
import { TH, TD, NUM, row, Banner, Modal, Empty, Table } from "./ui.jsx";

const ISSUE = {
  duplicate: ["Two live rates", "badge-danger"],
  no_site: ["All sites", "badge-warning"],
  sample_rate: ["Sample ₹4,500 rate", "badge-danger"],
  no_charges: ["No charges", "badge-neutral"],
};

export default function RateMigration() {
  const { can } = usePermissions();
  const canEdit = can("accounts.rate-migration", "edit");
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("issues");
  const [siteFor, setSiteFor] = useState(null);
  const [busy, setBusy] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { apiRequest("/accounts/rate-migration").then(setD).catch((e) => setError(e.message)); }, [tick]);

  const shown = useMemo(() => (d?.rates || []).filter((r) => filter === "all" || (filter === "issues" ? r.issues.some((i) => i !== "no_charges") && !r.migration_note : !!r.migration_note)), [d, filter]);

  async function act(r, action, extra = {}) {
    setBusy(r.id); setError("");
    try { await apiRequest(`/accounts/rate-migration/${r.id}`, { method: "POST", body: { action, ...extra } }); setTick((t) => t + 1); setSiteFor(null); }
    catch (e) { setError(e.message); }
    setBusy(null);
  }
  async function complete(lock) {
    if (lock && !window.confirm("Lock the old rate screen? From now on a customer's rate changes only through an accepted quotation.")) return;
    try { await apiRequest(`/accounts/rate-migration/${lock ? "complete" : "unlock"}`, { method: "POST" }); setTick((t) => t + 1); }
    catch (e) { setError(e.message); }
  }

  if (!d) return <><Banner>{error}</Banner><Empty>Loading…</Empty></>;
  const open = d.rates.filter((r) => r.issues.some((i) => i !== "no_charges") && !r.migration_note).length;
  return (
    <>
      <Banner>{error}</Banner>
      <div className="card" style={{ marginBottom: 12, fontSize: 13 }}>
        <b>{d.rates.length}</b> live rates from the Accountant's rate file · <b style={{ color: open ? "var(--amber)" : "var(--signal-green)" }}>{open}</b> to check.
        {" "}Rates are kept as they are unless you change them here; they are the price list until each customer accepts a new quotation.
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
          {d.locked_at ? <>
            <span className="badge badge-success">Completed {fmtDate(String(d.locked_at).slice(0, 10))}{d.locked_by ? ` by ${d.locked_by}` : ""} — direct rate edits are locked</span>
            {canEdit && <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => complete(false)}>Unlock</button>}
          </> : canEdit && <button type="button" className="btn-primary" onClick={() => complete(true)}>Complete migration and lock direct edits</button>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {[["issues", "To check"], ["done", "Decided"], ["all", "All"]].map(([k, l]) => <button key={k} type="button" className={`btn-tab ${filter === k ? "active" : ""}`} style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setFilter(k)}>{l}</button>)}
      </div>
      {!shown.length ? <Empty>Nothing here.</Empty> : (
        <Table minWidth={960} head={<>
          <th style={TH}>Customer · site</th><th style={TH}>Grade</th><th style={{ ...TH, textAlign: "right" }}>Rate</th><th style={TH}>From</th>
          <th style={TH}>Charges</th><th style={TH}>Last order</th><th style={TH}>Check</th><th style={TH} />
        </>}>
          {shown.map((r) => (
            <tr key={r.id} style={row}>
              <td style={TD}>{r.customer_name}<div style={{ fontSize: 12, color: r.site_name ? "var(--slate)" : "var(--amber)" }}>{r.site_name || `all sites (${r.customer_sites})`}</div></td>
              <td style={{ ...TD, fontWeight: 700 }}>{r.grade_name}</td>
              <td style={NUM}>{inr2(r.rate_per_m3)}</td>
              <td style={TD}>{fmtDate(r.effective_from)}</td>
              <td style={{ ...TD, fontSize: 11.5, color: "var(--slate)" }}>
                {r.line_pump_charge || r.pumping_charge_lumpsum ? `Pump ₹${inr(r.line_pump_charge || r.pumping_charge_lumpsum)} ` : ""}
                {r.part_load_charge_per_m3 ? `Part load ₹${inr(r.part_load_charge_per_m3)} ` : ""}
                {Number(r.waiting_charge_per_hour) ? `Waiting ₹${inr(r.waiting_charge_per_hour)}` : ""}
              </td>
              <td style={{ ...TD, fontSize: 12 }}>{fmtDate(r.last_order_on)}</td>
              <td style={TD}>
                {r.issues.map((i) => <span key={i} className={`badge ${ISSUE[i][1]}`} style={{ marginRight: 4, fontSize: 11 }}>{ISSUE[i][0]}</span>)}
                {r.migration_note && <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{r.migration_note}</div>}
              </td>
              <td style={{ ...TD, whiteSpace: "nowrap" }}>
                {canEdit && <>
                  <button type="button" style={{ fontSize: 12, padding: "4px 8px", marginRight: 4 }} disabled={busy === r.id} onClick={() => act(r, "keep")}>Keep</button>
                  {r.site_id == null && r.customer_sites > 0 && <button type="button" style={{ fontSize: 12, padding: "4px 8px", marginRight: 4 }} disabled={busy === r.id} onClick={() => setSiteFor(r)}>Set sites</button>}
                  <button type="button" style={{ fontSize: 12, padding: "4px 8px", color: "var(--alert-red)" }} disabled={busy === r.id} onClick={() => act(r, "leave_out")}>Leave out</button>
                </>}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {siteFor && <SitePicker r={siteFor} sites={d.sites.filter((s) => s.customer_id === siteFor.customer_id)} onClose={() => setSiteFor(null)} onSave={(ids) => act(siteFor, "set_site", { site_ids: ids })} />}
    </>
  );
}

function SitePicker({ r, sites, onClose, onSave }) {
  const [sel, setSel] = useState(() => new Set(sites.map((s) => s.id)));
  return (
    <Modal title={`${r.customer_name} · ${r.grade_name} ₹${inr2(r.rate_per_m3)}`} onClose={onClose} width={460}>
      <div style={{ fontSize: 12.5, color: "var(--slate)", marginBottom: 8 }}>This rate is for all sites. Put it on these sites (the all-sites rate stops from today):</div>
      {sites.map((s) => (
        <label key={s.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, padding: "3px 0" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={sel.has(s.id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(s.id); else n.delete(s.id); setSel(n); }} /> {s.name}
        </label>
      ))}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!sel.size} onClick={() => onSave([...sel])}>Put on {sel.size} site(s)</button>
      </div>
    </Modal>
  );
}
