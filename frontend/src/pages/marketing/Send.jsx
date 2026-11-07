// Round 269 — Marketing › Send (mockup artboard 4). To a group (people the
// Administrator allows: "Send to a group") or to one firm from the phone
// ("Send to own firms"). Each person gets their own tracking link. WhatsApp
// API messages go from the app; WhatsApp from the phone, and email when no
// mail server is set up, are opened one by one here and marked sent.
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { useMeta, Banner, Field, Chip, TH, TD, KIND_LABEL, CH_LABEL } from "./common.jsx";

const STATUS_TONE = { queued: "amber", sent: "blue", delivered: "blue", read: "green", failed: "red", skipped: null };

function Result({ id, onNew }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  async function load() { try { setD(await apiRequest(`/marketing/sends/${id}`)); } catch (e) { setErr(e.message); } }
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function mark(r) {
    try { await apiRequest(`/marketing/recipients/${r.id}/sent`, { method: "POST" }); load(); } catch (e) { setErr(e.message); }
  }
  if (!d) return <><Banner>{err}</Banner><div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div></>;
  const manual = d.recipients.filter((r) => r.open_url);
  const count = (s) => d.recipients.filter((r) => r.status === s).length;
  return (
    <div className="card" style={{ margin: 0 }}>
      <Banner>{err}</Banner>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <b style={{ fontSize: 15 }}>Sent — {d.items.map((i) => i.title).join(", ") || d.send.category || "message"}</b>
        <button type="button" onClick={onNew}>New send</button>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--slate)", margin: "4px 0 10px" }}>
        {count("queued")} to go · {count("sent") + count("delivered") + count("read")} sent · {count("failed")} failed · {count("skipped")} left out
      </div>
      {manual.some((r) => r.status === "queued") && (
        <div style={{ background: "var(--amber-bg)", borderRadius: 8, padding: "10px 12px", fontSize: 13, marginBottom: 10 }}>
          Tap <b>Open</b> for each person: WhatsApp / your mail app opens with the message and their own link. Send it there, then tap <b>Sent</b>.
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
          <thead><tr><th style={TH}>Firm · person</th><th style={TH}>How</th><th style={TH}>Status</th><th style={TH}></th></tr></thead>
          <tbody>{d.recipients.map((r) => (
            <tr key={r.id}>
              <td style={TD}><b>{r.firm_name}</b> · {r.name || "—"}{r.level ? ` (L${r.level})` : ""}</td>
              <td style={TD}>{r.channel === "skipped" ? "—" : r.open_url ? `${CH_LABEL[r.channel === "email" ? "email" : "wa_phone"]} · you send` : CH_LABEL[r.channel]}</td>
              <td style={TD}><Chip tone={STATUS_TONE[r.status]}>{r.status}</Chip>{r.skip_reason && r.skip_reason !== "manual" && <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{r.skip_reason}</div>}{r.error && <div style={{ fontSize: 11.5, color: "var(--alert-red)" }}>{r.error}</div>}</td>
              <td style={TD}>{r.open_url && r.status === "queued" && (
                <div style={{ display: "flex", gap: 6 }}>
                  <a href={r.open_url} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", minHeight: 36, padding: "0 12px", borderRadius: 8, background: "var(--rebar)", color: "#fff", textDecoration: "none", fontWeight: 700 }}>Open</a>
                  <button type="button" onClick={() => mark(r)}>Sent</button>
                </div>
              )}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

export default function Send({ params, go }) {
  const [meta, metaErr] = useMeta();
  const firmId = params.get("firm") ? Number(params.get("firm")) : null;
  const sendId = params.get("send");
  const [items, setItems] = useState([]);
  const [firm, setFirm] = useState(null);
  const [f, setF] = useState({ category: "", plan_category: "", status: "", types: [], areas: [], mine: false, levels: [1, 2], channels: [], preferred_only: true, item_ids: [], message: "Dear {name},\n\n", note: "" });
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { apiRequest("/marketing/items?status=approved").then((d) => setItems(d.items)).catch(() => {}); }, []);
  useEffect(() => { if (firmId) apiRequest(`/marketing/firms/${firmId}`).then((d) => setFirm(d.firm)).catch((e) => setErr(e.message)); }, [firmId]);
  useEffect(() => {
    if (!meta) return;
    const ch = [];
    if (meta.can.send_group && meta.channels.wa_api && !firmId) ch.push("wa_api"); else ch.push("wa_phone");
    setF((x) => ({ ...x, channels: ch, category: meta.categories[0] || "" }));
  }, [meta, firmId]);
  useEffect(() => { setPreview(null); }, [f.plan_category, f.status, f.types, f.areas, f.mine, f.levels, f.channels, f.preferred_only]);

  const groupMode = !firmId;
  const allowed = meta && (groupMode ? meta.can.send_group : (meta.can.send_group || meta.can.send_own));
  const chOptions = useMemo(() => {
    if (!meta) return [];
    const out = [];
    if (meta.can.send_group) out.push(["wa_api", "WhatsApp API (from the app)", !meta.channels.wa_api]);
    out.push(["wa_phone", "WhatsApp from my phone", false]);
    out.push(["email", meta.channels.email ? "Email (from the app)" : "Email (from my mail app)", false]);
    return out;
  }, [meta]);

  if (sendId) return <Result id={sendId} onNew={() => go("send", firmId ? { firm: firmId } : {})} />;
  if (!meta) return <Banner>{metaErr}</Banner>;
  if (!allowed) return <Banner>{groupMode ? "Sending to a group is not switched on for you — open a firm in the Directory and send to that firm from your phone." : "Sending is not switched on for you."}</Banner>;

  const toggle = (k, v) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const body = () => ({
    ...(firmId ? { firm_ids: [firmId] } : { filter: { plan_category: f.plan_category || null, status: f.status || null, types: f.types, areas: f.areas, mine: f.mine } }),
    levels: f.levels, channels: f.channels, preferred_only: f.preferred_only, item_ids: f.item_ids, message: f.message, category: f.category, note: f.note,
    app_origin: window.location.origin,
  });
  async function doPreview() {
    setErr(""); setBusy(true);
    try { setPreview(await apiRequest("/marketing/sends/preview", { method: "POST", body: body() })); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function send() {
    setErr(""); setBusy(true);
    try {
      const out = await apiRequest("/marketing/sends", { method: "POST", body: body() });
      go("send", { send: out.id, ...(firmId ? { firm: firmId } : {}) });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const live = preview?.recipients.filter((r) => r.channel !== "skipped") || [];
  const skipped = preview?.recipients.filter((r) => r.channel === "skipped") || [];
  const box = { display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 };
  const sub = { fontSize: 12, fontWeight: 600, color: "var(--slate)", marginBottom: 4 };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 14, alignItems: "start" }}>
      <div className="card" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        <Banner>{err}</Banner>
        <b style={{ fontSize: 16 }}>{firmId ? `Send to ${firm?.name || "…"}` : "Send to a group"}</b>
        <Field label="Category"><select className="field-input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{meta.categories.map((x) => <option key={x}>{x}</option>)}</select></Field>
        {groupMode && (
          <>
            <div><div style={sub}>Who</div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 }}>
                <Field label="Firms with this in their plan"><select className="field-input" value={f.plan_category} onChange={(e) => setF({ ...f, plan_category: e.target.value })}><option value="">Any firm</option>{meta.categories.map((x) => <option key={x}>{x}</option>)}</select></Field>
                <Field label="Status"><select className="field-input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Customers & prospects</option><option value="customer">Customers only</option><option value="prospect">Prospects only</option></select></Field>
              </div>
            </div>
            <div><div style={sub}>Types (none ticked = all)</div><div style={box}>{meta.firm_types.map((t) => <label key={t} style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={f.types.includes(t)} onChange={() => toggle("types", t)} />{t}</label>)}</div></div>
            {meta.areas.length > 0 && <div><div style={sub}>Areas (none ticked = all)</div><div style={box}>{meta.areas.map((a) => <label key={a} style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={f.areas.includes(a)} onChange={() => toggle("areas", a)} />{a}</label>)}</div></div>}
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={f.mine} onChange={(e) => setF({ ...f, mine: e.target.checked })} /> Only firms I look after</label>
          </>
        )}
        <div><div style={sub}>Levels</div><div style={box}>{[1, 2, 3].map((l) => <label key={l} style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={f.levels.includes(l)} onChange={() => toggle("levels", l)} /> L{l} · {meta.levels[l]}</label>)}</div></div>
        <div><div style={sub}>How</div>
          <div style={{ ...box, flexDirection: "column", gap: 6 }}>
            {chOptions.filter(([k]) => groupMode || k !== "wa_api" || meta.can.send_group).map(([k, l, off]) => (
              <label key={k} style={{ display: "flex", gap: 6, alignItems: "center", color: off ? "var(--slate)" : undefined }}>
                <input type="checkbox" disabled={off} checked={f.channels.includes(k)} onChange={() => toggle("channels", k)} /> {l}{off ? " — not set up yet (Settings)" : ""}
              </label>
            ))}
            <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--slate)" }}><input type="checkbox" checked={f.preferred_only} onChange={(e) => setF({ ...f, preferred_only: e.target.checked })} /> Each person's preferred way only</label>
          </div>
        </div>
        <div><div style={sub}>Material from the library (approved only)</div>
          {!items.length ? <div style={{ fontSize: 12.5, color: "var(--slate)" }}>No approved material yet — the message goes with a link page only.</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{items.map((it) => (
              <label key={it.id} style={{ display: "flex", gap: 8, alignItems: "center", border: "1px solid var(--border-strong)", borderRadius: 8, padding: 8, fontSize: 13 }}>
                <input type="checkbox" checked={f.item_ids.includes(it.id)} onChange={() => toggle("item_ids", it.id)} /> <b>{it.title}</b> <span style={{ color: "var(--slate)" }}>{KIND_LABEL[it.kind]}</span>
              </label>
            ))}</div>
          )}
        </div>
        <Field label="Message (email and WhatsApp from the phone)" hint="{name} becomes the person's name. Each person's own link is added at the end. WhatsApp API uses your approved template's text.">
          <textarea className="field-input" rows={6} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} />
        </Field>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={doPreview} disabled={busy || !f.channels.length}>Who gets it?</button>
          <button type="button" className="btn-primary" onClick={send} disabled={busy || !preview || !live.length} style={{ minHeight: 46 }}>
            {preview ? `Send to ${live.length} ${live.length === 1 ? "person" : "people"} in ${preview.firms} firm${preview.firms === 1 ? "" : "s"}` : "Send"}
          </button>
        </div>
      </div>
      <div className="card" style={{ margin: 0 }}>
        <b>Who gets it{preview ? ` · ${live.length}` : ""}</b>
        {!preview ? <div style={{ fontSize: 13, color: "var(--slate)", marginTop: 8 }}>Tap “Who gets it?” to see the list before sending.</div> : (
          <div style={{ marginTop: 8 }}>
            {live.slice(0, 200).map((r, i) => (
              <div key={`${r.contact_id}-${r.channel}-${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "6px 0", borderTop: "1px solid #EEEAE2", fontSize: 12.5 }}>
                <span><b>{r.firm_name}</b> · {r.name} L{r.level}</span><span style={{ color: "var(--info)" }}>{CH_LABEL[r.channel]}</span>
              </div>
            ))}
            {skipped.length > 0 && <div style={{ marginTop: 10, fontSize: 12.5, fontWeight: 700 }}>Left out · {skipped.length}</div>}
            {skipped.slice(0, 100).map((r, i) => (
              <div key={`s${r.contact_id}-${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "5px 0", borderTop: "1px solid #EEEAE2", fontSize: 12, color: "var(--slate)" }}>
                <span>{r.firm_name} · {r.name}</span><span style={{ color: "var(--alert-red)" }}>{r.reason}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 12, lineHeight: 1.5 }}>
          Marketing goes only to people marked "agreed to receive"{meta ? "" : ""} and never to anyone who asked not to be sent these (Settings can change the first rule).
        </div>
      </div>
    </div>
  );
}
