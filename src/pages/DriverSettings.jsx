import { useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.jsx";
import { useT, SUPPORTED_LANGUAGES } from "../lib/i18n.js";

export default function DriverSettings() {
  const { user, updateUser } = useAuth();
  const t = useT();
  const [lang, setLang] = useState(user?.preferred_language || "en");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true); setError(""); setSaved(false);
    try {
      await apiRequest("/driver/language", { method: "PATCH", body: { preferred_language: lang } });
      updateUser({ preferred_language: lang });
      setSaved(true);
    } catch (err) {
      setError(err.message || "Couldn't save this — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title={t("settings")} />
      <div style={{ maxWidth: 360, margin: "0 auto", padding: "0 16px 32px" }}>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>{t("app_language")}</div>
          {SUPPORTED_LANGUAGES.map((l) => (
            <label
              key={l.code}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid var(--concrete)", cursor: "pointer", fontSize: 14 }}
            >
              <input type="radio" name="lang" value={l.code} checked={lang === l.code} onChange={() => { setLang(l.code); setSaved(false); }} />
              {l.label}
            </label>
          ))}
          {error && <div style={{ color: "var(--alert-red)", fontSize: 12, marginTop: 8 }}>{error}</div>}
          {saved && !error && <div style={{ color: "var(--signal-green)", fontSize: 12, marginTop: 8 }}>{t("saved")}</div>}
          <button onClick={save} disabled={saving} style={{ width: "100%", marginTop: 14 }}>
            {saving ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </>
  );
}
