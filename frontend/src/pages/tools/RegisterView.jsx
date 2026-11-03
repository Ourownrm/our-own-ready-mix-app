// Round 264 — Maintenance → Tools & power tools, and HR → Personal assets.
// One screen for both (group "tools" | "assets"): the register, issue → approve
// → accept, take back, damaged / lost decisions, and (tools) lists to confirm
// and removals. Personal assets are the Administrator's: added straight away,
// the issue approved by the Administrator, and the handover form printed.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { Modal, PhotoModal } from "../accounts/ui.jsx";
import { Field, Msg, MUTED, ROW, GRID, SMALL_BTN, fmtDate, fmtWhen, fmtRs, useLoad, Loading, Table, H2, Kpi } from "../maintenance/mntUi.jsx";
import { StatusBadge, IssueModal, ReturnModal, DamageModal, ItemModal, AddListModal, BatchesCard, RemovalsCard, useFiltered, isOverdue, nextMonth, KIND_LABEL, GROUP_KINDS } from "./toolsShared.jsx";
import { printAssetForm } from "./assetForm.js";

export default function RegisterView({ group = "tools" }) {
  const { can } = usePermissions();
  const assets = group === "assets";
  const viewKey = assets ? "hr.assets" : "tools.register";
  const issueKey = assets ? "hr.assets" : "tools.issue";
  const approveKey = assets ? "hr.asset-approve" : "tools.approve";
  const mayView = can(viewKey, "view");
  const mayIssue = can(issueKey, "create"), mayReturn = can(issueKey, "edit"), mayApprove = can(approveKey, "edit");
  const mayDecide = can("tools.loss-decide", "edit"), mayAdd = can(viewKey, "create"), mayEdit = can(viewKey, "edit");
  const mayReport = can("tools.report-damage", "create");
  const meta = useLoad("/tools/meta");
  const items = useLoad(mayView ? `/tools/items?group=${group}` : null);
  const issues = useLoad(mayIssue || mayApprove || can(issueKey, "view") ? `/tools/issues?assets=${assets ? 1 : 0}` : null);
  const decisions = useLoad(mayDecide || can(issueKey, "view") ? "/tools/decisions" : null);
  const batches = useLoad(!assets ? "/tools/batches" : null);
  const removals = useLoad("/tools/removals");
  const [modal, setModal] = useState(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const reload = (m) => { if (m) setMsg(m); setModal(null); items.load(); issues.load(); decisions.load(); batches.load(); removals.load(); meta.load(); };
  const list = useFiltered(items.data?.items, { q, status, kind });
  if (!meta.data) return <Loading error={meta.error} />;
  const all = items.data?.items || [];
  const today = items.data?.today || "";
  const pending = (issues.data || []).filter((s) => s.status === "pending");
  const toDecide = (decisions.data || []).filter((x) => !x.decision && (assets ? x.for_assets : !x.for_assets));
  const perm = all.filter((i) => i.status === "issued" && i.mode === "permanent").length;
  const temp = all.filter((i) => i.status === "issued" && i.mode === "temporary").length;
  const overdue = all.filter((i) => isOverdue(i, today)).length;
  const act = async (fn, ok) => { setErr(""); try { await fn(); reload(ok); } catch (e) { setErr(e.message); } };

  return (
    <>
      <div style={{ ...ROW, marginBottom: 12 }}>
        <h1 style={{ fontSize: 19, margin: 0 }}>{assets ? "Personal assets register" : "Tools & power tools register"}</h1>
        <span style={MUTED}>{assets ? "Laptops, phones, SIMs, printers … issued to employees — Administrator, under HR." : "Issued temporarily or permanently — Store issues, Plant In Charge approves."}</span>
        <div style={{ marginLeft: "auto", ...ROW }}>
          {mayAdd && <button type="button" onClick={() => setModal({ kind: assets ? "asset-add" : "add" })}>{assets ? "+ Add asset" : "+ Add existing tools"}</button>}
          {mayReport && !assets && <button type="button" onClick={() => setModal({ kind: "damage" })}>Report damaged</button>}
          {mayIssue && <button type="button" className="btn-primary" onClick={() => setModal({ kind: "issue" })}>{assets ? "Hand over" : "+ Issue tools"}</button>}
        </div>
      </div>
      <Msg msg={msg} err={err} />
      {!assets && <div style={{ ...MUTED, marginBottom: 10 }}>New tools come in through a GRV (Parts, PO &amp; GRV) on a store item in the Tools or Power tools &amp; equipment category — each gets its ID, and can be issued to a person right there.</div>}
      {assets && <div style={{ ...MUTED, marginBottom: 10 }}>Assets bought on a PO come in through a GRV on a store item in the Personal assets category. Anything you already have: “+ Add asset”.</div>}

      <div style={{ ...GRID(150), marginBottom: 14 }}>
        <Kpi label="Waiting for approval" value={pending.length} tone={pending.length ? "warn" : undefined} />
        <Kpi label="Permanent with employees" value={perm} />
        <Kpi label="Temporary out" value={temp} />
        <Kpi label="Temporary overdue" value={overdue} tone={overdue ? "bad" : undefined} onClick={() => setStatus("out")} />
        <Kpi label="In store" value={all.filter((i) => i.status === "in_store").length} />
        <Kpi label="Damaged / lost to decide" value={toDecide.length} tone={toDecide.length ? "bad" : undefined} />
      </div>

      {mayApprove && pending.length > 0 && (
        <section className="card" style={{ borderColor: "var(--amber)", marginBottom: 14 }}>
          <h2 style={H2}>To approve</h2>
          {pending.map((s) => <ApproveRow key={s.id} s={s} act={act} />)}
        </section>
      )}
      {!mayApprove && pending.length > 0 && (
        <section className="card" style={{ marginBottom: 14 }}>
          <h2 style={H2}>Waiting for the {assets ? "Administrator" : "Plant In Charge"}</h2>
          {pending.map((s) => (
            <div key={s.id} style={{ ...ROW, borderTop: "1px solid var(--border)", padding: "6px 0", fontSize: 13 }}>
              <b>{s.employee}</b><span style={MUTED}>{s.mode}{s.return_by ? ` · back by ${fmtDate(s.return_by)}` : ""} · {(s.lines || []).map((l) => l.code).join(", ")}</span>
              {mayIssue && <button type="button" style={{ ...SMALL_BTN, marginLeft: "auto" }} onClick={() => act(() => apiRequest(`/tools/issues/${s.id}/cancel`, { method: "POST" }), "Issue cancelled.")}>Cancel</button>}
            </div>
          ))}
        </section>
      )}
      {toDecide.length > 0 && (
        <section className="card" style={{ borderColor: "var(--alert-red)", marginBottom: 14 }}>
          <h2 style={H2}>Damaged / lost on return</h2>
          {toDecide.map((x) => <DecideRow key={x.id} x={x} mayDecide={mayDecide} act={act} />)}
        </section>
      )}
      {!assets && <BatchesCard batches={batches.data} kinds={GROUP_KINDS.tools} canConfirm={can("tools.removal-approve", "edit")} onChanged={reload} />}
      {!assets && <RemovalsCard removals={removals.data} kinds={GROUP_KINDS.tools} can={can} onChanged={reload} onPhoto={(r) => setModal({ kind: "photo", r })} />}

      {mayView && (
        <section className="card">
          <div style={{ ...ROW, marginBottom: 10 }}>
            {!assets && <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: "auto" }}><option value="">Tools &amp; power tools</option><option value="tool">Tools</option><option value="power_tool">Power tools</option></select>}
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
              <option value="">Any status</option><option value="out">With employees</option><option value="in_store">In store</option>
              <option value="issue_pending">Waiting for approval</option><option value="repair">At repair</option><option value="removal_pending">Removal pending</option>
            </select>
            <input style={{ marginLeft: "auto", width: 230 }} placeholder="Search ID, item, serial, employee" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {!items.data ? <Loading error={items.error} /> : (
            <Table minWidth={860}>
              <thead><tr><th>ID</th><th>Item</th><th>Make · serial</th><th>With / where</th><th>Issue</th><th>Status</th><th /></tr></thead>
              <tbody>
                {list.map((i) => (
                  <tr key={i.id} style={isOverdue(i, today) ? { background: "var(--alert-red-bg)" } : undefined}>
                    <td><button type="button" style={{ ...SMALL_BTN, fontWeight: 700 }} onClick={() => setModal({ kind: "item", id: i.id })}>{i.code}</button></td>
                    <td>{i.type_name}<div style={MUTED}>{KIND_LABEL[i.kind]}</div></td>
                    <td>{i.make_model || "—"}{i.serial_no && <div style={MUTED}>{i.serial_no}</div>}</td>
                    <td>{i.employee_name ? <><b>{i.employee_name}</b><div style={MUTED}>{i.employee_designation || i.emp_code}</div></> : i.location || "—"}</td>
                    <td>{i.status === "issued" || i.status === "issue_pending"
                      ? <>{i.mode === "permanent" ? <span className="badge badge-violet">Permanent</span> : <span className="badge badge-info">Temporary</span>}
                          <div style={{ ...MUTED, color: isOverdue(i, today) ? "var(--alert-red)" : undefined }}>{i.mode === "temporary" ? `back by ${fmtDate(i.return_by)}` : "keeps it"}{i.status === "issued" && !i.accepted_at ? " · not accepted yet" : ""}</div></>
                      : <span style={MUTED}>—</span>}</td>
                    <td><StatusBadge s={i.status} /></td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {i.status === "issued" && mayReturn && i.line_id && <button type="button" style={SMALL_BTN} onClick={() => setModal({ kind: "return", item: i })}>Take back</button>}
                      {i.status === "repair" && mayEdit && <button type="button" style={SMALL_BTN} onClick={() => act(() => apiRequest(`/tools/items/${i.id}/repaired`, { method: "POST" }), `${i.code} back from repair.`)}>Back from repair</button>}
                      {assets && ["issued", "issue_pending"].includes(i.status) && <button type="button" style={SMALL_BTN} onClick={() => printAssetForm(i, all)}>Print form</button>}
                    </td>
                  </tr>
                ))}
                {!list.length && <tr><td colSpan={7} style={MUTED}>{all.length ? "Nothing matches." : assets ? "No assets yet — “+ Add asset”." : "No tools yet — add the existing ones, or receive them on a GRV."}</td></tr>}
              </tbody>
            </Table>
          )}
        </section>
      )}

      {modal?.kind === "issue" && <IssueModal group={group} meta={meta.data} items={all} onClose={() => setModal(null)} onDone={reload} />}
      {modal?.kind === "return" && <ReturnModal item={modal.item} onClose={() => setModal(null)} onDone={reload} />}
      {modal?.kind === "damage" && <DamageModal items={all} reasons={meta.data.reasons} onClose={() => setModal(null)} onDone={reload} />}
      {modal?.kind === "item" && <ItemModal id={modal.id} canEdit={mayEdit} onClose={() => setModal(null)} onChanged={() => items.load()} />}
      {modal?.kind === "add" && <AddListModal kinds={GROUP_KINDS.tools} meta={meta.data} title="Add existing tools & power tools" onClose={() => setModal(null)} onDone={reload} />}
      {modal?.kind === "asset-add" && <AssetAddModal meta={meta.data} onClose={() => setModal(null)} onDone={reload} />}
      {modal?.kind === "photo" && <PhotoModal path={`/tools/removals/${modal.r.id}/photo`} title={`${modal.r.code} · photo`} onClose={() => setModal(null)} />}
    </>
  );
}

