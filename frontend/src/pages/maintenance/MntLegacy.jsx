// Round 216 — bring records over from the old Maintenance, Breakdowns and
// truck-inspection screens (Administrator, mnt.legacy-import). Old action
// points become PM schedules on the models of the vehicles they covered, with
// each vehicle's last service carried over; open repair points, outside-repair
// requests, inspection action items and breakdowns become jobs on job cards.
// Shown on the Dashboard only while something is left to bring over.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { useLoad, useAction, Msg, fmtDate, H2, MUTED, ROW, Table, SMALL_BTN } from "./mntUi.jsx";

const SECTIONS = [
  ["repair_points", "repair-points", "Repair action points (planned repairs)"],
  ["external_repairs", "external-repairs", "Outside-repair requests"],
  ["action_items", "action-items", "Weekly-inspection action items"],
  ["breakdowns", "breakdowns", "Breakdowns not marked repaired"],
];

export default function MntLegacy() {
  const d = useLoad("/maintenance-module/legacy");
  const [open, setOpen] = useState(false);
  const [skipped, setSkipped] = useState([]);
  const act = useAction(() => d.load());
  if (!d.data) return null;
  const x = d.data;
  const total = x.action_points.length + SECTIONS.reduce((s, [k]) => s + x[k].length, 0);
  if (!total && !act.msg) return null;

  const one = (path, msg) => act.run(() => apiRequest(`/maintenance-module/legacy/${path}`, { method: "POST", body: {} }), msg);
  return (
    <section className="card" style={{ marginBottom: 16, borderColor: "#E9C77B" }}>
      <div style={ROW}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2 style={{ ...H2, margin: 0 }}>From the old maintenance screens</h2>
          <div style={MUTED}>{total} record(s) still on the old Maintenance / Breakdown screens. Bring them into this module once — the old screens are retired.</div>
        </div>
        <button type="button" style={SMALL_BTN} onClick={() => setOpen(!open)}>{open ? "Hide" : "Review"}</button>
        <button type="button" className="btn-primary" style={SMALL_BTN} disabled={act.busy || !total}
          onClick={() => act.run(() => apiRequest("/maintenance-module/legacy-all", { method: "POST", body: {} }), (r) => {
            setSkipped(r.skipped || []);
            return `Brought over ${r.schedules} schedule(s) and ${r.jobs} job(s)${r.skipped?.length ? ` — ${r.skipped.length} left (see below)` : ""}.`;
          })}>Bring everything over</button>
      </div>
      <Msg msg={act.msg} err={act.err} />
      {skipped.length > 0 && (
        <ul style={{ ...MUTED, margin: "0 0 8px 18px" }}>{skipped.slice(0, 12).map((s, i) => <li key={i}>{s}</li>)}</ul>
      )}
      {open && (
        <>
          {x.action_points.length > 0 && (
            <>
              <h3 style={{ fontSize: 13, margin: "12px 0 4px" }}>Maintenance action points → PM schedules</h3>
              <Table minWidth={560}>
                <tbody>
                  {x.action_points.map((ap) => (
                    <tr key={ap.id}>
                      <td><b>{ap.name}</b><div style={MUTED}>{[ap.interval_days && `${ap.interval_days} days`, ap.interval_hours && `${ap.interval_hours} h`, ap.interval_qty_m3 && `${Number(ap.interval_qty_m3)} m³`].filter(Boolean).join(" or ")}</div></td>
                      <td style={MUTED}>{ap.scope.length ? ap.scope.join(", ") : "all trucks"}</td>
                      <td style={{ textAlign: "right" }}><button type="button" style={SMALL_BTN} disabled={act.busy} onClick={() => one(`action-points/${ap.id}`, (r) => `Schedule created for ${r.models} model(s); last-done carried over for ${r.baselines} vehicle(s).`)}>Make schedule</button></td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
          {SECTIONS.map(([key, path, label]) => x[key].length > 0 && (
            <div key={key}>
              <h3 style={{ fontSize: 13, margin: "12px 0 4px" }}>{label} → job cards</h3>
              <Table minWidth={560}>
                <tbody>
                  {x[key].map((r) => (
                    <tr key={r.id}>
                      <td><b>{r.unit || "—"}</b><div style={MUTED}>{fmtDate(r.requested_at || r.raised_at || r.breakdown_time || r.scheduled_date)}</div></td>
                      <td>{r.description || [r.issue_type, r.remarks].filter(Boolean).join(" — ")}{r.status && <div style={MUTED}>{r.status}{r.repair_type ? ` · ${r.repair_type}` : ""}</div>}</td>
                      <td style={{ textAlign: "right" }}>
                        {r.asset_id
                          ? <button type="button" style={SMALL_BTN} disabled={act.busy} onClick={() => one(`${path}/${r.id}`, (o) => `Put on ${o.code} (${o.asset_name}).`)}>To job card</button>
                          : <span style={{ ...MUTED, color: "var(--amber)" }}>Add this vehicle to Equipment first</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ))}
          <p style={{ ...MUTED, marginBottom: 0 }}>An outside repair already approved or at the workshop comes over at a ₹0 approved amount — its bill will then go to the Administrator for approval.</p>
        </>
      )}
    </section>
  );
}
