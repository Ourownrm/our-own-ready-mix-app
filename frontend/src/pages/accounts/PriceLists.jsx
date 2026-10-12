// Round 204 — each customer / site's price list per grade (rate_master), where
// each rate came from, how much has been supplied, and what is pending with
// the customer. The list changes only by an accepted quotation.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { inr, inr2, fmtDate, splitRate } from "../../lib/quotationTerms.js";
import { TH, TD, NUM, row, money, Banner, Field, Modal, Empty, Table } from "./ui.jsx";

export default function PriceLists({ params, go }) {
  const { can } = usePermissions();
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [bulk, setBulk] = useState(false);
  const cid = params.get("customer_id");

  useEffect(() => { apiRequest("/quotations/price-lists").then(setList).catch((e) => setError(e.message)); }, []);
  const shown = useMemo(() => (list || []).filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase())), [list, search]);

  if (cid) return <CustomerPriceList customerId={cid} go={go} canQuote={can("accounts.quotations", "create")} />;
  return (
    <>
      <Banner>{error}</Banner>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Price lists</h2>
        <span style={{ fontSize: 12.5, color: "var(--slate)" }}>Rates include GST. A rate changes only when the customer accepts a quotation.</span>
        <input type="search" placeholder="Search customer" value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ marginLeft: "auto", padding: "7px 10px", border: "1px solid var(--border-strong)", borderRadius: 7 }} />
        {can("accounts.price-revision", "edit") && <button type="button" onClick={() => setBulk(true)}>Price revision for many customers…</button>}
      </div>
      {!list ? <Empty>Loading…</Empty> : !shown.length ? <Empty>No price lists yet.</Empty> : (
        <Table minWidth={600} head={<>
          <th style={TH}>Customer</th><th style={{ ...TH, textAlign: "right" }}>Sites priced</th><th style={{ ...TH, textAlign: "right" }}>Grades</th><th style={TH}>Notes</th>
        </>}>
          {shown.map((c) => (
            <tr key={c.id} style={{ ...row, cursor: "pointer" }} onClick={() => go("price-lists", { customer_id: String(c.id) })}>
              <td style={{ ...TD, fontWeight: 600 }}>{c.name}</td>
              <td style={NUM}>{c.sites_priced}</td>
              <td style={NUM}>{c.grades_priced}</td>
              <td style={{ ...TD, fontSize: 12 }}>
                {c.has_all_sites_rate && <span className="badge badge-warning" style={{ marginRight: 6 }}>customer-wide rate (old rate file)</span>}
                {Number(c.open_quotations) > 0 && <span className="badge badge-info">{c.open_quotations} quotation(s) open</span>}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {bulk && <BulkRevision onClose={() => setBulk(false)} go={go} />}
    </>
  );
}

function CustomerPriceList({ customerId, go, canQuote }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [hist, setHist] = useState({});
  useEffect(() => { apiRequest(`/quotations/price-lists/${customerId}`).then(setD).catch((e) => setError(e.message)); }, [customerId]);
  if (error) return <><button type="button" onClick={() => go("price-lists")}>← All customers</button><Banner>{error}</Banner></>;
  if (!d) return <Empty>Loading…</Empty>;
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <button type="button" onClick={() => go("price-lists")}>← All customers</button>
        <h2 style={{ margin: 0, fontSize: 18 }}>{d.customer.name}</h2>
        <span style={{ marginLeft: "auto", fontSize: 13 }}>
          Outstanding <b>{money(d.outstanding)}</b>
          {d.credit && <> · credit limit {money(d.credit.payment?.credit_limit)} · {d.credit.payment?.credit_days} days ({d.credit.quote_no})</>}
        </span>
      </div>
      {d.sites.map(({ site, rates, pending, history }) => (
        <div key={site.id} className="card" style={{ marginBottom: 12, padding: 0, overflowX: "auto" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 14px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>{site.name}</h3>
            {pending && (
              <a href="#" onClick={(e) => { e.preventDefault(); go("quotations", { id: String(pending.id) }); }} style={{ fontSize: 12.5 }}>
                {pending.quote_no} with the customer ({pending.status.replace("_", " ")}) — not in force until accepted
              </a>
            )}
            {canQuote && (
              <button type="button" style={{ marginLeft: "auto", fontSize: 12, padding: "5px 10px" }}
                onClick={() => go("quotations", { new: "1", customer_id: String(customerId), site_id: String(site.id) })}>
                {rates.length ? "New quotation" : "Quote this site"}
              </button>
            )}
          </div>
          {!rates.length ? (
            <div style={{ padding: "0 14px 12px", fontSize: 13, color: "var(--slate)" }}>No price for this site — deliveries here are held from invoicing until a quotation is accepted.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
              <thead><tr style={{ background: "var(--concrete)" }}>
                <th style={TH}>Grade</th><th style={{ ...TH, textAlign: "right" }}>Rate incl. GST</th><th style={{ ...TH, textAlign: "right" }}>Base · GST</th>
                <th style={TH}>Since · from</th><th style={TH}>Charges</th><th style={{ ...TH, textAlign: "right" }}>Supplied</th>
                {pending && <th style={{ ...TH, textAlign: "right" }}>Pending quote</th>}
              </tr></thead>
              <tbody>
                {rates.map((r) => {
                  const sp = splitRate(r.rate_per_m3);
                  const pend = pending?.lines?.find((l) => l.mix_grade_id === r.mix_grade_id);
                  const ch = r.charges;
                  return (
                    <tr key={r.id} style={row}>
                      <td style={{ ...TD, fontWeight: 700 }}>{r.grade_name}{r.price_option && <div style={{ fontSize: 11, color: "var(--info)", fontWeight: 400 }}>{r.price_option}</div>}{!r.site_specific && <div style={{ fontSize: 11, color: "var(--amber)", fontWeight: 400 }}>customer-wide</div>}</td>
                      <td style={{ ...NUM, fontWeight: 700 }}>{inr2(r.rate_per_m3)}</td>
                      <td style={{ ...NUM, fontSize: 12, color: "var(--slate)" }}>{inr2(sp.base)} · {inr2(sp.gst)}</td>
                      <td style={{ ...TD, fontSize: 12 }}>{fmtDate(r.effective_from)}<div style={{ color: "var(--slate)" }}>{r.quote_no || (r.source === "rate_file" ? "old rate file" : r.source)}</div></td>
                      <td style={{ ...TD, fontSize: 11.5, color: "var(--slate)" }}>
                        {Number(ch.line_pump_charge) ? `Line pump ₹${inr(ch.line_pump_charge)} <${inr(ch.line_pump_min_qty_m3)} m³` : ""}
                        {Number(ch.boom_pump_charge) ? ` · Boom ₹${inr(ch.boom_pump_charge)}` : ""}
                        {Number(ch.part_load_charge_per_m3) ? ` · Part load ₹${inr(ch.part_load_charge_per_m3)}/m³ <${inr(ch.part_load_min_qty_m3)} m³` : ""}
                        {Number(ch.waiting_charge_per_hour) ? ` · Waiting ₹${inr(ch.waiting_charge_per_hour)}/h` : ""}
                      </td>
                      <td style={NUM}>{inr(r.supplied_m3)} m³{r.committed_qty_m3 ? <div style={{ fontSize: 11, color: "var(--slate)" }}>of {inr(r.committed_qty_m3)} committed</div> : null}</td>
                      {pending && <td style={{ ...NUM, color: "var(--info)" }}>{pend ? inr2(pend.rate) : "—"}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {history.length > 0 && (
            <div style={{ padding: "6px 14px 10px", fontSize: 12 }}>
              <a href="#" onClick={(e) => { e.preventDefault(); setHist({ ...hist, [site.id]: !hist[site.id] }); }}>{hist[site.id] ? "Hide" : "Show"} earlier rates ({history.length})</a>
              {hist[site.id] && history.map((h) => (
                <div key={h.id} style={{ color: "var(--slate)" }}>{h.grade_name} ₹{inr2(h.rate_per_m3)} · {fmtDate(h.effective_from)} – {fmtDate(h.effective_to)} · {h.quote_no || "old rate file"}</div>
              ))}
            </div>
          )}
        </div>
      ))}
      {!d.sites.length && <Empty>This customer has no active sites.</Empty>}
    </>
  );
}

// Cement / diesel price change: a revision for every customer whose price
// list came from an accepted quotation, each waiting for the Administrator's
// approval, then for that customer's acceptance.
function BulkRevision({ onClose, go }) {
  const [f, setF] = useState({ increase: "", reason: "Raw material / diesel price change" });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  async function run(isPreview) {
    setBusy(true); setError("");
    try {
      const r = await apiRequest("/quotations/price-revision", { method: "POST", body: { ...f, increase: Number(f.increase), preview: isPreview } });
      if (isPreview) setPreview(r); else setDone(r);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }
  return (
    <Modal title="Price revision for many customers" onClose={onClose} width={640}>
      <Banner>{error}</Banner>
      {done ? (
        <>
          <Banner kind="ok">{done.made.length} revision(s) made, waiting for approval: {done.made.join(", ") || "none"}.</Banner>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={onClose}>Close</button>
            <button type="button" className="btn-primary" onClick={() => { onClose(); go("quotations"); }}>Open the register</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
            <Field label="Change ₹ per m³ (incl. GST)" hint="Negative to reduce."><input type="number" value={f.increase} onChange={(e) => { setF({ ...f, increase: e.target.value }); setPreview(null); }} /></Field>
            <Field label="Reason (printed in each revision's history)"><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          </div>
          {preview && (
            <div style={{ fontSize: 12.5, maxHeight: 260, overflowY: "auto", marginBottom: 10 }}>
              <b>{preview.candidates.filter((c) => !c.skipped).length} revision(s) will be made:</b>
              {preview.candidates.map((c) => (
                <div key={c.id} style={{ color: c.skipped ? "var(--slate)" : undefined }}>{c.customer_name} · {c.site_name} · {c.quote_no}{c.skipped ? ` — skipped: ${c.skipped}` : ""}</div>
              ))}
              {preview.rate_file_only.length > 0 && (
                <>
                  <div style={{ marginTop: 8 }}><b>Still on the old rate file (no quotation to revise — quote them separately):</b></div>
                  {preview.rate_file_only.map((r, i) => <div key={i} style={{ color: "var(--slate)" }}>{r.customer_name} · {r.site_name}</div>)}
                </>
              )}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={onClose}>Cancel</button>
            {!preview ? <button type="button" disabled={busy || !Number(f.increase)} onClick={() => run(true)}>Preview</button>
              : <button type="button" className="btn-primary" disabled={busy} onClick={() => run(false)}>Make the revisions</button>}
          </div>
        </>
      )}
    </Modal>
  );
}