function ApproveRow({ s, act }) {
  const [note, setNote] = useState("");
  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "8px 0", fontSize: 13 }}>
      <div style={ROW}>
        <b>{s.employee}</b><span style={MUTED}>{s.designation || s.emp_code}</span>
        {s.mode === "permanent" ? <span className="badge badge-violet">Permanent</span> : <span className="badge badge-info">Temporary · back by {fmtDate(s.return_by)}</span>}
        {s.kit_name && <span className="badge badge-neutral">{s.kit_name}</span>}
        {s.grv_id && <span className="badge badge-neutral">from GRV-{String(s.grv_id).padStart(4, "0")}</span>}
      </div>
      <div style={{ margin: "4px 0" }}>{(s.lines || []).map((l) => `${l.code} ${l.name}${l.serial_no ? ` (${l.serial_no})` : ""}`).join(" · ")}</div>
      <div style={MUTED}>By {s.requested_by_name} {fmtWhen(s.requested_at)}{s.note ? ` — ${s.note}` : ""}</div>
      <div style={{ ...ROW, marginTop: 6 }}>
        <input style={{ width: 220 }} placeholder="Note (needed to reject)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="button" className="btn-primary" style={SMALL_BTN} onClick={() => act(() => apiRequest(`/tools/issues/${s.id}/decide`, { method: "POST", body: { action: "approve", note } }), `Approved — ${s.employee} accepts on the phone.`)}>Approve</button>
        <button type="button" style={SMALL_BTN} onClick={() => act(() => apiRequest(`/tools/issues/${s.id}/decide`, { method: "POST", body: { action: "reject", note } }), "Rejected — the items are back in store.")}>Reject</button>
      </div>
    </div>
  );
}

