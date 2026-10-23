// Round 238 (owner, 23 Oct 2026): a CSV statement, or a bank ".xls" that is
// really a web page, was read with day and month swapped for days 1–12
// (10/09/2026 saved as 9 October). The reading is fixed in the browser
// (lib/bankStatementParse.js). This repairs what was saved, once:
// for each upload that is not a PDF, its lines in file order should run in
// date order and none should be after the day it was uploaded. When the saved
// dates break that and swapping day ↔ month (days 1–12) mends it, the dates
// are swapped. A line whose corrected twin is already there (the same
// transaction from another upload) is removed as the duplicate it is.
import { dedupeKey, recomputeLoans } from "./bankBook.js";
import { unpostPayment } from "./ledgerPost.js";

const pad = (n) => String(n).padStart(2, "0");
function swap(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  if (d > 12 || d === m) return ymd;
  const days = new Date(Date.UTC(y, d, 0)).getUTCDate();
  if (m > days) return ymd;
  return `${y}-${pad(d)}-${pad(m)}`;
}
const mono = (ds) => ds.every((x, i) => i === 0 || x >= ds[i - 1]) || ds.every((x, i) => i === 0 || x <= ds[i - 1]);

// Works out what would change (dry run) or changes it.
export async function repairSwappedBankDates(pool, { apply = true } = {}) {
  const { rows: ups } = await pool.query(
    `SELECT id, account_id, file_name, (uploaded_at AT TIME ZONE 'Asia/Kolkata')::date::text AS up_day FROM cost_bank_uploads
      WHERE COALESCE(file_name, '') !~* '\\.pdf$'`);
  const out = { uploads: 0, lines: 0, duplicates: 0, files: [] };
  for (const u of ups) {
    const { rows: lines } = await pool.query(
      `SELECT id, txn_date::text AS d, narration, debit, credit, balance, post_kind, post_id FROM cost_bank_lines WHERE upload_id = $1 ORDER BY seq, id`, [u.id]);
    if (lines.length < 2) continue;
    const now = lines.map((l) => l.d), alt = now.map(swap);
    if (alt.every((x, i) => x === now[i])) continue;
    const broken = !mono(now) || now.some((x) => x > u.up_day);
    const mended = mono(alt) && !alt.some((x) => x > u.up_day);
    if (!broken || !mended) continue;
    out.uploads += 1; out.files.push(u.file_name || `upload ${u.id}`);
    if (!apply) { out.lines += alt.filter((x, i) => x !== now[i]).length; continue; }
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (let i = 0; i < lines.length; i++) {
        if (alt[i] === now[i]) continue;
        const l = lines[i];
        const key = dedupeKey(u.account_id, { date: alt[i], debit: l.debit, credit: l.credit, balance: l.balance, narration: l.narration });
        const { rows: twin } = await c.query(`SELECT id FROM cost_bank_lines WHERE dedupe_key = $1 AND id <> $2`, [key, l.id]);
        if (twin.length) {
          if (l.post_kind) await unpostPayment(c, l.post_kind, l.post_id, null, "Duplicate bank line (dates repaired)");
          await c.query(`DELETE FROM cost_bank_lines WHERE id = $1`, [l.id]);
          out.duplicates += 1;
          continue;
        }
        await c.query(`UPDATE cost_bank_lines SET txn_date = $2::date, dedupe_key = $3 WHERE id = $1`, [l.id, alt[i], key]);
        if (l.post_kind) {
          // A payment it posted carries the date too.
          const t = { supplier: ["rm_supplier_payments", "paid_on"], transporter: ["rm_transporter_payments", "paid_on"],
            contractor: ["hr_contractor_payments", "paid_on"], maintenance: ["mnt_payments", "paid_on"], certificate: ["mnt_certificates", "paid_on"] }[l.post_kind];
          if (t) await c.query(`UPDATE ${t[0]} SET ${t[1]} = $2::date WHERE id = $1`, [l.post_id, alt[i]]);
        }
        out.lines += 1;
      }
      await c.query(
        `UPDATE cost_bank_uploads u SET period_from = x.a, period_to = x.b
           FROM (SELECT MIN(txn_date) AS a, MAX(txn_date) AS b FROM cost_bank_lines WHERE upload_id = $1) x WHERE u.id = $1`, [u.id]);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  if (apply && out.uploads) await recomputeLoans({ query: (...a) => pool.query(...a) });
  return out;
}

export async function migrateRound238(pool, log) {
  const { rows } = await pool.query(`SELECT 1 FROM app_migration_marks WHERE mark = 'r238_bank_date_swap'`);
  if (rows.length) return;
  const r = await repairSwappedBankDates(pool);
  await pool.query(`INSERT INTO app_migration_marks (mark) VALUES ('r238_bank_date_swap') ON CONFLICT DO NOTHING`);
  log?.push?.(`Round 238: bank statement dates read day/month swapped — ${r.lines} line(s) in ${r.uploads} upload(s) corrected${r.duplicates ? `, ${r.duplicates} duplicate(s) removed` : ""}${r.files.length ? ` (${r.files.join(", ")})` : ""}.`);
}
