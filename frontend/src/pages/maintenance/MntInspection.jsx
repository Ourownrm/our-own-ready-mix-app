// Round 215 — PM Inspection (renamed from "PM work orders", owner, 18 Oct).
// Mark each check OK / Not OK; every Not OK and every "other job noticed" goes
// onto ONE job card for the vehicle automatically when it is submitted.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { useLoad, useAction, Loading, Msg, Badge, PM_STATUS, fmtWhen, H2, MUTED, ROW, GRID, Field, Table, SMALL_BTN } from "./mntUi.jsx";

const SEG = { padding: "7px 14px", fontSize: 12.5, minHeight: 38, border: "1px solid var(--border-strong)", cursor: "pointer" };

export default function MntInspection({ go, params }) {
  const due = useLoad("/maintenance-module/due");
  const sched = useLoad("/maintenance-module/schedules");
  const recent = useLoad("/maintenance-module/inspections");
  const scheduleId = Number(params.get("schedule")) || null;
  const assetId = Number(params.get("asset")) || null;
  const [form, setForm] = useState(null);
  const [done, setDone] = useState(null);
  const act = useAction();

  if (!due.data || !sched.data) return <Loading error={due.error || sched.error} />;
  const s = scheduleId ? sched.data.find((x) => x.id === scheduleId) : null;
  const pair = s ? due.data.find((d) => d.schedule_id === scheduleId && d.asset_id === assetId) : null;

  // Start (or restart) a form for the chosen pair.
  if (s && pair && (!form || form.key !== `${scheduleId}-${assetId}`)) {
    setForm({
      key: `${scheduleId}-${assetId}`, km: "", hours: "",
      answers: Object.fromEntries(s.checklist.map((l) => [l, { ok: null, note: "" }])),
      other: [""], tasks: {}, remarks: "",
    });
    setDone(null);
    return null;
  }

  async function submit() {
    const body = {
      schedule_id: scheduleId, asset_id: assetId, km: form.km, hours: form.hours, remarks: form.remarks,
      answers: s.checklist.map((label) => ({ label, ok: form.answers[label].ok, note: form.answers[label].note })),
      other_jobs: form.other.filter((x) => x.trim()),
      tasks_done: Object.keys(form.tasks).filter((k) => form.tasks[k]),
    };
    const r = await act.run(() => apiRequest("/maintenance-module/inspections", { method: "POST", body }));
    if (r) { setDone(r); due.load(); recent.load(); }
  }

  if (done) {
    return (
      <section className="card" style={{ maxWidth: 640 }}>
        <h2 style={H2}>Inspection submitted</h2>
        {done.job_card_id ? (
          <p style={{ fontSize: 13.5 }}>
            {done.jobs_added} job(s) went to job card <b>JC-{String(done.job_card_id).padStart(4, "0")}</b>
            {done.job_card_created ? " (new card)." : " (added to the vehicle’s open card)."}
          </p>
        ) : <p style={{ fontSize: 13.5 }}>Everything OK — no job card needed.</p>}
        <div style={ROW}>
          {done.job_card_id && <button type="button" className="btn-primary" onClick={() => go("job-cards", { card: done.job_card_id })}>Open job card</button>}
          <button type="button" onClick={() => { setForm(null); setDone(null); go("inspection"); }}>Back to due list</button>
        </div>
      </section>
    );
  }

  if (s && pair && form) {
    const nok = Object.values(form.answers).filter((a) => a.ok === false).length;
    const others = form.other.filter((x) => x.trim()).length;
    const answered = Object.values(form.answers).filter((a) => a.ok !== null).length;
    const setAns = (l, v) => setForm({ ...form, answers: { ...form.answers, [l]: { ...form.answers[l], ...v } } });
    return (
      <div style={{ maxWidth: 900 }}>
        <section className="card" style={{ marginBottom: 16 }}>
          <div style={{ ...ROW, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ ...MUTED, textTransform: "uppercase", fontSize: 11.5 }}>PM inspection</div>
              <h1 style={{ fontSize: 20, margin: "2px 0 4px" }}>{pair.asset_name} · {s.name}</h1>
              <div style={MUTED}>{s.trigger} · {pair.left}</div>
            </div>
            <Badge map={PM_STATUS} value={pair.status} />
            <button type="button" style={SMALL_BTN} onClick={() => go("inspection")}>Back</button>
          </div>
          <div style={{ ...GRID(180), marginTop: 12 }}>
            <Field label={`Odometer (km)${["km", "once_km"].includes(s.trigger_type) ? " — required" : ""}`}>
              <input inputMode="decimal" value={form.km} placeholder={pair.km != null ? `last ${pair.km}` : ""} onChange={(e) => setForm({ ...form, km: e.target.value })} />
            </Field>
            <Field label={`Hour meter${s.trigger_type === "hours" ? " — required" : ""}`}>
              <input inputMode="decimal" value={form.hours} placeholder={pair.hours != null ? `last ${pair.hours}` : ""} onChange={(e) => setForm({ ...form, hours: e.target.value })} />
            </Field>
          </div>
        </section>

        <section className="card" style={{ marginBottom: 16 }}>
          <div style={ROW}><h2 style={{ ...H2, flex: 1 }}>Checklist</h2><span style={MUTED}>{answered} of {s.checklist.length} answered</span></div>
          {s.checklist.map((l) => {
            const a = form.answers[l];
            return (
              <div key={l} style={{ ...ROW, padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
                <div style={{ flex: 1, minWidth: 200, fontSize: 13 }}>{l}</div>
                <div role="group" aria-label={l} style={{ display: "flex" }}>
                  <button type="button" aria-pressed={a.ok === true} onClick={() => setAns(l, { ok: true })}
                    style={{ ...SEG, borderRadius: "8px 0 0 8px", background: a.ok === true ? "var(--signal-green)" : "#fff", color: a.ok === true ? "#fff" : "var(--charcoal)" }}>OK</button>
                  <button type="button" aria-pressed={a.ok === false} onClick={() => setAns(l, { ok: false })}
                    style={{ ...SEG, borderLeft: "none", borderRadius: "0 8px 8px 0", background: a.ok === false ? "var(--alert-red)" : "#fff", color: a.ok === false ? "#fff" : "var(--charcoal)" }}>Not OK</button>
                </div>
                {a.ok === false && (
                  <div className="field-input" style={{ flexBasis: "100%" }}>
                    <input aria-label={`What is wrong — ${l}`} placeholder="What is wrong? (this goes to the job card)" value={a.note} onChange={(e) => setAns(l, { note: e.target.value })} />
                  </div>
                )}
              </div>
            );
          })}
          {s.tasks.length > 0 && (
            <>
              <h3 style={{ fontSize: 13, margin: "16px 0 6px" }}>Tasks done</h3>
              {s.tasks.map((t) => (
                <label key={t.task} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, padding: "6px 0" }}>
                  <input type="checkbox" checked={!!form.tasks[t.task]} onChange={(e) => setForm({ ...form, tasks: { ...form.tasks, [t.task]: e.target.checked } })} />
                  {t.task}{t.parts && <span style={MUTED}>· {t.parts}</span>}
                </label>
              ))}
            </>
          )}
          <h3 style={{ fontSize: 13, margin: "16px 0 4px" }}>Other jobs noticed</h3>
          <div style={{ ...MUTED, marginBottom: 6 }}>Anything not on the list — these go to the same job card.</div>
          {form.other.map((o, i) => (
            <div key={i} className="field-input" style={{ marginBottom: 6 }}>
              <input aria-label={`Other job ${i + 1}`} value={o} onChange={(e) => setForm({ ...form, other: form.other.map((x, j) => (j === i ? e.target.value : x)) })} />
            </div>
          ))}
          <button type="button" style={SMALL_BTN} onClick={() => setForm({ ...form, other: [...form.other, ""] })}>+ Add another job</button>
        </section>

        <Msg msg={act.msg} err={act.err} />
        <section className="card" style={{ ...ROW }}>
          <div style={{ flex: 1, minWidth: 240, fontSize: 13 }}>
            {nok + others > 0
              ? <>{nok} Not OK + {others} other job(s) → <b>a job card with {nok + others} job(s)</b> is created on submit (or added to the vehicle’s open card).</>
              : "All OK so far — no job card will be created."}
          </div>
          <button type="button" className="btn-primary" disabled={act.busy} onClick={submit}>Submit inspection</button>
        </section>
      </div>
    );
  }

  // The due list.
  const shown = due.data.filter((d) => d.status !== "done");
  return (
    <>
      <section className="card" style={{ marginBottom: 16 }}>
        <h2 style={H2}>Due list</h2>
        <Table minWidth={680}>
          <thead><tr><th>Equipment</th><th>Schedule</th><th>Left</th><th>Next</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {shown.map((d) => (
              <tr key={`${d.schedule_id}-${d.asset_id}`}>
                <td><b>{d.asset_name}</b></td>
                <td>{d.schedule_name}<div style={MUTED}>{d.trigger}</div></td>
                <td>{d.left}</td>
                <td>{d.next}</td>
                <td><Badge map={PM_STATUS} value={d.status} /></td>
                <td style={{ textAlign: "right" }}><button type="button" style={SMALL_BTN} onClick={() => go("inspection", { schedule: d.schedule_id, asset: d.asset_id })}>Start</button></td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
      <section className="card">
        <h2 style={H2}>Recent inspections</h2>
        {!recent.data ? <div style={MUTED}>Loading…</div> : recent.data.length === 0 ? <div style={MUTED}>None yet.</div> : (
          <Table minWidth={600}>
            <thead><tr><th>When</th><th>Equipment</th><th>Schedule</th><th>Result</th><th>By</th></tr></thead>
            <tbody>
              {recent.data.map((i) => (
                <tr key={i.id}>
                  <td>{fmtWhen(i.done_at)}</td>
                  <td>{i.asset_name}</td>
                  <td>{i.schedule_name}</td>
                  <td>
                    {i.job_card_id
                      ? <button type="button" style={SMALL_BTN} onClick={() => go("job-cards", { card: i.job_card_id })}>{i.not_ok} Not OK · {i.other_jobs} other → JC-{String(i.job_card_id).padStart(4, "0")}</button>
                      : <span className="badge badge-success">All OK</span>}
                  </td>
                  <td>{i.done_by_name}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
