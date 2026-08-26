import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

// Round 119, post-ship — Manager/Admin editor for the two public marketing
// pages (Services & Products, Ready-Mix vs. Site-Mix) added per the
// business's own mockup. Both pages are just a JSONB blob read by the public
// pages/ServicesPublic.jsx and pages/RmcVsSitemix.jsx — see routes/siteContent.js
// and schema.sql's comment on site_content. Kept as one screen with two tabs
// rather than two separate Masters-menu entries, since it's the same kind of
// occasional marketing-copy touch-up either way.
export default function SiteContentEditor() {
  const [tab, setTab] = useState("services");

  return (
    <>
      <TopBar title="Website Content" />
      <div style={{ maxWidth: 700, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="tabbar" style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
          <button onClick={() => setTab("services")} className={tab === "services" ? "btn-primary" : ""} style={{ fontSize: 12.5, padding: "6px 12px" }}>
            Services &amp; Products
          </button>
          <button onClick={() => setTab("rmc")} className={tab === "rmc" ? "btn-primary" : ""} style={{ fontSize: 12.5, padding: "6px 12px" }}>
            Ready-Mix vs. Site-Mix
          </button>
        </div>
        {tab === "services" && <ServicesEditor />}
        {tab === "rmc" && <RmcEditor />}
      </div>
    </>
  );
}

function useContent(key) {
  const [content, setContent] = useState(undefined);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  async function load() {
    try {
      const r = await apiRequest(`/site-content/${key}`);
      setContent(r.content);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, [key]);

  async function save(next) {
    setSaving(true); setError(""); setSavedAt(null);
    try {
      await apiRequest(`/site-content/${key}`, { method: "PUT", body: { content: next } });
      setContent(next);
      setSavedAt(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return { content, setContent, error, saving, savedAt, save };
}

const linesToArray = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const arrayToLines = (a) => (a || []).join("\n");

function ServicesEditor() {
  const { content, error, saving, savedAt, save } = useContent("services");
  const [gradesText, setGradesText] = useState("");
  const [services, setServices] = useState([]);
  const [fleet, setFleet] = useState([]);

  useEffect(() => {
    if (content === undefined) return;
    setGradesText(arrayToLines(content.grades));
    setServices(content.services || []);
    setFleet(content.fleet || []);
  }, [content]);

  if (content === undefined) {
    return <div className="card">{error ? <span style={{ color: "var(--alert-red)" }}>{error}</span> : "Loading..."}</div>;
  }

  function updateService(i, field, value) {
    setServices((prev) => prev.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)));
  }
  function updateFleet(i, field, value) {
    setFleet((prev) => prev.map((f, idx) => (idx === i ? { ...f, [field]: value } : f)));
  }

  function onSave() {
    save({
      grades: linesToArray(gradesText),
      services: services.filter((s) => s.title.trim()),
      fleet: fleet.filter((f) => f.title.trim()),
    });
  }

  return (
    <div className="card">
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}

      <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>Concrete grades</div>
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 6 }}>One grade per line, e.g. M25</div>
      <textarea rows={4} value={gradesText} onChange={(e) => setGradesText(e.target.value)} style={{ width: "100%", marginBottom: 18 }} />

      <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>Services</div>
      {services.map((s, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <input type="text" placeholder="Title" value={s.title} onChange={(e) => updateService(i, "title", e.target.value)} style={{ width: "100%", marginBottom: 4 }} />
            <textarea rows={2} placeholder="Description" value={s.description || ""} onChange={(e) => updateService(i, "description", e.target.value)} style={{ width: "100%" }} />
          </div>
          <button type="button" onClick={() => setServices((prev) => prev.filter((_, idx) => idx !== i))} style={{ fontSize: 12 }}>Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => setServices((prev) => [...prev, { title: "", description: "" }])} style={{ fontSize: 12, marginBottom: 18 }}>
        + Add service
      </button>

      <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>Fleet &amp; equipment</div>
      {fleet.map((f, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
          <input type="text" placeholder="Title" value={f.title} onChange={(e) => updateFleet(i, "title", e.target.value)} style={{ flex: 1 }} />
          <input type="text" placeholder="Subtitle" value={f.subtitle || ""} onChange={(e) => updateFleet(i, "subtitle", e.target.value)} style={{ flex: 1 }} />
          <button type="button" onClick={() => setFleet((prev) => prev.filter((_, idx) => idx !== i))} style={{ fontSize: 12 }}>Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => setFleet((prev) => [...prev, { title: "", subtitle: "" }])} style={{ fontSize: 12, marginBottom: 20 }}>
        + Add fleet item
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" className="btn-primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving..." : "Save changes"}
        </button>
        {savedAt && <span style={{ fontSize: 12, color: "var(--signal-green)" }}>Saved</span>}
      </div>
    </div>
  );
}

function RmcEditor() {
  const { content, error, saving, savedAt, save } = useContent("rmc_vs_sitemix");
  const [heroTitle, setHeroTitle] = useState("");
  const [heroSubtitle, setHeroSubtitle] = useState("");
  const [rmcPointsText, setRmcPointsText] = useState("");
  const [siteMixPointsText, setSiteMixPointsText] = useState("");
  const [costParagraph, setCostParagraph] = useState("");
  const [qualityParagraph, setQualityParagraph] = useState("");

  useEffect(() => {
    if (content === undefined) return;
    setHeroTitle(content.hero_title || "");
    setHeroSubtitle(content.hero_subtitle || "");
    setRmcPointsText(arrayToLines(content.ready_mix_points));
    setSiteMixPointsText(arrayToLines(content.site_mix_points));
    setCostParagraph(content.cost_paragraph || "");
    setQualityParagraph(content.quality_paragraph || "");
  }, [content]);

  if (content === undefined) {
    return <div className="card">{error ? <span style={{ color: "var(--alert-red)" }}>{error}</span> : "Loading..."}</div>;
  }

  function onSave() {
    save({
      hero_title: heroTitle,
      hero_subtitle: heroSubtitle,
      ready_mix_points: linesToArray(rmcPointsText),
      site_mix_points: linesToArray(siteMixPointsText),
      cost_paragraph: costParagraph,
      quality_paragraph: qualityParagraph,
    });
  }

  return (
    <div className="card">
      {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}

      <Field label="Hero title">
        <textarea rows={2} value={heroTitle} onChange={(e) => setHeroTitle(e.target.value)} style={{ width: "100%" }} />
      </Field>
      <Field label="Hero subtitle">
        <textarea rows={2} value={heroSubtitle} onChange={(e) => setHeroSubtitle(e.target.value)} style={{ width: "100%" }} />
      </Field>
      <Field label="Ready-mix points (one per line)">
        <textarea rows={4} value={rmcPointsText} onChange={(e) => setRmcPointsText(e.target.value)} style={{ width: "100%" }} />
      </Field>
      <Field label="Site-mix points (one per line)">
        <textarea rows={4} value={siteMixPointsText} onChange={(e) => setSiteMixPointsText(e.target.value)} style={{ width: "100%" }} />
      </Field>
      <Field label="Cost paragraph">
        <textarea rows={3} value={costParagraph} onChange={(e) => setCostParagraph(e.target.value)} style={{ width: "100%" }} />
      </Field>
      <Field label="Quality paragraph">
        <textarea rows={3} value={qualityParagraph} onChange={(e) => setQualityParagraph(e.target.value)} style={{ width: "100%" }} />
      </Field>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" className="btn-primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving..." : "Save changes"}
        </button>
        {savedAt && <span style={{ fontSize: 12, color: "var(--signal-green)" }}>Saved</span>}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <span style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, display: "block" }}>{label}</span>
      {children}
    </label>
  );
}