function DecideRow({ x, mayDecide, act }) {
  const [f, setF] = useState({ decision: "no_charge", amount: x.purchase_value || "", month: nextMonth(), write_off: false, note: "" });
  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "8px 0", fontSize: 13 }}>
      <div><b>{x.code}</b> {x.name} — <span style={{ color: "var(--alert-red)" }}>{x.return_condition}</span> · {x.employee}{x.return_note ? ` — ${x.return_note}` : ""}</div>
      <div style={MUTED}>Taken back by {x.returned_by_name} {fmtWhen(x.returned_at)}{x.purchase_value ? ` · value ${fmtRs(x.purchase_value, 2)}` : ""}</div>
      {mayDecide ? (
        <div style={{ ...ROW, marginTop: 6, alignItems: "flex-end" }}>
          <Field label="Decision"><select value={f.decision} onChange={(e) => setF({ ...f, decision: e.target.value })}>
            <option value="no_charge">No charge</option><option value="repair">Repair at company cost</option><option value="recover">Recover from salary</option>
          </select></Field>
          {f.decision === "recover" && <>
            <Field label="Amount ₹"><input inputMode="decimal" style={{ width: 110 }} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="From salary of"><input type="month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} /></Field>
          </>}
          {x.return_condition === "damaged" && f.decision !== "repair" && <label style={{ ...ROW, gap: 6, fontSize: 12.5 }}><input type="checkbox" style={{ width: "auto" }} checked={f.write_off} onChange={(e) => setF({ ...f, write_off: e.target.checked })} /> Write it off</label>}
          <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <button type="button" className="btn-primary" style={SMALL_BTN} onClick={() => act(() => apiRequest(`/tools/lines/${x.id}/decide`, { method: "POST", body: f }), "Decided.")}>Save</button>
        </div>
      ) : <div style={{ ...MUTED, color: "var(--amber)" }}>Waiting for the Administrator.</div>}
    </div>
  );
}

