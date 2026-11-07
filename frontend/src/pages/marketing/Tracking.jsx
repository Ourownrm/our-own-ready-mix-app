// Round 269 — Marketing › Tracking (mockup artboard 6): for each send and each
// piece of material — who received it, read it, opened it, and who asked not
// to be sent more. Openers can be put straight onto Due today for a call.
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { Banner, Tile, Chip, TH, TD, fmtWhen, KIND_LABEL, CH_LABEL } from "./common.jsx";

export default function Tracking({ params, go }) {
  const item = params.get("item");
  return item ? <ItemTracking id={Number(item)} go={go} /> : <Overview go={go} />;
}

function Overview({ go }) {
  const [sends, setSends] = useState(null);
  const [items, setItems] = useState([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    apiRequest("/marketing/sends").then(setSends).catch((e) => setErr(e.message));
    apiRequest("/marketing/items").then((d) => setItems(d.items.filter((i) => i.sent_n > 0))).catch(() => {});
  }, []);
  return (
    <>
      <Banner>{err}</Banner>
      {items.length > 0 && (
        <div className="card" style={{ margin: "0 0 14px" }}>
          <b>By material</b>
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={TH}>Material</th><th style={TH}>Kind</th><th style={{ ...TH, textAlign: "right" }}>Sent to</th><th style={{ ...TH, textAlign: "right" }}>Opened</th><th style={TH}></th></tr></thead>
              <tbody>{items.map((i) => (
                <tr key={i.id}><td style={TD}><b>{i.title}</b> v{i.version}</td><td style={TD}>{KIND_LABEL[i.kind]}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{i.sent_n}</td><td style={{ ...TD, textAlign: "right" }}>{i.opened_n}{i.sent_n ? ` (${Math.round((i.opened_n / i.sent_n) * 100)}%)` : ""}</td>
                  <td style={TD}><button type="button" onClick={() => go("tracking", { item: i.id })}>Each person</button></td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
      <div className="card" style={{ margin: 0 }}>
        <b>Sends</b>
        {!sends ? <div style={{ fontSize: 13, color: "var(--slate)", marginTop: 8 }}>Loading…</div> : !sends.length ? <div style={{ fontSize: 13, color: "var(--slate)", marginTop: 8 }}>Nothing sent yet.</div> : (
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
              <thead><tr><th style={TH}>When · by</th><th style={TH}>What</th><th style={TH}>To</th><th style={{ ...TH, textAlign: "right" }}>People</th><th style={{ ...TH, textAlign: "right" }}>Sent</th><th style={{ ...TH, textAlign: "right" }}>Read (API)</th><th style={{ ...TH, textAlign: "right" }}>Opened</th><th style={TH}></th></tr></thead>
              <tbody>{sends.map((s) => (
                <tr key={s.id}>
                  <td style={TD}>{fmtWhen(s.created_at)}<div style={{ fontSize: 11.5, color: "var(--slate)" }}>{s.by_name}</div></td>
                  <td style={TD}><b>{s.titles || s.category || "Message"}</b><div style={{ fontSize: 11.5, color: "var(--slate)" }}>{s.category} · {s.channels.map((c) => CH_LABEL[c]).join(" + ")}</div></td>
                  <td style={TD}>{s.firm_name || "Group"}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{s.people}{s.skipped ? <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{s.skipped} left out</div> : null}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{s.sent}{s.queued ? <div style={{ fontSize: 11.5, color: "var(--amber)" }}>{s.queued} to go</div> : null}{s.failed ? <div style={{ fontSize: 11.5, color: "var(--alert-red)" }}>{s.failed} failed</div> : null}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{s.read}</td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 700, color: s.opened ? "var(--signal-green)" : undefined }}>{s.opened}</td>
                  <td style={TD}><button type="button" onClick={() => go("send", { send: s.id })}>Open</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function ItemTracking({ id, go }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  async function load() { try { setD(await apiRequest(`/marketing/items/${id}/tracking`)); } catch (e) { setErr(e.message); } }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function followups() {
    try { const out = await apiRequest(`/marketing/items/${id}/followups`, { method: "POST" }); setMsg(`${out.added} firm${out.added === 1 ? "" : "s"} added to Due today for a call.`); } catch (e) { setErr(e.message); }
  }
  async function remind() {
    const ids = d.recipients.filter((r) => !r.open_count && !r.opted_out && r.contact_id && ["sent", "delivered", "read"].includes(r.status)).map((r) => r.contact_id);
    if (!ids.length) { setMsg("Everyone has opened it, or nobody can be reminded."); return; }
    try {
      const out = await apiRequest("/marketing/sends", { method: "POST", body: { contact_ids: [...new Set(ids)], levels: [1, 2, 3], channels: ["wa_api", "wa_phone", "email"], preferred_only: true, item_ids: [id], category: "Reminder", message: `Dear {name},\n\nA reminder — ${d.item.title}:`, app_origin: window.location.origin } });
      go("send", { send: out.id });
    } catch (e) { setErr(e.message); }
  }
  if (!d) return <><Banner>{err}</Banner><div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div></>;
  const t = d.tiles;
  const STATUS_TONE = { queued: "amber", sent: "blue", delivered: "blue", read: "green", failed: "red" };
  return (
    <>
      <button type="button" onClick={() => go("tracking")} style={{ marginBottom: 12 }}>← Tracking</button>
      <Banner>{err}</Banner>
      <Banner kind="ok">{msg}</Banner>
      <h2 style={{ fontSize: 17, margin: "0 0 12px" }}>{d.item.title} <span style={{ fontWeight: 400, color: "var(--slate)", fontSize: 13 }}>v{d.item.version} · {KIND_LABEL[d.item.kind]}</span></h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
        <Tile label="Sent to" value={`${t.sent} · ${t.firms} firm${t.firms === 1 ? "" : "s"}`} />
        <Tile label="Delivered (WhatsApp API)" value={`${t.api_delivered} / ${t.api_total}`} />
        <Tile label="Opened" value={`${t.opened}${t.sent ? ` · ${Math.round((t.opened / t.sent) * 100)}%` : ""}`} tone="green" />
        <Tile label="Not opened after 3 days" value={t.not_opened_3d} tone={t.not_opened_3d ? "amber" : null} />
        <Tile label="Asked not to be sent" value={t.opted_out} />
      </div>
      <div className="card" style={{ margin: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
          <b>Each person</b>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={remind}>Remind those who did not open</button>
            <button type="button" className="btn-primary" onClick={followups}>Add openers to Due today (call)</button>
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
            <thead><tr><th style={TH}>Firm · person</th><th style={TH}>Sent by · how</th><th style={TH}>Sent</th><th style={TH}>Delivered / read</th><th style={TH}>Opened the file</th></tr></thead>
            <tbody>{d.recipients.map((r) => (
              <tr key={r.id}>
                <td style={TD}><button type="button" onClick={() => go("directory", { firm: r.firm_id })} style={{ background: "none", border: "none", padding: 0, fontWeight: 700, color: "var(--info)", textAlign: "left" }}>{r.firm_name}</button> · {r.name} {r.level ? `L${r.level}` : ""}
                  {r.opted_out && <div><Chip tone="red">asked not to be sent</Chip></div>}</td>
                <td style={TD}>{r.sent_by_name || "—"} · {CH_LABEL[r.channel]}</td>
                <td style={TD}>{fmtWhen(r.sent_at)}</td>
                <td style={TD}>{r.channel === "wa_api" ? <><Chip tone={STATUS_TONE[r.status]}>{r.status}</Chip>{r.read_at ? <div style={{ fontSize: 11.5 }}>read {fmtWhen(r.read_at)}</div> : null}{r.error ? <div style={{ fontSize: 11.5, color: "var(--alert-red)" }}>{r.error}</div> : null}</> : <span style={{ color: "var(--slate)" }}>{r.status === "queued" ? "not sent yet" : "not known (sent by hand)"}</span>}</td>
                <td style={{ ...TD, fontWeight: r.open_count ? 600 : 400, color: r.open_count ? "var(--signal-green)" : "var(--amber)" }}>
                  {r.open_count ? `${r.open_count}× · last ${fmtWhen(r.last_open_at)}${r.download_count ? ` · downloaded ${r.download_count}×` : ""}${r.play_end_count ? " · watched to the end" : ""}` : "Not yet"}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 10 }}>
          Opening is known from each person's own link: it opens a page with your logo and the material, played from Google Drive. WhatsApp's own link preview is not counted as an open.
        </div>
      </div>
    </>
  );
}
