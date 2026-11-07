// Round 269 — Marketing › Library (mockup artboard 5): posters, videos,
// technical PDFs and brochures, stored in Google Drive. Nothing can be sent
// until the Administrator approves it; a new version goes for approval again
// and, once approved, retires the old one (kept, so history shows exactly
// what each firm received).
import { useEffect, useState } from "react";
import { apiRequest, BASE_URL } from "../../lib/api.js";
import { useMeta, Banner, Tile, Field, Chip, Sheet, fmtDay, mb, KIND_LABEL } from "./common.jsx";

const ORIGIN = BASE_URL.replace(/\/api\/?$/, "");
const STATUS = { pending: ["Waiting for approval", "amber"], approved: ["Approved", "green"], sent_back: ["Sent back", "red"], retired: ["Retired", null] };
const ACCEPT = { poster: "image/*", video: "video/*", pdf: "application/pdf", brochure: "application/pdf,image/*" };

function Preview({ it }) {
  const src = `${ORIGIN}${it.preview}`;
  const box = { height: 150, background: "#E7E3DA", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--slate)", overflow: "hidden" };
  if (it.kind === "poster" || (it.kind === "brochure" && /^image\//.test(it.mime))) return <div style={box}><img src={src} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>;
  if (it.kind === "video") return <div style={{ ...box, background: "#2E3238" }}><video src={src} preload="metadata" controls style={{ width: "100%", height: "100%" }} /></div>;
  return <div style={{ ...box, background: "var(--info-bg)", color: "var(--info)", flexDirection: "column", gap: 6 }}>PDF · {mb(it.size_bytes)}<a href={src} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>Open</a></div>;
}

function Upload({ previous, onClose, onDone }) {
  const [f, setF] = useState({ title: previous?.title || "", kind: previous?.kind || "poster", topic: previous?.topic || "", language: previous?.language || "English", valid_until: "", notes: "" });
  const [file, setFile] = useState(null);
  const [pct, setPct] = useState(null);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  function submit(e) {
    e.preventDefault(); setErr("");
    if (!file) { setErr("Choose the file."); return; }
    if (file.size > 100 * 1024 * 1024) { setErr("Files up to 100 MB only."); return; }
    const qs = new URLSearchParams({ ...f, file_name: file.name, ...(previous ? { previous_id: previous.id } : {}) });
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE_URL}/marketing/items/upload?${qs}`);
    const tok = localStorage.getItem("oorm_token");
    if (tok) xhr.setRequestHeader("Authorization", `Bearer ${tok}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) setPct(Math.round((ev.loaded / ev.total) * 100)); };
    xhr.onload = () => {
      let out = {}; try { out = JSON.parse(xhr.responseText); } catch { /* */ }
      if (xhr.status >= 200 && xhr.status < 300) onDone(`"${f.title}" is uploaded and waiting for the Administrator's approval.`);
      else { setErr(out.error || "Upload failed."); setPct(null); }
    };
    xhr.onerror = () => { setErr("Upload failed — check the connection."); setPct(null); };
    setPct(0);
    xhr.send(file);
  }
  return (
    <Sheet title={previous ? `New version of “${previous.title}”` : "Upload material"} onClose={pct != null ? () => {} : onClose}>
      <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        <Field label="Title" style={{ gridColumn: "1 / -1" }}><input className="field-input" value={f.title} onChange={set("title")} required /></Field>
        <Field label="Kind"><select className="field-input" value={f.kind} onChange={set("kind")} disabled={!!previous}>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Topic / grade"><input className="field-input" value={f.topic} onChange={set("topic")} placeholder="M30, waterproofing, Onam offer…" /></Field>
        <Field label="Language"><input className="field-input" value={f.language} onChange={set("language")} /></Field>
        <Field label="Valid until (offers)"><input className="field-input" type="date" value={f.valid_until} onChange={set("valid_until")} /></Field>
        <Field label="File" style={{ gridColumn: "1 / -1" }} hint="Up to 100 MB. Saved to the Marketing folder in Google Drive.">
          <input type="file" accept={ACCEPT[f.kind]} onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </Field>
        <Field label="Note for the Administrator" style={{ gridColumn: "1 / -1" }}><input className="field-input" value={f.notes} onChange={set("notes")} /></Field>
        {pct != null && <div style={{ gridColumn: "1 / -1" }}><div style={{ height: 8, background: "#EEEAE2", borderRadius: 4 }}><div style={{ width: `${pct}%`, height: 8, background: "var(--rebar)", borderRadius: 4 }} /></div><div style={{ fontSize: 12, color: "var(--slate)", marginTop: 4 }}>{pct < 100 ? `Uploading… ${pct}%` : "Saving to Google Drive…"}</div></div>}
        {err && <div role="alert" style={{ color: "var(--alert-red)", fontSize: 13, gridColumn: "1 / -1" }}>{err}</div>}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}><button type="submit" className="btn-primary" disabled={pct != null}>Upload</button><button type="button" onClick={onClose} disabled={pct != null}>Cancel</button></div>
      </form>
    </Sheet>
  );
}

