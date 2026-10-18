// Round 215 — raise a maintenance complaint. Drivers, Store, the Manager and
// the Plant In Charge (the owner, 18 Oct). It lands as a job on the vehicle's
// open job card (or a new one), Inside or Outside as chosen.
import { useState } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { useLoad, useAction, Msg, Badge, CARD_STATUS, OUTSIDE_STATUS, fmtWhen, H2, MUTED, ROW, GRID, Field, Table } from "./maintenance/mntUi.jsx";

const BLANK = { asset_id: "", description: "", kind: "inside", urgency: "normal", machine_stopped: false, km: "" };

export default function MaintenanceComplaint() {
  const { can } = usePermissions();
  const assets = useLoad("/maintenance-module/asset-options");
  const mine = useLoad("/maintenance-module/complaints");
  const [f, setF] = useState(BLANK);
  const act = useAction(() => { mine.load(); setF(BLANK); });

  return (
    <>
      <TopBar title="Maintenance complaint" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 16px 32px" }}>
        <section className="card" style={{ marginBottom: 16 }}>
          <h2 style={H2}>Raise a complaint</h2>
          <p style={{ ...MUTED, marginTop: 0 }}>It goes on the vehicle’s job card for the maintenance team.</p>
          <Msg msg={act.msg} err={act.err} />
          <div style={GRID(200)}>
            <Field label="Vehicle / machine">
              <select value={f.asset_id} onChange={(e) => setF({ ...f, asset_id: e.target.value })}>
                <option value="">Select…</option>
                {(assets.data || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Odometer km (optional)"><input inputMode="decimal" value={f.km} onChange={(e) => setF({ ...f, km: e.target.value })} /></Field>
          </div>
          <Field label="What is wrong?" style={{ marginTop: 12 }}>
            <textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
          <div style={{ ...ROW, marginTop: 12 }}>
            <span style={MUTED}>Repair</span>
            {[["inside", "Inside (our team)"], ["outside", "Outside workshop"]].map(([k, l]) => (
              <label key={k} style={{ display: "flex", gap: 6, fontSize: 13 }}><input type="radio" name="kind" checked={f.kind === k} onChange={() => setF({ ...f, kind: k })} /> {l}</label>
            ))}
          </div>
          <div style={{ ...ROW, marginTop: 10 }}>
            <span style={MUTED}>Urgency</span>
            {[["normal", "Normal"], ["urgent", "Urgent"], ["breakdown", "Breakdown"]].map(([k, l]) => (
              <label key={k} style={{ display: "flex", gap: 6, fontSize: 13 }}><input type="radio" name="urgency" checked={f.urgency === k} onChange={() => setF({ ...f, urgency: k })} /> {l}</label>
            ))}
            <label style={{ display: "flex", gap: 6, fontSize: 13, marginLeft: 8 }}><input type="checkbox" checked={f.machine_stopped} onChange={(e) => setF({ ...f, machine_stopped: e.target.checked })} /> Machine stopped</label>
          </div>
          <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 14 }}>
            <button type="button" className="btn-primary" disabled={act.busy}
              onClick={() => act.run(() => apiRequest("/maintenance-module/complaints", { method: "POST", body: f }), (r) => `Complaint sent — on job card ${r.code}${r.new_card ? " (new)" : ""}.`)}>Send complaint</button>
          </div>
        </section>

        <section className="card">
          <h2 style={H2}>{can("mnt.job-cards", "view") ? "Recent complaints" : "My complaints"}</h2>
          {!mine.data ? <div style={MUTED}>Loading…</div> : mine.data.length === 0 ? <div style={MUTED}>None yet.</div> : (
            <Table minWidth={600}>
              <thead><tr><th>When</th><th>Vehicle</th><th>Complaint</th><th>Status</th></tr></thead>
              <tbody>
                {mine.data.map((c) => (
                  <tr key={c.id}>
                    <td>{fmtWhen(c.created_at)}<div style={MUTED}>{c.raised_by_name}</div></td>
                    <td>{c.asset_name}</td>
                    <td>{c.description}<div style={MUTED}>{c.kind === "outside" ? "Outside" : "Inside"}{c.urgency !== "normal" ? ` · ${c.urgency}` : ""}{c.machine_stopped ? " · stopped" : ""}</div></td>
                    <td>
                      {c.status === "done" ? <span className="badge badge-success">Done</span>
                        : c.status === "cancelled" ? <span className="badge badge-neutral">Cancelled</span>
                          : c.outside_status ? <Badge map={OUTSIDE_STATUS} value={c.outside_status} /> : <Badge map={CARD_STATUS} value={c.card_status} />}
                      <div style={MUTED}>
                        {can("module.maintenance", "view") && can("mnt.job-cards", "view")
                          ? <Link to={`/maintenance-module?tab=job-cards&card=${c.job_card_id}`}>{c.job_card_code}</Link> : c.job_card_code}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      </div>
    </>
  );
}
