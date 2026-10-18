// Round 215 — Maintenance dashboard: what is due, what is open, and what is
// waiting for somebody's approval.
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { useLoad, Loading, Kpi, Badge, PM_STATUS, fmtRs, H2, MUTED, Table, SMALL_BTN } from "./mntUi.jsx";
import MntLegacy from "./MntLegacy.jsx";

const APPROVAL_LABEL = {
  outside: "Outside repair estimate",
  bill_hold: "Outside bill above approved",
  po: "Purchase order",
};

export default function MntDashboard({ go }) {
  const { can } = usePermissions();
  const { data, error } = useLoad("/maintenance-module/dashboard");
  if (!data) return <Loading error={error} />;
  const k = data.kpis;
  const canInspect = can("mnt.inspections", "create");

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(165px, 1fr))", gap: 12, marginBottom: 18 }}>
        <Kpi label="PM overdue" value={k.overdue} tone={k.overdue ? "bad" : "good"} onClick={() => go("inspection")} />
        <Kpi label="PM due soon" value={k.due_soon} tone={k.due_soon ? "warn" : undefined} sub={k.never ? `${k.never} never done yet` : undefined} onClick={() => go("inspection")} />
        <Kpi label="Open job cards" value={k.open_cards} sub={k.parts_waiting ? `${k.parts_waiting} part request(s) waiting` : undefined} onClick={can("mnt.job-cards", "view") ? () => go("job-cards") : undefined} />
        <Kpi label="To verify" value={k.to_verify} tone={k.to_verify ? "warn" : undefined} onClick={can("mnt.job-cards", "view") ? () => go("job-cards") : undefined} />
        <Kpi label="At outside workshop" value={k.at_workshop} onClick={can("mnt.outside-repairs", "view") ? () => go("outside") : undefined} />
        <Kpi label="Spares below re-order" value={k.low_stock} tone={k.low_stock ? "warn" : undefined} onClick={can("mnt.store", "view") ? () => go("store") : undefined} />
        <Kpi label="Payable" value={fmtRs(k.payable)} onClick={can("mnt.payments", "view") ? () => go("payments") : undefined} />
        <Kpi label="Cost this month" value={fmtRs(k.cost_month)} sub="parts, outside bills, lubricants" />
        <Kpi label="Certificates expired / ≤ 30 d" value={`${k.cert_expired ?? 0} / ${k.cert_due ?? 0}`} tone={k.cert_expired ? "bad" : k.cert_due ? "warn" : undefined}
          onClick={can("mnt.certificates", "view") ? () => go("certificates") : undefined} />
        <Kpi label="Tyres below 4 mm" value={k.tyres_low ?? 0} tone={k.tyres_low ? "bad" : undefined}
          sub={k.battery_warranty ? `${k.battery_warranty} battery warranty ≤ 60 d` : undefined} onClick={can("mnt.tyres", "view") ? () => go("tyres") : undefined} />
      </div>
      {can("mnt.legacy-import", "edit") && <MntLegacy />}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <section className="card" style={{ flex: "1 1 420px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h2 style={{ ...H2, flex: 1 }}>Waiting for approval</h2>
            {data.approvals.length > 0 && <span className="badge badge-warning">{data.approvals.length}</span>}
          </div>
          {data.approvals.length === 0 ? <div style={MUTED}>Nothing waiting.</div> : (
            <Table minWidth={420}>
              <tbody>
                {data.approvals.map((a) => (
                  <tr key={`${a.kind}-${a.id}`}>
                    <td><b>{a.code}</b><div style={MUTED}>{APPROVAL_LABEL[a.kind]}</div></td>
                    <td>{a.asset_name || ""}<div style={MUTED}>{a.detail}</div></td>
                    <td style={{ textAlign: "right" }}>{a.kind === "bill_hold" ? `+${fmtRs(a.amount)}` : fmtRs(a.amount)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button type="button" style={SMALL_BTN} onClick={() => go(a.kind === "po" ? "purchase" : "outside", a.kind === "po" ? { po: a.id } : {})}>Review</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <section className="card" style={{ flex: "1.4 1 520px", minWidth: 0 }}>
          <h2 style={H2}>PM inspections due</h2>
          {data.due.length === 0 ? <div style={MUTED}>Nothing overdue or due soon.</div> : (
            <Table minWidth={560}>
              <thead><tr><th>Equipment</th><th>Schedule</th><th>Left</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {data.due.map((d) => (
                  <tr key={`${d.schedule_id}-${d.asset_id}`}>
                    <td><b>{d.asset_name}</b></td>
                    <td>{d.schedule_name}<div style={MUTED}>{d.trigger}</div></td>
                    <td>{d.left}</td>
                    <td><Badge map={PM_STATUS} value={d.status} /></td>
                    <td style={{ textAlign: "right" }}>
                      {canInspect && <button type="button" style={SMALL_BTN} onClick={() => go("inspection", { schedule: d.schedule_id, asset: d.asset_id })}>Start</button>}
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