export default function Library({ go }) {
  const [meta, metaErr] = useMeta();
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [upload, setUpload] = useState(null);
  const [deciding, setDeciding] = useState(null);
  const [note, setNote] = useState("");
  async function load() { try { setD(await apiRequest(`/marketing/items${status ? `?status=${status}` : ""}`)); } catch (e) { setErr(e.message); } }
  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function decide(it, action) {
    setErr("");
    try {
      await apiRequest(`/marketing/items/${it.id}/decide`, { method: "POST", body: { action, note } });
      setDeciding(null); setNote("");
      setMsg(action === "approve" ? `"${it.title}" approved — it can now be sent.` : action === "retire" ? `"${it.title}" retired.` : `"${it.title}" sent back.`);
      load();
    } catch (e) { setErr(e.message); }
  }

  const items = (d?.items || []).filter((i) => !kind || i.kind === kind);
  const sel = { minHeight: 38, border: "1px solid var(--border-strong)", borderRadius: 8, padding: "0 8px" };
  return (
    <>
      <Banner>{err || metaErr}</Banner>
      <Banner kind="ok">{msg}</Banner>
      {meta && !meta.channels.drive && <Banner>Google Drive is not connected yet — {meta.can.approve ? "connect it in Marketing › Settings" : "ask the Administrator to connect it in Marketing › Settings"} before uploading.</Banner>}
      {d && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
          <Tile label="Approved — ready to send" value={d.tiles.approved} tone="green" />
          <Tile label="Waiting for Admin approval" value={d.tiles.pending} tone={d.tiles.pending ? "amber" : null} />
          <Tile label="Offers ending in 7 days" value={d.tiles.expiring} />
          <Tile label="In Google Drive" value={mb(d.tiles.bytes) || "0 KB"} />
        </div>
      )}
      <div className="card" style={{ margin: 0 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
          <Field label="Kind"><select value={kind} onChange={(e) => setKind(e.target.value)} style={sel}><option value="">All</option>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)} style={sel}><option value="">All</option>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          {meta?.can.upload && <button type="button" className="btn-primary" onClick={() => setUpload({})} style={{ minHeight: 38 }} disabled={!meta.channels.drive}>+ Upload</button>}
        </div>
        {!d ? <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div> : !items.length ? <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing here yet.</div> : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
            {items.map((it) => {
              const [label, tone] = STATUS[it.status];
              return (
                <div key={it.id} style={{ border: it.status === "pending" ? "2px solid var(--amber)" : "1px solid var(--border)", borderRadius: 10, overflow: "hidden", opacity: it.status === "retired" ? 0.6 : 1 }}>
                  <Preview it={it} />
                  <div style={{ padding: "10px 12px", fontSize: 12.5, lineHeight: 1.5 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><b style={{ fontSize: 13.5 }}>{it.title}</b><Chip tone={tone}>{label}</Chip></div>
                    <div style={{ color: "var(--slate)" }}>{[KIND_LABEL[it.kind], it.language, it.topic, mb(it.size_bytes), `v${it.version}`, it.valid_until ? `valid till ${fmtDay(it.valid_until)}` : null, it.uploaded_by_name ? `by ${it.uploaded_by_name}` : null].filter(Boolean).join(" · ")}</div>
                    {it.decision_note && <div style={{ color: it.status === "sent_back" ? "var(--alert-red)" : "var(--slate)" }}>{it.decided_by_name}: {it.decision_note}</div>}
                    {it.notes && it.status === "pending" && <div style={{ color: "var(--slate)" }}>Note: {it.notes}</div>}
                    {it.sent_n > 0 && <div style={{ marginTop: 4 }}>Sent to <b>{it.sent_n}</b> · opened <b>{it.opened_n}</b>{meta?.can.tracking && <> · <button type="button" onClick={() => go("tracking", { item: it.id })} style={{ background: "none", border: "none", padding: 0, color: "var(--info)", textDecoration: "underline", fontSize: 12.5 }}>tracking</button></>}</div>}
                    <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                      {meta?.can.approve && it.status === "pending" && (deciding === it.id ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
                          <input className="field-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What needs changing" />
                          <div style={{ display: "flex", gap: 6 }}><button type="button" onClick={() => decide(it, "send_back")} style={{ color: "var(--alert-red)" }}>Send back</button><button type="button" onClick={() => setDeciding(null)}>Cancel</button></div>
                        </div>
                      ) : (
                        <>
                          <button type="button" onClick={() => decide(it, "approve")} style={{ flex: 1, minHeight: 40, background: "var(--signal-green)", color: "#fff", border: 0, borderRadius: 8, fontWeight: 700 }}>Approve</button>
                          <button type="button" onClick={() => { setDeciding(it.id); setNote(""); }} style={{ flex: 1, minHeight: 40 }}>Send back</button>
                        </>
                      ))}
                      {meta?.can.upload && ["approved", "sent_back"].includes(it.status) && <button type="button" onClick={() => setUpload({ previous: it })} style={{ fontSize: 12.5 }}>New version</button>}
                      {meta?.can.approve && it.status === "approved" && <button type="button" onClick={() => { if (window.confirm(`Retire "${it.title}"? It can no longer be sent; old links still open.`)) decide(it, "retire"); }} style={{ fontSize: 12.5 }}>Retire</button>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {upload && <Upload previous={upload.previous} onClose={() => setUpload(null)} onDone={(m) => { setUpload(null); setMsg(m); load(); }} />}
    </>
  );
}
