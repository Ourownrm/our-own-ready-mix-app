import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { usePermissions } from "../lib/PermissionContext.jsx";
import { todayStr } from "../lib/istDate.js";

// Round 157 — what the batching plant actually made, and what it actually ate.
//
// Fed by the MCI370 agent on the plant control PC (tools/mci370-agent), which
// reads Schwing Stetter's own Access database read-only. Three tabs:
//
//   Production  — m³ by day and by recipe, and the recent loads.
//   Consumption — kilograms per silo, and the figure that matters most to a
//                 ready-mix plant: kg per m³, against what the recipe asked for.
//   Silos       — Administrator only. Which of our materials each hopper holds.
//
// WHY CONSUMPTION IS REPORTED BY SILO, not by material. A hopper nobody has
// mapped yet still shows its real weights rather than disappearing, because the
// plant genuinely weighed it — the numbers are true before the mapping work is
// done. That is the opposite of the weighbridge, where an unresolved name means
// we do not know what arrived and showing a total would be a lie.

function fmtKg(kg) {
  if (kg == null) return "—";
  const n = Number(kg);
  if (n >= 1000) return `${(n / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} t`;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg`;
}
function fmtM3(v) {
  return v == null ? "—" : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })} m³`;
}
function fmtWhen(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString([], { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(d) {
  // The backend sends this as a plain 'YYYY-MM-DD' string, so read it as one.
  // Parsing it into a Date only to format it back is how a batch made at 9am
  // on the 25th ends up labelled the 24th on somebody's phone.
  if (!d) return "—";
  const [, m, day] = String(d).slice(0, 10).split("-");
  return m && day ? `${day} ${MONTHS[Number(m) - 1] || m}` : String(d);
}
function ago(ts) {
  if (!ts) return { text: "never", stale: true };
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return { text: "just now", stale: false };
  if (mins < 60) return { text: `${mins} min ago`, stale: mins > 10 };
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return { text: `${hrs} hr ago`, stale: true };
  return { text: `${Math.floor(hrs / 24)} d ago`, stale: true };
}

const TH = { padding: "9px 12px", textAlign: "left" };
const TD = { padding: "9px 12px" };

// ---------------------------------------------------------------------------

function Production({ days }) {
  const [data, setData] = useState(null);
  const [loads, setLoads] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.all([
      apiRequest(`/plant/production?days=${days}`),
      apiRequest(`/plant/loads?days=${days}`),
    ])
      .then(([p, l]) => { if (alive) { setData(p); setLoads(l); } })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [days]);

  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!data) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;

  const maxDay = Math.max(...data.by_day.map((d) => Number(d.m3)), 1);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div className="card">
          <h3 style={{ fontSize: 14, margin: "0 0 12px" }}>By day</h3>
          {!data.by_day.length && <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing batched in this period.</div>}
          {data.by_day.map((d) => (
            <div key={d.batch_date} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 7 }}>
              <span style={{ fontSize: 12.5, width: 62, color: "var(--slate)" }}>{fmtDay(d.batch_date)}</span>
              {/* A plain proportional bar rather than a chart library — one
                  series, one dimension, and it has to be readable on the plant
                  office screen at a glance. */}
              <span style={{ flexGrow: 1, height: 16, background: "var(--concrete)", borderRadius: 3, overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${(Number(d.m3) / maxDay) * 100}%`, background: "var(--rebar)" }} />
              </span>
              <span style={{ fontSize: 12.5, width: 74, textAlign: "right", fontWeight: 600 }}>{fmtM3(d.m3)}</span>
              <span style={{ fontSize: 11.5, width: 62, textAlign: "right", color: "var(--slate)" }}>{d.loads} loads</span>
            </div>
          ))}
        </div>

        <div className="card">
          <h3 style={{ fontSize: 14, margin: "0 0 12px" }}>By recipe</h3>
          {!data.by_recipe.length && <div style={{ fontSize: 13, color: "var(--slate)" }}>—</div>}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {data.by_recipe.map((r) => (
                <tr key={r.recipe_code} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ ...TD, fontWeight: 600 }}>{r.recipe_code}</td>
                  <td style={{ ...TD, color: "var(--slate)", fontSize: 12 }}>{r.recipe_name || ""}</td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmtM3(r.m3)}</td>
                  <td style={{ ...TD, textAlign: "right", color: "var(--slate)", fontSize: 12 }}>{r.loads} loads</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h3 style={{ fontSize: 15, margin: "0 0 10px" }}>Recent loads</h3>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Batch</th><th style={TH}>Started</th><th style={TH}>Recipe</th>
              <th style={{ ...TH, textAlign: "right" }}>Made</th><th style={{ ...TH, textAlign: "right" }}>Mixes</th>
              <th style={TH}>Truck</th><th style={TH}>Site</th><th style={TH}>Batcher</th>
            </tr>
          </thead>
          <tbody>
            {loads.map((l) => (
              <tr key={`${l.batch_year}-${l.batch_no}-${l.plant_no}`} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ ...TD, fontWeight: 600 }}>#{l.batch_no}</td>
                <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmtWhen(l.started_at)}</td>
                <td style={TD}>{l.recipe_code}</td>
                <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{fmtM3(l.m3)}</td>
                {/* The mix count is the thing people get wrong about this data:
                    one load is several batches, and consumption sums across them. */}
                <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>{l.batches}</td>
                <td style={TD}>{l.truck_no || "—"}</td>
                <td style={TD}>{l.site_name || "—"}</td>
                <td style={{ ...TD, color: "var(--slate)" }}>{l.batcher_name || "—"}</td>
              </tr>
            ))}
            {!loads.length && (
              <tr><td colSpan={8} style={{ ...TD, color: "var(--slate)" }}>No loads in this period.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function Consumption({ days }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    apiRequest(`/plant/consumption?days=${days}`)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [days]);

  if (error) return <div className="card" style={{ color: "var(--alert-red)", fontSize: 13 }}>{error}</div>;
  if (!data) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;

  const m3 = Number(data.total_m3) || 0;
  const totalKg = data.silos.reduce((a, s) => a + Number(s.actual_kg || 0), 0);

  return (
    <>
      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 26, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <div className="kpi-label">Produced</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtM3(m3)}</div>
        </div>
        <div>
          <div className="kpi-label">Materials used</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtKg(totalKg)}</div>
        </div>
        <div>
          <div className="kpi-label">Overall density</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            {m3 ? `${Math.round(totalKg / m3).toLocaleString()} kg/m³` : "—"}
          </div>
        </div>
        <p style={{ margin: 0, marginLeft: "auto", maxWidth: 380, fontSize: 11.5, color: "var(--slate)", lineHeight: 1.5 }}>
          Every figure is what the plant's own load cells weighed, summed across the batches that made
          up each load. Nothing here is derived from a mix design.
        </p>
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Silo</th>
              <th style={TH}>Material</th>
              <th style={{ ...TH, textAlign: "right" }}>Weighed</th>
              <th style={{ ...TH, textAlign: "right" }}>Recipe asked for</th>
              <th style={{ ...TH, textAlign: "right" }}>Difference</th>
              <th style={{ ...TH, textAlign: "right" }}>Per m³</th>
              <th style={{ ...TH, textAlign: "right" }}>Moisture</th>
            </tr>
          </thead>
          <tbody>
            {data.silos.map((s) => {
              const actual = Number(s.actual_kg || 0);
              const target = Number(s.target_kg || 0);
              const diff = target ? actual - target : null;
              const diffPct = target ? (diff / target) * 100 : null;
              // 2% is the band where a batching plant's own tolerance normally
              // sits. Beyond it on a whole period's total is worth a look —
              // a single mix drifting is normal, a month drifting is not.
              const off = diffPct != null && Math.abs(diffPct) > 2;
              return (
                <tr key={`${s.slot}-${s.material_id ?? "x"}`} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={TD}>
                    <div style={{ fontWeight: 600 }}>{s.slot_name || s.slot}</div>
                    <div style={{ fontSize: 11, color: "var(--slate)" }}>{s.slot} · {s.mixes} batches</div>
                  </td>
                  <td style={TD}>
                    {/* Three states, not two. A hopper somebody has decided is
                        not stock — mains water, a spare — is settled work, and
                        colouring it amber alongside genuinely unmapped silos
                        would nag forever about a decision already taken. */}
                    {s.material_name
                      ? s.material_name
                      : s.ignored
                        ? <span style={{ color: "var(--slate)", fontStyle: "italic" }}>not a stock material</span>
                        : <span style={{ color: "var(--amber)" }}>not mapped yet</span>}
                  </td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmtKg(actual)}</td>
                  <td style={{ ...TD, textAlign: "right", color: "var(--slate)", whiteSpace: "nowrap" }}>{target ? fmtKg(target) : "—"}</td>
                  <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap", color: off ? "var(--alert-red)" : "var(--slate)" }}>
                    {diff == null ? "—" : `${diff > 0 ? "+" : ""}${diff.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg (${diffPct > 0 ? "+" : ""}${diffPct.toFixed(1)}%)`}
                  </td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>
                    {m3 ? `${Math.round(actual / m3).toLocaleString()} kg` : "—"}
                  </td>
                  <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>
                    {s.avg_moisture_pct == null ? "—" : `${Number(s.avg_moisture_pct).toFixed(1)}%`}
                  </td>
                </tr>
              );
            })}
            {!data.silos.length && (
              <tr><td colSpan={7} style={{ ...TD, color: "var(--slate)" }}>Nothing consumed in this period.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 12, color: "var(--slate)", marginTop: 14, lineHeight: 1.6 }}>
        Moisture is the plant's own aggregate reading, and it is the only trustworthy moisture figure
        in this app's data — the weighbridge stores its moisture as free text and has never once held
        a real number. A silo showing no moisture is a powder or a liquid, which the plant does not
        measure that way.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
function Silos() {
  const [data, setData] = useState(null);
  const [fills, setFills] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState({});
  const [fillDraft, setFillDraft] = useState({ slot: "", material_id: "", qty_kg: "", filled_at: "" });
  const [busy, setBusy] = useState(false);

  async function load() {
    setError("");
    try {
      const [d, f] = await Promise.all([
        apiRequest("/plant/silos"),
        apiRequest("/plant/silo-fills"),
      ]);
      setData(d); setFills(f);
    } catch (err) { setError(err.message || "Could not load the silos."); }
  }
  useEffect(() => { load(); }, []);

  async function save(slot, slotName) {
    const choice = draft[slot];
    if (!choice) return;
    setError(""); setNotice("");
    const body = { slot, slot_name: slotName };
    if (choice === "ignore") body.is_ignored = true;
    else if (choice === "refill") body.is_refillable = true;
    else body.material_id = Number(choice);
    try {
      const r = await apiRequest("/plant/silos", { method: "POST", body });
      setNotice(`Saved. ${r.rows_updated} batch row${r.rows_updated === 1 ? "" : "s"} re-attributed.`);
      setDraft({ ...draft, [slot]: "" });
      await load();
    } catch (err) { setError(err.message); }
  }

  async function addFill(e) {
    e.preventDefault();
    setError(""); setNotice(""); setBusy(true);
    try {
      const r = await apiRequest("/plant/silo-fills", {
        method: "POST",
        body: {
          slot: fillDraft.slot,
          material_id: Number(fillDraft.material_id),
          qty_kg: Number(fillDraft.qty_kg),
          filled_at: fillDraft.filled_at,
        },
      });
      setNotice(`Fill recorded. ${r.rows_updated} batch row${r.rows_updated === 1 ? "" : "s"} now costed against it.`);
      setFillDraft({ slot: "", material_id: "", qty_kg: "", filled_at: "" });
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function removeFill(id) {
    setError(""); setNotice("");
    try { await apiRequest(`/plant/silo-fills/${id}`, { method: "DELETE" }); await load(); }
    catch (err) { setError(err.message); }
  }

  async function recheck() {
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await apiRequest("/plant/recheck", { method: "POST" });
      setNotice(`Re-checked. ${r.rows_updated} batch row${r.rows_updated === 1 ? "" : "s"} changed.`);
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  if (!data) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;

  const aliasBySlot = new Map(data.aliases.map((a) => [a.slot, a]));
  const refillable = data.seen.filter((s) => aliasBySlot.get(s.slot)?.is_refillable);

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 14, color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 14, color: "var(--signal-green)", fontSize: 13 }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
        <strong>Each hopper is one of three things.</strong> One of your materials, permanently — a sand
        or aggregate gate. <em>Refillable storage</em>, which holds whatever was last put in it: the cement
        and fly-ash silos. Or <em>not stock at all</em> — mains water, a spare. Its weights still show in
        consumption; they simply do not come off anybody's stock.
        <br />
        Mappings are held against the <strong>hopper</strong>, not its name, because your plant calls both
        Gate 1 and Gate 2 "M SAND" — keyed on the name the two could never be told apart.
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>Hoppers the plant has used</h3>
        <button type="button" style={{ marginLeft: "auto", fontSize: 13 }} disabled={busy} onClick={recheck}>
          {busy ? "Re-checking…" : "Re-check all"}
        </button>
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto", marginBottom: 24 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Hopper</th><th style={TH}>Panel calls it</th>
              <th style={{ ...TH, textAlign: "right" }}>Weighed</th>
              <th style={TH}>Holds</th><th style={TH} />
            </tr>
          </thead>
          <tbody>
            {data.seen.map((s) => {
              const a = aliasBySlot.get(s.slot);
              const current = a?.is_refillable ? "— refillable storage —"
                : a?.is_ignored ? "— not a stock material —"
                : a?.target ? a.target : null;
              return (
                <tr key={s.slot} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ ...TD, color: "var(--slate)", fontFamily: "ui-monospace, monospace" }}>{s.slot}</td>
                  <td style={{ ...TD, fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                    {s.slot_name}
                    {s.name_count > 1 && (
                      <div style={{ fontSize: 10.5, color: "var(--amber)", fontFamily: "inherit" }}>
                        renamed on the panel {s.name_count} times
                      </div>
                    )}
                  </td>
                  <td style={{ ...TD, textAlign: "right" }}>{fmtKg(s.actual_kg)}<div style={{ fontSize: 10.5, color: "var(--slate)" }}>{s.batches} batches</div></td>
                  <td style={TD}>
                    <select aria-label={`What ${s.slot_name} holds`}
                            value={draft[s.slot] || ""}
                            onChange={(e) => setDraft({ ...draft, [s.slot]: e.target.value })}
                            style={{ fontSize: 13, minWidth: 214 }}>
                      <option value="">{current || "Choose…"}</option>
                      <option value="refill">— refillable storage —</option>
                      {data.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      <option value="ignore">— not a stock material —</option>
                    </select>
                  </td>
                  <td style={TD}>
                    <button type="button" className="btn-primary" style={{ fontSize: 12 }}
                            disabled={!draft[s.slot]} onClick={() => save(s.slot, s.slot_name)}>
                      Save
                    </button>
                  </td>
                </tr>
              );
            })}
            {!data.seen.length && (
              <tr><td colSpan={5} style={{ ...TD, color: "var(--slate)" }}>
                Nothing synced yet — the plant agent has not sent anything.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: 15, margin: "0 0 4px" }}>What is in the refillable silos</h3>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--slate)", lineHeight: 1.55, maxWidth: 820 }}>
        A fill takes effect from its own moment onward. A batch made on the 3rd is costed against whatever
        the silo held on the 3rd, and a fill on the 10th changes nothing behind it. MCI370 cannot tell us any
        of this — its own stock table has read zero since 2013.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14, marginBottom: 18 }}>
        {refillable.map((s) => {
          const b = s.balance;
          const left = b ? Number(b.filled_kg) - Number(b.used_kg) : null;
          const pct = b && Number(b.filled_kg) > 0 ? Math.max(0, Math.min(100, (left / Number(b.filled_kg)) * 100)) : 0;
          const colour = left == null ? "var(--slate)" : left <= 0 ? "var(--alert-red)" : pct < 25 ? "var(--amber)" : "var(--signal-green)";
          return (
            <div key={s.slot} className="card">
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700, fontSize: 16 }}>{s.slot_name}</span>
                <span style={{ fontSize: 11, color: "var(--slate)" }}>{s.slot}</span>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginTop: 3 }}>
                {b?.current_material || <span style={{ color: "var(--amber)" }}>never filled</span>}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--slate)" }}>
                {b?.last_filled_at ? `filled ${fmtWhen(b.last_filled_at)}` : "no fill recorded"}
              </div>
              <div style={{ height: 9, background: "var(--concrete)", borderRadius: 4, margin: "10px 0 6px", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, background: colour }} />
              </div>
              <div style={{ display: "flex", fontSize: 12 }}>
                <span style={{ color: "var(--slate)" }}>Left</span><span style={{ flexGrow: 1 }} />
                <span style={{ fontWeight: 700, color: colour }}>{left == null ? "—" : fmtKg(left)}</span>
              </div>
              {left != null && left < 0 && (
                <div style={{ fontSize: 11, color: "var(--alert-red)", marginTop: 5, lineHeight: 1.45 }}>
                  The plant has weighed out more than was ever recorded going in — fills are missing, not cement.
                </div>
              )}
            </div>
          );
        })}
        {!refillable.length && (
          <div className="card" style={{ gridColumn: "span 3", fontSize: 13, color: "var(--slate)" }}>
            No hopper is marked refillable yet. Mark CEM1, CEM2 and CEM3 above and their contents can be tracked.
          </div>
        )}
      </div>

      <form onSubmit={addFill} className="card" style={{ marginBottom: 18, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ fontSize: 11.5, color: "var(--slate)", display: "flex", flexDirection: "column", gap: 3 }}>Silo
          <select required value={fillDraft.slot} onChange={(e) => setFillDraft({ ...fillDraft, slot: e.target.value })} style={{ fontSize: 13 }}>
            <option value="">Choose…</option>
            {refillable.map((s) => <option key={s.slot} value={s.slot}>{s.slot_name} ({s.slot})</option>)}
          </select>
        </label>
        <label style={{ fontSize: 11.5, color: "var(--slate)", display: "flex", flexDirection: "column", gap: 3 }}>Material
          <select required value={fillDraft.material_id} onChange={(e) => setFillDraft({ ...fillDraft, material_id: e.target.value })} style={{ fontSize: 13, minWidth: 186 }}>
            <option value="">Choose…</option>
            {data.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 11.5, color: "var(--slate)", display: "flex", flexDirection: "column", gap: 3 }}>Quantity (kg)
          <input required type="number" step="1" min="1" value={fillDraft.qty_kg}
                 onChange={(e) => setFillDraft({ ...fillDraft, qty_kg: e.target.value })} style={{ fontSize: 13, width: 118 }} />
        </label>
        <label style={{ fontSize: 11.5, color: "var(--slate)", display: "flex", flexDirection: "column", gap: 3 }}>Filled at
          <input required type="datetime-local" value={fillDraft.filled_at}
                 onChange={(e) => setFillDraft({ ...fillDraft, filled_at: e.target.value })} style={{ fontSize: 13 }} />
        </label>
        <button type="submit" className="btn-primary" style={{ fontSize: 13 }} disabled={busy}>Record fill</button>
        <span style={{ fontSize: 11.5, color: "var(--slate)", maxWidth: 300, lineHeight: 1.45 }}>
          Normally this comes from the receipt itself. Use this for the opening declaration, or a fill nobody recorded.
        </span>
      </form>

      <h3 style={{ fontSize: 15, margin: "0 0 10px" }}>Fill history</h3>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Silo</th><th style={TH}>Material</th><th style={TH}>Supplier</th>
              <th style={TH}>Filled</th><th style={{ ...TH, textAlign: "right" }}>Qty</th>
              <th style={TH}>Until</th><th style={TH}>On top of</th><th style={TH} />
            </tr>
          </thead>
          <tbody>
            {fills.map((f) => (
              <tr key={f.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ ...TD, fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{f.slot}</td>
                <td style={TD}>{f.material_name}</td>
                <td style={{ ...TD, color: "var(--slate)" }}>{f.supplier_name || "—"}{f.challan_number ? ` · ${f.challan_number}` : ""}</td>
                <td style={{ ...TD, whiteSpace: "nowrap" }}>{fmtWhen(f.filled_at)}</td>
                <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{fmtKg(f.qty_kg)}</td>
                <td style={{ ...TD, whiteSpace: "nowrap", color: "var(--slate)" }}>
                  {f.until ? fmtWhen(f.until) : <span style={{ color: "var(--signal-green)", fontWeight: 600 }}>still in</span>}
                </td>
                <td style={{ ...TD, fontSize: 11.5, color: "var(--slate)" }}>
                  {f.was_empty ? "empty silo" : `${fmtKg(f.balance_before_kg)} remaining`}
                </td>
                <td style={{ ...TD, textAlign: "right" }}>
                  <button type="button" style={{ fontSize: 12 }} onClick={() => removeFill(f.id)}>Remove</button>
                </td>
              </tr>
            ))}
            {!fills.length && <tr><td colSpan={8} style={{ ...TD, color: "var(--slate)" }}>No fills recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function Manual({ canEdit }) {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState({});

  async function load(d) {
    setError("");
    try { setData(await apiRequest(`/plant/manual?date=${d}`)); }
    catch (err) { setError(err.message || "Could not load the day."); }
  }
  useEffect(() => { load(date); setDraft({}); }, [date]);

  async function save(materialId, value) {
    setError(""); setNotice("");
    try {
      const body = { entry_date: date, reason: (draft.reason ?? data?.reason ?? "") || undefined };
      if (materialId == null) body.qty_m3 = Number(value || 0);
      else { body.material_id = materialId; body.qty_kg = Number(value || 0); }
      await apiRequest("/plant/manual", { method: "POST", body });
      setNotice("Saved. The plant's own figure is untouched — this is added to it.");
      await load(date);
    } catch (err) { setError(err.message); }
  }

  if (!data) return <div className="card" style={{ fontSize: 13, color: "var(--slate)" }}>Loading…</div>;

  const manualByMaterial = new Map(data.entries.filter((e) => e.material_id != null).map((e) => [e.material_id, e]));
  const prodManual = data.entries.find((e) => e.material_id == null);
  const autoM3 = Number(data.production?.auto_m3 || 0);
  const manM3 = Number(prodManual?.qty_m3 || 0);

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 14, color: "var(--alert-red)", fontSize: 13 }}>{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 14, color: "var(--signal-green)", fontSize: 13 }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ fontSize: 11.5, color: "var(--slate)", display: "flex", flexDirection: "column", gap: 3 }}>Day
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ fontSize: 13 }} />
        </label>
        <p style={{ margin: 0, fontSize: 12, color: "var(--slate)", lineHeight: 1.55, maxWidth: 720 }}>
          The plant's column cannot be edited — it is what the load cells weighed, and if it looks wrong that
          is a finding, not a typo. Enter <strong style={{ color: "var(--charcoal)" }}>only what the plant did
          not record</strong>: a hand mix, a load batched while the agent was offline, material taken for
          something else. The two are added.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14, marginBottom: 20 }}>
        <div className="card">
          <div className="kpi-label">Production — from the plant</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{autoM3.toFixed(1)} <span style={{ fontSize: 15, color: "var(--slate)" }}>m³</span></div>
          <div style={{ fontSize: 11.5, color: "var(--slate)" }}>{data.production?.loads ?? 0} loads · {data.production?.batches ?? 0} batches</div>
        </div>
        <div className="card" style={{ background: "var(--amber-bg)" }}>
          <label htmlFor="manm3" className="kpi-label">Production — manual</label>
          <input id="manm3" type="number" step="0.5" min="0" disabled={!canEdit}
                 defaultValue={manM3 || ""} placeholder="0"
                 onBlur={(e) => canEdit && save(null, e.target.value)}
                 style={{ width: "100%", fontSize: 22, fontWeight: 700, padding: "2px 6px" }} />
          <div style={{ fontSize: 11, color: "var(--amber)", marginTop: 3 }}>m³ the plant did not record</div>
        </div>
        <div className="card" style={{ background: "var(--signal-green-bg)" }}>
          <div className="kpi-label">Total today</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{(autoM3 + manM3).toFixed(1)} <span style={{ fontSize: 15, color: "var(--slate)" }}>m³</span></div>
          <div style={{ fontSize: 11.5, color: "var(--signal-green)" }}>this is what cost per m³ divides by</div>
        </div>
      </div>

      <h3 style={{ fontSize: 15, margin: "0 0 10px" }}>Consumption</h3>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--concrete)" }}>
              <th style={TH}>Material</th>
              <th style={{ ...TH, textAlign: "right" }}>From the plant</th>
              <th style={{ ...TH, textAlign: "right" }}>Manual</th>
              <th style={{ ...TH, textAlign: "right" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {data.consumption.map((c) => {
              const auto = Number(c.auto_kg || 0);
              const man = Number(manualByMaterial.get(c.material_id)?.qty_kg || 0);
              return (
                <tr key={c.material_id ?? "unmapped"} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={TD}>
                    {c.material_name || <span style={{ color: "var(--amber)" }}>not mapped yet</span>}
                    <div style={{ fontSize: 10.5, color: "var(--slate)", fontFamily: "ui-monospace, monospace" }}>{c.slot}</div>
                  </td>
                  <td style={{ ...TD, textAlign: "right", color: "var(--slate)" }}>{fmtKg(auto)}</td>
                  <td style={{ ...TD, textAlign: "right" }}>
                    {c.material_id ? (
                      <input type="number" step="1" min="0" disabled={!canEdit}
                             defaultValue={man || ""} placeholder="0"
                             aria-label={`Manual consumption of ${c.material_name}`}
                             onBlur={(e) => canEdit && save(c.material_id, e.target.value)}
                             style={{ width: 96, textAlign: "right", fontSize: 13 }} />
                    ) : <span style={{ color: "var(--slate)" }}>—</span>}
                  </td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 700 }}>{fmtKg(auto + man)}</td>
                </tr>
              );
            })}
            {!data.consumption.length && (
              <tr><td colSpan={4} style={{ ...TD, color: "var(--slate)" }}>The plant batched nothing on this day.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {!canEdit && (
        <p style={{ fontSize: 12, color: "var(--slate)", marginTop: 12 }}>
          You can see these figures but not add to them. That is the Plant Operator's entry.
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
export default function PlantProduction() {
  const { can, ready } = usePermissions();
  const [tab, setTab] = useState("production");
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState(null);

  const canView = ready && can("production.plant-data", "view");
  const canMap = ready && can("production.plant-mapping", "view");
  const canManualView = ready && can("production.plant-manual", "view");
  const canManualEdit = ready && can("production.plant-manual", "create");

  useEffect(() => {
    if (!canView) return;
    let alive = true;
    const pull = () => apiRequest("/plant/summary").then((s) => { if (alive) setSummary(s); }).catch(() => {});
    pull();
    const id = setInterval(pull, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [canView]);

  if (!ready) return null;
  if (!canView) {
    return (
      <>
        <TopBar title="Plant Production" />
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 32px" }}>
          <div className="card" style={{ fontSize: 13 }}>
            You do not have access to the plant data. A Super Admin can grant it on the Access
            Control page.
          </div>
        </div>
      </>
    );
  }

  const heartbeat = ago(summary?.last_sync_at);

  return (
    <>
      <TopBar title="Plant Production" />
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 32px" }}>

        <div className="card" style={{ marginBottom: 16, display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div className="kpi-label">Made today</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{summary ? fmtM3(summary.today_m3) : "—"}</div>
          </div>
          <div>
            <div className="kpi-label">Loads today</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{summary?.today_loads ?? "—"}</div>
            <div style={{ fontSize: 11, color: "var(--slate)" }}>{summary?.today_batches ?? "—"} batches</div>
          </div>
          <div>
            <div className="kpi-label">Grades run</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{summary?.today_recipes ?? "—"}</div>
          </div>
          {!!summary?.unmapped_silos && (
            <div>
              <div className="kpi-label">Silos to map</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--amber)" }}>{summary.unmapped_silos}</div>
            </div>
          )}
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div className="kpi-label">Plant agent</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: heartbeat.stale ? "var(--alert-red)" : "var(--signal-green)" }}>
              {heartbeat.stale ? "Last seen " : "Live · "}{heartbeat.text}
            </div>
            {summary?.last_sync_error && (
              <div style={{ fontSize: 11, color: "var(--alert-red)", maxWidth: 320 }}>{summary.last_sync_error}</div>
            )}
          </div>
        </div>

        {heartbeat.stale && summary && (
          <div className="card" style={{ marginBottom: 16, background: "var(--alert-red-bg)", borderColor: "var(--alert-red)", fontSize: 13 }}>
            The plant PC has not sent anything recently. Nothing is lost — every batch is still in
            MCI370 and arrives once the agent is back — but nothing here is current until then.
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" className={`btn-tab ${tab === "production" ? "active" : ""}`} onClick={() => setTab("production")}>Production</button>
          <button type="button" className={`btn-tab ${tab === "consumption" ? "active" : ""}`} onClick={() => setTab("consumption")}>Consumption</button>
          {canMap && (
            <button type="button" className={`btn-tab ${tab === "silos" ? "active" : ""}`} onClick={() => setTab("silos")}>Silos</button>
          )}
          {/* Round 159 — what the plant did not record. Shown to anyone who can
              read the plant data; only the Plant Operator can type into it. */}
          <button type="button" className={`btn-tab ${tab === "manual" ? "active" : ""}`} onClick={() => setTab("manual")}>Manual entry</button>
          {tab !== "silos" && tab !== "manual" && (
            <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}
                    style={{ marginLeft: "auto", fontSize: 13 }}>
              <option value={1}>Today</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          )}
        </div>

        {tab === "silos" && canMap ? <Silos />
          : tab === "manual" ? <Manual canEdit={canManualEdit} />
          : tab === "consumption" ? <Consumption days={days} />
          : <Production days={days} />}
      </div>
    </>
  );
}
