// ROUND 161 — the three screens that turn a plant load into a printed ticket.
//
// (Loads waiting was removed in Round 188 — a docket is now raised from the
//  Batch / Docket Number dropdown on the MCI370 screen itself.)
// Recipe map         — MCI370's recipe code to the workbook's Mix Design row.
// Print queue        — what the plant PC's agent has done with each job.
//
// The shape of this screen follows from one fact: everything except the
// production quantity already came from the plant. So the operator is not
// filling a form, they are confirming a load and typing one figure. Anything
// that makes it look like data entry is working against that.

import { useEffect, useState } from "react";
import { solitaireApi } from "../../lib/solitaireApi.js";


/* ------------------------------------------------------------ recipe map */

export function RecipeMap({ account, toast }) {
  const [data, setData] = useState({ recipes: [], designs: [] });
  const [busy, setBusy] = useState(false);
  const canEdit = account?.role === "qc" || account?.role === "admin";

  const load = () => solitaireApi.recipeMap().then(setData).catch((e) => toast(`✕ ${e.message}`));
  useEffect(() => { load(); }, []);

  async function save(code, mixDesignId) {
    if (!mixDesignId) return;
    try { await solitaireApi.saveRecipeMap({ mci370_code: code, mix_design_id: Number(mixDesignId) }); load(); }
    catch (e) { toast(`✕ ${e.message}`); }
  }

  async function seed() {
    setBusy(true);
    try {
      const r = await solitaireApi.seedMixDesigns();
      const skipped = r.recipes.filter((x) => !x.created);
      toast(
        r.created
          ? `✔ ${r.created} mix ${r.created === 1 ? "design" : "designs"} created from the plant's own values and mapped. QC must review them.` +
            (skipped.length ? ` ${skipped.length} could not be seeded.` : "")
          : "Nothing to seed — every recipe the plant has run already has a design."
      );
      load();
    } catch (e) { toast(`✕ ${e.message}`); }
    finally { setBusy(false); }
  }

  const unmapped = data.recipes.filter((r) => !r.map_id);

  return (
    <div className="sol-panel">
      <h3 style={{ marginTop: 0 }}>Recipe map</h3>
      <p style={{ fontSize: 13, color: "#555", maxWidth: 720 }}>
        MCI370 and the workbook spell the same recipe differently — the plant writes{" "}
        <code>M25A</code>, the Mix Design sheet has <code>M 25 A</code> — and the sheet's lookup
        is an exact match, so the two have to be joined by hand. The ticket still prints the
        plant's own code; only the lookup uses the one chosen here.
      </p>

      {unmapped.length > 0 && canEdit && (
        <div style={{ background: "#fff4e5", border: "1px solid #e0a800", padding: "8px 10px", marginBottom: 12, fontSize: 13 }}>
          <b>{unmapped.length} unmapped.</b> Where the workbook has no design at all, MixTrack can
          create one from the design values the plant itself reports, for QC to check.{" "}
          <button type="button" className="sol-mtable-add" disabled={busy} onClick={seed}>
            {busy ? "Working…" : "Create the missing designs"}
          </button>
        </div>
      )}

      <table className="sol-mtable">
        <thead>
          <tr><th>MCI370 recipe</th><th style={{ textAlign: "right" }}>Loads</th><th>Last batched</th><th>Mix design used for the lookup</th><th>Mapped by</th></tr>
        </thead>
        <tbody>
          {data.recipes.map((r) => (
            <tr key={r.recipe_code} style={r.map_id ? undefined : { background: "#fff8f0" }}>
              <td><b>{r.recipe_code}</b><div style={{ fontSize: 11, color: "#666" }}>{r.recipe_name}</div></td>
              <td style={{ textAlign: "right" }}>{r.loads}</td>
              <td style={{ color: "#666" }}>{r.last_batched || "—"}</td>
              <td>
                <select value={r.mix_design_id || ""} disabled={!canEdit}
                        onChange={(e) => save(r.recipe_code, e.target.value)}>
                  <option value="">Not mapped</option>
                  {data.designs.map((d) => <option key={d.id} value={d.id}>{d.code}{d.name && d.name !== d.code ? ` — ${d.name}` : ""}</option>)}
                </select>
                {/* A suggestion, never applied. Two designs normalising the
                    same way produce no suggestion at all rather than a guess. */}
                {!r.map_id && r.suggestion && (
                  <div style={{ fontSize: 11, color: "#0a6" }}>
                    looks like <b>{r.suggestion.code}</b>
                    {canEdit && <> — <button type="button" className="sol-logout-link" style={{ background: "none", border: "none", padding: 0, font: "inherit" }} onClick={() => save(r.recipe_code, r.suggestion.id)}>use it</button></>}
                  </div>
                )}
              </td>
              <td style={{ fontSize: 11, color: "#666" }}>{r.mapped_by_name ? `${r.mapped_by_name} · ${r.mapped_at}` : "—"}</td>
            </tr>
          ))}
          {!data.recipes.length && <tr><td colSpan={5} style={{ textAlign: "center", color: "#888" }}>
            No plant loads have arrived yet, so there is nothing to map.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------- print queue */

export function PrintQueue({ toast }) {
  const [jobs, setJobs] = useState([]);
  const load = () => solitaireApi.printJobs().then(setJobs).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const waiting = jobs.filter((j) => j.status === "pending" || j.status === "claimed").length;

  return (
    <div className="sol-panel">
      <h3 style={{ marginTop: 0 }}>Print queue</h3>
      <p style={{ fontSize: 13, color: "#555", maxWidth: 720 }}>
        The agent on the plant PC picks these up, fills the workbook and calls its own print
        macro. {waiting > 0 ? <b>{waiting} waiting.</b> : "Nothing waiting."} A job that stays
        pending means the agent is not running — the ticket is not lost, it prints as soon as it
        is back.
      </p>
      <table className="sol-mtable">
        <thead><tr><th>Ticket</th><th>Status</th><th>Sheet</th><th>PDF</th><th>Queued</th><th /></tr></thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td><b>{j.batch_number}</b></td>
              <td>
                {j.status}
                {j.attempts > 1 && <span style={{ color: "#666" }}> ({j.attempts} attempts)</span>}
                {j.error && <div style={{ fontSize: 11, color: "#b00" }}>{j.error}</div>}
              </td>
              <td>{j.sheet_number}</td>
              <td style={{ fontSize: 11 }}>{j.pdf_filename || "—"}</td>
              <td style={{ fontSize: 11, color: "#666" }}>{j.created_at}</td>
              <td>
                {j.status === "failed" && (
                  <button type="button" className="sol-mtable-add"
                          onClick={() => solitaireApi.retryPrintJob(j.id).then(load).catch((e) => toast(`✕ ${e.message}`))}>
                    Retry
                  </button>
                )}
              </td>
            </tr>
          ))}
          {!jobs.length && <tr><td colSpan={6} style={{ textAlign: "center", color: "#888" }}>Nothing printed yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
