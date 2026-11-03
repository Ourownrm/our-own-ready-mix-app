// Round 264 — My tools & assets (every employee's phone): check and accept
// what was issued, see what I hold and when temporary items go back, tell
// Store about a problem. People who may report a damaged mould / pipe
// (Lab Technician, Site Supervisor …) do it from here too.
import { useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { TopBar } from "../../lib/TopBar.jsx";
import { usePermissions } from "../../lib/PermissionContext.jsx";
import { Modal } from "../accounts/ui.jsx";
import { Field, Msg, MUTED, ROW, SMALL_BTN, fmtDate, useLoad, Loading, H2 } from "../maintenance/mntUi.jsx";
import { DamageModal, KIND_LABEL } from "./toolsShared.jsx";

export default function MyTools() {
  const { can } = usePermissions();
  const my = useLoad(can("tools.my", "view") ? "/tools/my" : null);
  const mayReport = can("tools.report-damage", "create");
  const inUse = useLoad(mayReport ? "/tools/items?group=in-use" : null);
  const meta = useLoad(mayReport ? "/tools/meta" : null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [modal, setModal] = useState(null);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const done = (m) => { setMsg(m); setModal(null); my.load(); inUse.load(); };
  const d = my.data;
  return (
    <>
      <TopBar title="My tools & assets" />
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "0 16px 32px" }}>
        <Msg msg={msg} err={err} />
        {can("tools.my", "view") && (!d ? <Loading error={my.error} /> : !d.employee ? (
          <div className="card" style={{ fontSize: 13 }}>Your login is not linked to an employee record yet — HR links it under Employees.</div>
        ) : (<>
          {d.to_accept.map((s) => <AcceptCard key={s.id} s={s} onDone={done} setErr={setErr} />)}
          {d.waiting.length > 0 && (
            <section className="card" style={{ marginBottom: 12 }}>
              <h2 style={H2}>Coming to you</h2>
              {d.waiting.map((s) => <div key={s.id} style={{ fontSize: 13, borderTop: "1px solid var(--border)", padding: "6px 0" }}>{(s.lines || []).map((l) => `${l.code} ${l.name}`).join(" · ")}<div style={MUTED}>Waiting for approval · {s.mode}</div></div>)}
            </section>
          )}
          <section className="card" style={{ marginBottom: 12 }}>
            <h2 style={H2}>With me · {d.items.length}</h2>
            {d.items.map((i) => {
              const late = i.mode === "temporary" && i.return_by && i.return_by < today;
              return (
                <div key={i.id} style={{ ...ROW, borderTop: "1px solid var(--border)", padding: "8px 0", fontSize: 13 }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <b>{i.code}</b> {i.type_name}{i.make_model ? ` · ${i.make_model}` : ""}
                    <div style={{ ...MUTED, color: late ? "var(--alert-red)" : undefined }}>{KIND_LABEL[i.kind]} · {i.mode === "temporary" ? `return by ${fmtDate(i.return_by)}${late ? " — overdue" : ""}` : "permanent"}</div>
                  </div>
                  <button type="button" style={SMALL_BTN} onClick={() => setModal({ kind: "report", item: i })}>Report a problem</button>
                </div>
              );
            })}
            {!d.items.length && <div style={MUTED}>Nothing is issued to you.</div>}
          </section>
          <div style={{ ...MUTED, marginBottom: 14 }}>To ask for a tool, ask Store — they issue it and the Plant In Charge approves.</div>
        </>))}
        {mayReport && (
          <section className="card">
            <h2 style={H2}>Damaged cube mould, pipe or tool</h2>
            <p style={{ ...MUTED, marginTop: 0 }}>Report it with a photo. It stays on the list as “removal pending” until the Plant In Charge approves.</p>
            <button type="button" className="btn-primary" disabled={!meta.data || !inUse.data} onClick={() => setModal({ kind: "damage" })}>Report damaged</button>
            {meta.error && <div style={MUTED}>{meta.error}</div>}
          </section>
        )}
      </div>
      {modal?.kind === "report" && <ReportModal item={modal.item} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "damage" && <DamageModal items={inUse.data?.items || []} reasons={meta.data.reasons} onClose={() => setModal(null)} onDone={done} />}
    </>
  );
}

function AcceptCard({ s, onDone, setErr }) {
  const [missing, setMissing] = useState(null);
  const accept = async (body) => { try { await apiRequest(`/tools/issues/${s.id}/accept`, { method: "POST", body }); onDone(body.missing ? "Thanks — Store has been told what is missing." : "Accepted."); } catch (e) { setErr(e.message); } };
  return (
    <section className="card" style={{ borderColor: "var(--rebar)", marginBottom: 12 }}>
      <h2 style={H2}>Please check and accept</h2>
      <div style={{ fontSize: 13, marginBottom: 6 }}>{s.mode === "temporary" ? `Temporary — return by ${fmtDate(s.return_by)}` : "Permanent"}{s.kit_name ? ` · ${s.kit_name}` : ""}</div>
      {(s.lines || []).map((l) => <div key={l.line_id} style={{ fontSize: 13, borderTop: "1px solid var(--border)", padding: "5px 0" }}><b>{l.code}</b> {l.name}{l.serial_no ? <span style={MUTED}> · {l.serial_no}</span> : null}</div>)}
      {missing === null ? (
        <div style={{ ...ROW, marginTop: 8 }}>
          <button type="button" className="btn-primary" onClick={() => accept({})}>All received</button>
          <button type="button" onClick={() => setMissing("")}>Something missing</button>
        </div>
      ) : (
        <div style={{ ...ROW, marginTop: 8 }}>
          <input style={{ flex: 1 }} placeholder="What is missing or wrong?" value={missing} onChange={(e) => setMissing(e.target.value)} />
          <button type="button" className="btn-primary" disabled={!missing.trim()} onClick={() => accept({ missing })}>Send</button>
        </div>
      )}
    </section>
  );
}

function ReportModal({ item, onClose, onDone }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  return (
    <Modal title={`${item.code} — report a problem`} onClose={onClose} width={420}>
      <Msg err={err} />
      <Field label="What happened (damaged, lost, not working …)"><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 10 }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!note.trim()} onClick={async () => {
          try { await apiRequest("/tools/my/report", { method: "POST", body: { item_id: item.id, note } }); onDone("Sent — Store will take it back and check it."); } catch (e) { setErr(e.message); }
        }}>Send</button>
      </div>
    </Modal>
  );
}
