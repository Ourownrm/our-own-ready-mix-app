// Round 269 — Marketing › Settings (mockup artboard 7): the lists, the sending
// rules, Google Drive, the WhatsApp Cloud API and email. Secrets are typed in
// once and never shown again (the server says only whether each is set).
import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api.js";
import { Banner, Field, Chip } from "./common.jsx";

const lines = (a) => (a || []).join("\n");
const unlines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
function Copy({ text }) {
  const [done, setDone] = useState(false);
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#F3F1EC", borderRadius: 6, padding: "6px 8px", fontSize: 12, fontFamily: "monospace", wordBreak: "break-all" }}>
      <span style={{ flex: 1 }}>{text}</span>
      <button type="button" style={{ fontSize: 11.5, fontFamily: "inherit" }} onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? "Copied" : "Copy"}</button>
    </div>
  );
}
function Section({ title, status, children }) {
  return (
    <div className="card" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}><b style={{ fontSize: 15 }}>{title}</b>{status}</div>
      {children}
    </div>
  );
}
function Steps({ children }) {
  return <details style={{ fontSize: 12.5, lineHeight: 1.55 }}><summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--info)" }}>How to set this up</summary><ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>{children}</ol></details>;
}

export default function MarketingSettings({ params }) {
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [sec, setSec] = useState({ wa_token: "", wa_app_secret: "", google_client_id: "", google_client_secret: "", smtp: { host: "", port: 465, user: "", pass: "" } });
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState(params.get("drive") === "ok" ? "Google Drive is connected." : "");
  const [test, setTest] = useState({ wa: "", email: "" });

  async function load() {
    try {
      const out = await apiRequest("/marketing/settings");
      setD(out);
      setF({ ...out.data, public_origin: out.data.public_origin || window.location.origin });
      setSec((s) => ({ ...s, google_client_id: out.secrets.google_client_id, smtp: { ...out.secrets.smtp, pass: "" } }));
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => {
    load();
    const dr = params.get("drive");
    if (dr && dr !== "ok") setErr(`Google Drive was not connected: ${dr}`);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(extra = {}) {
    setErr(""); setMsg("");
    try {
      await apiRequest("/marketing/settings", { method: "PUT", body: { ...f, ...sec, ...extra } });
      setSec((s) => ({ ...s, wa_token: "", wa_app_secret: "", google_client_secret: "", smtp: { ...s.smtp, pass: "" } }));
      setMsg("Saved."); load();
    } catch (e) { setErr(e.message); }
  }
  async function connectDrive() {
    setErr("");
    try {
      await apiRequest("/marketing/settings", { method: "PUT", body: { google_client_id: sec.google_client_id, google_client_secret: sec.google_client_secret } });
      const out = await apiRequest("/marketing/settings/drive-connect", { method: "POST", body: { app_origin: window.location.origin } });
      window.location.href = out.url;
    } catch (e) { setErr(e.message); }
  }
  async function runTest(kind) {
    setErr(""); setMsg("");
    try {
      await apiRequest(`/marketing/settings/${kind === "wa" ? "wa-test" : "email-test"}`, { method: "POST", body: { to: test[kind] } });
      setMsg(kind === "wa" ? "Test WhatsApp sent — check the phone." : "Test email sent.");
    } catch (e) { setErr(e.message); }
  }
  if (!d || !f) return <><Banner>{err}</Banner><div style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div></>;
  const s = d.secrets;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const tpl = (k, field) => (e) => setF({ ...f, wa: { ...f.wa, templates: { ...f.wa.templates, [k]: { ...f.wa.templates[k], [field]: e.target.value } } } });
  const ok = (on, yes = "Connected", no = "Not set up") => <Chip tone={on ? "green" : "amber"}>{on ? yes : no}</Chip>;
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Banner>{err}</Banner>
      <Banner kind="ok">{msg}</Banner>

      <Section title="Google Drive — where the library's files are kept" status={ok(s.drive_connected, f.drive.account ? `Connected · ${f.drive.account}` : "Connected")}>
        <Steps>
          <li>Open <b>console.cloud.google.com</b> signed in as ourownrm@gmail.com and create a project (e.g. "OORM app").</li>
          <li>APIs &amp; Services › Library: enable <b>Google Drive API</b>.</li>
          <li>OAuth consent screen: External, app name "Our Own Ready Mix", your email; scope <b>…/auth/drive.file</b>. Then <b>Publish app</b> (In production) — in "Testing" Google disconnects it after 7 days.</li>
          <li>Credentials › Create credentials › OAuth client ID › Web application. Under "Authorised redirect URIs" add the address below.</li>
          <li>Paste the Client ID and Client secret here and tap <b>Connect Google Drive</b>; choose ourownrm@gmail.com and allow. Google may warn "unverified app" — Advanced › Go to Our Own Ready Mix.</li>
          <li>The app creates the folder <b>Our Own Ready Mix — Marketing</b> with Posters / Videos / Technical PDFs / Brochures in it. It can see only the files it put there.</li>
        </Steps>
        <Field label="Authorised redirect URI (paste in Google)"><Copy text={d.urls.drive_redirect} /></Field>
        <div style={grid}>
          <Field label="Client ID"><input className="field-input" value={sec.google_client_id} onChange={(e) => setSec({ ...sec, google_client_id: e.target.value })} /></Field>
          <Field label={`Client secret${s.google_client_secret ? " (saved — type to replace)" : ""}`}><input className="field-input" type="password" value={sec.google_client_secret} onChange={(e) => setSec({ ...sec, google_client_secret: e.target.value })} /></Field>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn-primary" onClick={connectDrive} disabled={!sec.google_client_id || (!s.google_client_secret && !sec.google_client_secret)}>{s.drive_connected ? "Reconnect Google Drive" : "Connect Google Drive"}</button>
          {s.drive_connected && <button type="button" onClick={() => { if (window.confirm("Disconnect Google Drive? Files stay in Drive; the app cannot show or send them until it is connected again.")) save({ drive_disconnect: true }); }}>Disconnect</button>}
        </div>
      </Section>

      <Section title="WhatsApp Business API (Meta Cloud API)" status={ok(s.wa_token && f.wa.phone_number_id && f.wa.templates.link?.name, "Ready")}>
        <Steps>
          <li><b>business.facebook.com</b>: create the business portfolio "Our Own Ready Mix" and complete <b>business verification</b> (Security Centre) with company documents and ourownrm.com.</li>
          <li><b>developers.facebook.com</b> › My Apps › Create app › type Business › add the <b>WhatsApp</b> product. Try it first with Meta's free test number.</li>
          <li>WhatsApp › API Setup › <b>Add phone number</b>. To keep using the same number on the WhatsApp Business app, choose "Connect your existing WhatsApp Business app" (coexistence, available in India).</li>
          <li>Business settings › Users › <b>System users</b> › Add (Admin) › Add assets: the app (full control) and the WhatsApp account › <b>Generate token</b> with whatsapp_business_messaging and whatsapp_business_management, no expiry. Paste it below.</li>
          <li>Copy the <b>Phone number ID</b> and <b>WhatsApp Business Account ID</b> from API Setup.</li>
          <li>App › WhatsApp › Configuration › Webhook: Callback URL and Verify token from below; subscribe to <b>messages</b>. App settings › Basic › <b>App secret</b>: paste below.</li>
          <li>WhatsApp Manager › Message templates › create, category <b>Marketing</b>, language English:
            <ul style={{ paddingLeft: 16 }}>
              <li><b>Link template</b> (required): body e.g. "Dear {"{{1}}"}, please see {"{{2}}"} from Our Own Ready Mix." + button "Visit website" with a <b>dynamic URL</b> <code>{d.urls.link_base || "https://<your app>/m/"}{"{{1}}"}</code>.</li>
              <li>Optional with media: the same body and button, plus a header of type Image (poster), Video (video) or Document (PDF / brochure). Files too big for WhatsApp (image 5 MB, video 16 MB) go with the link template.</li>
            </ul></li>
          <li>Add a payment method in WhatsApp Manager › Payment settings (Meta bills each delivered marketing message).</li>
        </Steps>
        <div style={grid}>
          <Field label="Webhook callback URL"><Copy text={d.urls.wa_webhook} /></Field>
          <Field label="Webhook verify token"><Copy text={s.wa_verify_token} /></Field>
        </div>
        <div style={grid}>
          <Field label="Phone number ID"><input className="field-input" value={f.wa.phone_number_id} onChange={(e) => setF({ ...f, wa: { ...f.wa, phone_number_id: e.target.value } })} /></Field>
          <Field label="WhatsApp Business Account ID"><input className="field-input" value={f.wa.waba_id} onChange={(e) => setF({ ...f, wa: { ...f.wa, waba_id: e.target.value } })} /></Field>
          <Field label={`Access token${s.wa_token ? " (saved — type to replace)" : ""}`}><input className="field-input" type="password" value={sec.wa_token} onChange={(e) => setSec({ ...sec, wa_token: e.target.value })} /></Field>
          <Field label={`App secret${s.wa_app_secret ? " (saved)" : " (for the webhook)"}`}><input className="field-input" type="password" value={sec.wa_app_secret} onChange={(e) => setSec({ ...sec, wa_app_secret: e.target.value })} /></Field>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--slate)" }}>Template names (exactly as approved in WhatsApp Manager)</div>
        <div style={grid}>
          {[["link", "Link (required)"], ["poster", "Poster — image header"], ["video", "Video — video header"], ["pdf", "Technical PDF — document header"], ["brochure", "Brochure — document header"]].map(([k, l]) => (
            <div key={k} style={{ display: "flex", gap: 6 }}>
              <Field label={l} style={{ flex: 1 }}><input className="field-input" value={f.wa.templates[k]?.name || ""} onChange={tpl(k, "name")} /></Field>
              <Field label="Lang"><input className="field-input" value={f.wa.templates[k]?.lang || "en"} onChange={tpl(k, "lang")} style={{ width: 60 }} /></Field>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Field label="Send a test (link template) to"><input className="field-input" value={test.wa} onChange={(e) => setTest({ ...test, wa: e.target.value })} placeholder="98470 12345" /></Field>
          <button type="button" onClick={() => runTest("wa")}>Send test</button>
          <span style={{ fontSize: 12, color: "var(--slate)" }}>This month: {d.usage.wa_month} WhatsApp API messages</span>
        </div>
      </Section>

      <Section title="Email" status={ok(s.smtp.host && s.smtp.user && s.smtp.pass)}>
        <div style={{ fontSize: 12.5, color: "var(--slate)" }}>The mail server of mail@ourownrm.com (your web host's SMTP — usually mail.ourownrm.com, port 465). Without it, email is sent one by one from each person's own mail app.</div>
        <div style={grid}>
          <Field label="SMTP server"><input className="field-input" value={sec.smtp.host} onChange={(e) => setSec({ ...sec, smtp: { ...sec.smtp, host: e.target.value } })} placeholder="mail.ourownrm.com" /></Field>
          <Field label="Port"><input className="field-input" value={sec.smtp.port} onChange={(e) => setSec({ ...sec, smtp: { ...sec.smtp, port: e.target.value } })} /></Field>
          <Field label="User"><input className="field-input" value={sec.smtp.user} onChange={(e) => setSec({ ...sec, smtp: { ...sec.smtp, user: e.target.value } })} placeholder="mail@ourownrm.com" /></Field>
          <Field label={`Password${s.smtp.pass ? " (saved — type to replace)" : ""}`}><input className="field-input" type="password" value={sec.smtp.pass} onChange={(e) => setSec({ ...sec, smtp: { ...sec.smtp, pass: e.target.value } })} /></Field>
          <Field label="From name"><input className="field-input" value={f.email.from_name} onChange={(e) => setF({ ...f, email: { ...f.email, from_name: e.target.value } })} /></Field>
          <Field label="From address"><input className="field-input" value={f.email.from_email} onChange={(e) => setF({ ...f, email: { ...f.email, from_email: e.target.value } })} placeholder="mail@ourownrm.com" /></Field>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Field label="Send a test email to"><input className="field-input" value={test.email} onChange={(e) => setTest({ ...test, email: e.target.value })} /></Field>
          <button type="button" onClick={() => runTest("email")}>Send test</button>
        </div>
      </Section>

      <Section title="Lists and rules">
        <div style={grid}>
          <Field label="Firm types (one per line)"><textarea className="field-input" rows={7} value={lines(f.firm_types)} onChange={(e) => setF({ ...f, firm_types: unlines(e.target.value) })} /></Field>
          <Field label="Communication categories"><textarea className="field-input" rows={7} value={lines(f.categories)} onChange={(e) => setF({ ...f, categories: unlines(e.target.value) })} /></Field>
          <Field label="Firm categories"><textarea className="field-input" rows={7} value={lines(f.firm_categories)} onChange={(e) => setF({ ...f, firm_categories: unlines(e.target.value) })} /></Field>
        </div>
        <div style={grid}>
          {[1, 2, 3].map((l) => <Field key={l} label={`Level ${l} name`}><input className="field-input" value={f.levels[l]} onChange={(e) => setF({ ...f, levels: { ...f.levels, [l]: e.target.value } })} /></Field>)}
        </div>
        <Field label="Festivals (one per line: name, date — e.g. Christmas, 2026-12-25)" hint="Plans set to “Festivals” fall due on these dates. Add next year's dates once a year.">
          <textarea className="field-input" rows={5} value={(f.festivals || []).map((x) => `${x.name}, ${x.date}`).join("\n")}
            onChange={(e) => setF({ ...f, festivals: unlines(e.target.value).map((l) => { const i = l.lastIndexOf(","); return { name: l.slice(0, i).trim(), date: l.slice(i + 1).trim() }; }) })} />
        </Field>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={!!f.require_consent} onChange={(e) => setF({ ...f, require_consent: e.target.checked })} /> Send marketing only to people marked "agreed to receive" (WhatsApp's rule for the API)</label>
        <div style={grid}>
          <Field label="At most one marketing message per person every (days, 0 = no limit)"><input className="field-input" type="number" min={0} max={90} value={f.min_days_between} onChange={set("min_days_between")} /></Field>
          <Field label="App address used in tracking links"><input className="field-input" value={f.public_origin || ""} onChange={set("public_origin")} /></Field>
        </div>
      </Section>

      <div style={{ padding: "4px 0 40px" }}>
        <button type="button" className="btn-primary" onClick={() => save()} style={{ minHeight: 46 }}>Save settings</button>
      </div>
    </div>
  );
}