// Personal assets: the Administrator adds them straight away.
function AssetAddModal({ meta, onClose, onDone }) {
  const types = meta.types.filter((t) => t.kind === "asset" && t.is_active);
  const [f, setF] = useState({ type_id: types[0]?.id || "", qty: "1", make_model: "", serial_no: "", purchase_value: "", purchase_date: "", warranty_until: "", location: "", details: {} });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const t = types.find((x) => String(x.id) === String(f.type_id));
  const phone = t && /phone|sim/i.test(t.name);
  const d = (k, l) => <Field key={k} label={l}><input value={f.details[k] || ""} onChange={(e) => setF({ ...f, details: { ...f.details, [k]: e.target.value } })} /></Field>;
  return (
    <Modal title="Add a personal asset" onClose={onClose} width={620}>
      <Msg err={err} />
      <div style={GRID(170)}>
        <Field label="Asset"><select value={f.type_id} onChange={(e) => setF({ ...f, type_id: e.target.value })}>{types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="How many"><input inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
        <Field label="Make / model"><input value={f.make_model} onChange={(e) => setF({ ...f, make_model: e.target.value })} /></Field>
        {Number(f.qty) === 1 && <Field label="Serial no."><input value={f.serial_no} onChange={(e) => setF({ ...f, serial_no: e.target.value })} /></Field>}
        <Field label="Value ₹"><input inputMode="decimal" value={f.purchase_value} onChange={(e) => setF({ ...f, purchase_value: e.target.value })} /></Field>
        <Field label="Bought on"><input type="date" value={f.purchase_date} onChange={(e) => setF({ ...f, purchase_date: e.target.value })} /></Field>
        <Field label="Warranty until"><input type="date" value={f.warranty_until} onChange={(e) => setF({ ...f, warranty_until: e.target.value })} /></Field>
        <Field label="Kept at (if shared)"><input value={f.location} placeholder="e.g. Plant office" onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
        {phone && [d("mobile_no", "Mobile no."), d("provider", "Provider"), d("iccid", "SIM ICCID"), d("plan", "Plan & usage limit"), d("imei1", "IMEI 1"), d("imei2", "IMEI 2"), d("accessories", "Accessories")]}
      </div>
      <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={async () => {
          setBusy(true); setErr("");
          try {
            const o = await apiRequest("/tools/items/add", { method: "POST", body: { rows: [{ ...f, type_id: Number(f.type_id), qty: Number(f.qty) }] } });
            onDone(`Added ${o.codes.join(", ")}.`);
          } catch (e) { setErr(e.message); setBusy(false); }
        }}>Add</button>
      </div>
    </Modal>
  );
}
