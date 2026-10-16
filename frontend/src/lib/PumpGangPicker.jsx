// Round 211 — choose the pump gang on an order. The gang is not fixed to a
// pump; a gang with no order on a day has a no-pump day (routes/contractLabour.js).
import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

let cache = null;
export function useGangOptions() {
  const [gangs, setGangs] = useState(cache || []);
  useEffect(() => {
    if (cache) return;
    apiRequest("/contract-labour/gang-options").then((g) => { cache = g; setGangs(g); }).catch(() => {});
  }, []);
  return gangs;
}

// For an order form: a select when gangs exist, else the old free-text box.
export function PumpGangField({ gangId, crewText, onGang, onText, inputStyle }) {
  const gangs = useGangOptions();
  if (!gangs.length) return <input type="text" value={crewText} onChange={(e) => onText(e.target.value)} style={inputStyle} />;
  return (
    <select value={gangId || ""} onChange={(e) => onGang(e.target.value)} style={inputStyle}>
      <option value="">— choose the gang —</option>
      {gangs.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
    </select>
  );
}

// On an existing order: change the gang straight away.
export function PumpGangChanger({ order, onChanged }) {
  const gangs = useGangOptions();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!gangs.length) return null;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <select value={order.pump_gang_id || ""} disabled={busy} aria-label="Pump gang"
        onChange={async (e) => {
          setBusy(true); setErr("");
          try { await apiRequest(`/contract-labour/orders/${order.id}/pump-gang`, { method: "PUT", body: { gang_id: e.target.value || null } }); onChanged?.(); }
          catch (x) { setErr(x.message); } finally { setBusy(false); }
        }}>
        <option value="">— choose —</option>
        {gangs.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
      {err && <span style={{ color: "var(--alert-red)", fontSize: 12 }}>{err}</span>}
    </span>
  );
}
