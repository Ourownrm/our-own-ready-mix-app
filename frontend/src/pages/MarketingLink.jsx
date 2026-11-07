// Round 269 — the page behind each person's marketing link (/m/:token). No
// sign-in: the token says who it is, so opening, viewing, downloading and
// playing a video to the end are recorded against that person. "Don't send me
// these" stops all marketing to them.
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { BASE_URL } from "../lib/api.js";

const API = `${BASE_URL}/marketing-public`;

export default function MarketingLink() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [stopped, setStopped] = useState(false);
  const [asking, setAsking] = useState(params.get("stop") === "1");

  useEffect(() => {
    fetch(`${API}/m/${encodeURIComponent(token)}`).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "This link is not valid.");
      setD(j); setStopped(j.opted_out);
    }).catch((e) => setErr(e.message));
  }, [token]);

  async function stop() {
    await fetch(`${API}/m/${encodeURIComponent(token)}/opt-out`, { method: "POST" }).catch(() => {});
    setStopped(true); setAsking(false);
  }
  function ended(id) {
    fetch(`${API}/m/${encodeURIComponent(token)}/event`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "play_end", item_id: id }) }).catch(() => {});
  }
  const file = (id, dl) => `${API}/m/${encodeURIComponent(token)}/file/${id}${dl ? "?dl=1" : ""}`;

  return (
    <div style={{ minHeight: "100vh", background: "#F3F1EC", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", color: "#22262B" }}>
      <div style={{ height: 6, background: "#C75B12" }} />
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "18px 16px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <img src="/quote-logo.png" alt="" style={{ width: 52, height: 52, objectFit: "contain" }} />
          <div><div style={{ fontWeight: 800, fontSize: 18 }}>Our Own Ready Mix</div><div style={{ fontSize: 12.5, color: "#5B6470" }}>Ready-mix concrete · Kasaragod</div></div>
        </div>
        {err && <div style={{ background: "#fff", borderRadius: 10, padding: 16 }}>{err}</div>}
        {!d && !err && <div style={{ color: "#5B6470" }}>Loading…</div>}
        {d && (
          <>
            <div style={{ fontSize: 16, marginBottom: 14 }}>{d.name ? `Dear ${d.name},` : "Hello,"}</div>
            {!d.items.length && <div style={{ background: "#fff", borderRadius: 10, padding: 16 }}>Thank you for your interest. We will be in touch.</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {d.items.map((it) => (
                <div key={it.id} style={{ background: "#fff", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,.06)" }}>
                  {(it.kind === "poster" || (it.kind === "brochure" && /^image\//.test(it.mime))) && <img src={file(it.id)} alt={it.title} style={{ width: "100%", display: "block" }} />}
                  {it.kind === "video" && <video src={file(it.id)} controls playsInline preload="metadata" onEnded={() => ended(it.id)} style={{ width: "100%", display: "block", background: "#000" }} />}
                  <div style={{ padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <b style={{ fontSize: 15 }}>{it.title}</b>
                    <div style={{ display: "flex", gap: 8 }}>
                      {(it.kind === "pdf" || (it.kind === "brochure" && !/^image\//.test(it.mime))) && <a href={file(it.id)} target="_blank" rel="noreferrer" style={{ background: "#C75B12", color: "#fff", borderRadius: 8, padding: "10px 14px", textDecoration: "none", fontWeight: 700 }}>Open</a>}
                      <a href={file(it.id, true)} style={{ border: "1px solid #C8C2B5", color: "#22262B", borderRadius: 8, padding: "10px 14px", textDecoration: "none" }}>Download</a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 22, fontSize: 13.5, lineHeight: 1.6 }}>
              Questions or an order? Call <a href="tel:+918340074006" style={{ color: "#C75B12", fontWeight: 700 }}>+91 83 4007 4006</a> · <a href="https://www.ourownrm.com" style={{ color: "#2A6F97" }}>www.ourownrm.com</a>
            </div>
            <div style={{ marginTop: 26, fontSize: 12.5, color: "#5B6470" }}>
              {stopped ? "You will not be sent these again." : asking ? (
                <span>Stop receiving marketing messages from Our Own Ready Mix? <button type="button" onClick={stop} style={{ marginLeft: 6 }}>Yes, stop</button> <button type="button" onClick={() => setAsking(false)}>No</button></span>
              ) : <button type="button" onClick={() => setAsking(true)} style={{ background: "none", border: "none", color: "#5B6470", textDecoration: "underline", padding: 0 }}>Don't send me these</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
