// Round 271 — what goes to TallyPrime, and how its answers are read.
//
// TallyPrime takes data over its XML server (Help › Settings › Connectivity,
// "TallyPrime acts as Server", port 9000). The app can't reach that from the
// internet, so the Tally Bridge (bridgeBat below) — a small program on the
// Tally computer — relays each request and returns Tally's reply untouched.
// Everything is built and read here; the bridge only carries it.
//
// A voucher is a Sales voucher of the chosen type in accounting voucher view:
// the party (one Cash ledger, or the customer's own) debited with the total,
// concrete and each charge credited to their ledgers, CGST and SGST, and the
// round-off. The figures are the Tally-format print's (frontend
// lib/tallyInvoice.js tallyFigures — keep the two the same), so the voucher and
// the printout agree to the paisa.
//
// Every non-ASCII character goes as a character reference, so the text
// reaches Tally the same whatever encoding the bridge sends it in.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const DEFAULT_LEDGERS = {
  party: "Cash",
  sales: "Sales RMC 18%",
  pump: "Pump Hire Charges",
  part_load: "Part Load Charges",
  waiting: "Waiting Charges",
  cgst: "Output CGST 9%",
  sgst: "Output SGST 9%",
  round_off: "Round Off",
};
export const LEDGER_LABELS = {
  party: "Customer (party) — when one ledger is used",
  sales: "Concrete sales",
  pump: "Pumping charges",
  part_load: "Part-load charges",
  waiting: "Waiting charges",
  cgst: "CGST 9%",
  sgst: "SGST 9%",
  round_off: "Round off",
};
export function ledgerNames(settings) {
  return { ...DEFAULT_LEDGERS, ...(settings?.ledgers || {}) };
}

// The invoice's lines and tax, Tally's way — the same as the Tally-format
// print (frontend lib/tallyInvoice.js).
export function tallyFigures(inv) {
  const m3 = r2(Number(inv.loaded_quantity_m3 || 0) - Number(inv.rejected_quantity_m3 || 0));
  const lines = [];
  if (Number(inv.concrete_amount) > 0) {
    const rateIncl = Number(inv.rate_per_m3) || (m3 ? Number(inv.concrete_amount) / m3 : 0);
    const rate = r2(rateIncl / 1.18);
    lines.push({ key: "sales", name: `${String(inv.grade_name || "").toUpperCase()} GRADE CONCRETE`, qty: m3, rate, rateIncl: r2(rateIncl), amount: r2(m3 * rate) });
  }
  for (const [k, ledger, label] of [["pumping_charge", "pump", "PUMP CHARGES"], ["part_load_charge", "part_load", "PART LOAD CHARGES"], ["waiting_charge", "waiting", "WAITING CHARGES"]]) {
    if (Number(inv[k]) > 0) lines.push({ key: ledger, name: label, qty: null, rate: null, amount: r2(Number(inv[k]) / 1.18) });
  }
  const taxable = r2(lines.reduce((t, l) => t + l.amount, 0));
  const cgst = r2(taxable * 0.09), sgst = r2(taxable * 0.09);
  const exact = r2(taxable + cgst + sgst);
  const total = Math.round(exact);
  return { lines, m3, taxable, cgst, sgst, roundoff: r2(total - exact), total, tax: r2(cgst + sgst) };
}

// The ledger lines of the voucher. `amount` > 0 is a credit, < 0 a debit
// (Tally's own sign: debits are negative in XML).
export function voucherEntries(inv, settings) {
  const L = ledgerNames(settings);
  const f = tallyFigures(inv);
  const party = settings?.party_mode === "customer" ? String(inv.billing_name || inv.customer_name || "").trim() : L.party;
  const out = [{ role: "party", ledger: party, amount: -f.total }];
  const byLedger = new Map();
  for (const l of f.lines) byLedger.set(l.key, r2((byLedger.get(l.key) || 0) + l.amount));
  for (const [k, a] of byLedger) out.push({ role: k, ledger: L[k], amount: a });
  if (f.cgst) out.push({ role: "cgst", ledger: L.cgst, amount: f.cgst });
  if (f.sgst) out.push({ role: "sgst", ledger: L.sgst, amount: f.sgst });
  if (f.roundoff) out.push({ role: "round_off", ledger: L.round_off, amount: f.roundoff });
  return { entries: out, figures: f, party };
}

// ---- XML text ------------------------------------------------------------
export function x(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    .replace(/[^\x20-\x7E\n\t]/g, (c) => `&#${c.codePointAt(0)};`);
}
const ymd = (iso) => String(iso || "").slice(0, 10).replace(/-/g, "");
const amt = (n) => r2(n).toFixed(2);

export function fyOf(iso) {
  const [y, m] = String(iso).slice(0, 10).split("-").map(Number);
  const s = m >= 4 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, "0")}`;
}
function fyRange(iso) {
  const s = Number(fyOf(iso).slice(0, 4));
  return { from: `${s}0401`, to: `${s + 1}0331` };
}

export function narration(inv) {
  const f = tallyFigures(inv);
  const concrete = f.lines.find((l) => l.key === "sales");
  return [
    `DN ${inv.ticket_number || ""}`.trim(),
    inv.site_name,
    concrete ? `${inv.grade_name || ""} ${f.m3} m3 @ ${concrete.rateIncl.toFixed(2)}`.trim() : null,
    inv.truck_number,
    "from OORM app",
  ].filter(Boolean).join(" | ");
}

// One VOUCHER element.
function voucherElement(inv, settings, { voucherNo, date }) {
  const vt = settings.voucher_type || "Sales B2C";
  const { entries, party } = voucherEntries(inv, settings);
  const d = ymd(date);
  const lines = entries.map((e) =>
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${x(e.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${e.amount < 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE><ISPARTYLEDGER>${e.role === "party" ? "Yes" : "No"}</ISPARTYLEDGER><AMOUNT>${amt(e.amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join("");
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${x(vt)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`
    + `<DATE>${d}</DATE><EFFECTIVEDATE>${d}</EFFECTIVEDATE><VOUCHERTYPENAME>${x(vt)}</VOUCHERTYPENAME>`
    + `<VOUCHERNUMBER>${x(voucherNo)}</VOUCHERNUMBER><PARTYLEDGERNAME>${x(party)}</PARTYLEDGERNAME>`
    + `<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE>`
    + `<NARRATION>${x(narration(inv))}</NARRATION>${lines}</VOUCHER></TALLYMESSAGE>`;
}

function importEnvelope(settings, body) {
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>`
    + `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${x(settings.company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>`
    + `<REQUESTDATA>${body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

// Create one voucher (what Post to Tally sends).
export function voucherXml(inv, settings, opts) {
  return importEnvelope(settings, voucherElement(inv, settings, opts));
}
// Several, for importing by hand (Tally › Import › Transactions).
export function vouchersXml(list, settings) {
  return importEnvelope(settings, list.map(({ inv, voucherNo, date }) => voucherElement(inv, settings, { voucherNo, date })).join(""));
}

// Is this voucher number already used in Tally for this voucher type, in the
// voucher's financial year? Tally allows the same number twice unless the
// voucher type forbids it, so the app asks first.
export function existsXml(settings, voucherNo, date) {
  const { from, to } = fyRange(date);
  const vt = settings.voucher_type || "Sales B2C";
  const f = `$VoucherNumber = "${String(voucherNo).replace(/"/g, "")}" AND $VoucherTypeName = "${String(vt).replace(/"/g, "")}"`;
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>OORMVoucherNo</ID></HEADER>`
    + `<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${x(settings.company)}</SVCURRENTCOMPANY><SVFROMDATE>${from}</SVFROMDATE><SVTODATE>${to}</SVTODATE><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>`
    + `<TDL><TDLMESSAGE><COLLECTION NAME="OORMVoucherNo" ISMODIFY="No"><TYPE>Voucher</TYPE><FETCH>VoucherNumber, VoucherTypeName, Date</FETCH><FILTER>OORMSameNo</FILTER></COLLECTION>`
    + `<SYSTEM TYPE="Formulae" NAME="OORMSameNo">${x(f)}</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

// Every ledger of the company — to check the names in Settings (and that the
// company is open).
export function ledgersXml(settings) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>OORMLedgers</ID></HEADER>`
    + `<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${x(settings.company)}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>`
    + `<TDL><TDLMESSAGE><COLLECTION NAME="OORMLedgers" ISMODIFY="No"><TYPE>Ledger</TYPE><FETCH>Name</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

// ---- Reading Tally's answers ---------------------------------------------
function unx(s) {
  return String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function tag(text, name) {
  const m = new RegExp(`<${name}>\\s*(-?\\d+)\\s*</${name}>`, "i").exec(text);
  return m ? Number(m[1]) : null;
}
function lineErrors(text) {
  return [...String(text).matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)].map((m) => unx(m[1]).trim()).filter(Boolean);
}
// Tally's own words, made plain where we know them.
export function explain(msg, settings) {
  const s = String(msg || "");
  if (/SVCurrentCompany/i.test(s) || /company.*(not|isn't).*(open|loaded)/i.test(s)) {
    return `Company "${settings?.company || ""}" is not open in Tally — open it in Tally, then try again. (Tally: ${s})`;
  }
  const led = /Ledger\s+'([^']+)'\s+does not exist/i.exec(s);
  if (led) return `Ledger "${led[1]}" is not in Tally — create it in Tally or correct the name in Tally settings. (Tally: ${s})`;
  const vt = /Voucher\s*type\s+'([^']+)'\s+does not exist/i.exec(s);
  if (vt) return `Voucher type "${vt[1]}" is not in Tally — create it or correct the name in Tally settings. (Tally: ${s})`;
  return s;
}

const snippet = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 200);

// The answer to an Import (voucher create).
export function readImport(text, settings) {
  const errs = lineErrors(text);
  const created = tag(text, "CREATED");
  const errors = tag(text, "ERRORS");
  const exceptions = tag(text, "EXCEPTIONS");
  if (created != null && created > 0 && !errors && !exceptions && !errs.length) return { ok: true, vchId: tag(text, "LASTVCHID") };
  if (errs.length) return { ok: false, error: explain(errs.join(" "), settings) };
  if (created === 0 && (errors || exceptions)) return { ok: false, error: `Tally refused the voucher (errors ${errors || 0}, exceptions ${exceptions || 0}) without saying why — open the voucher type in Tally and check it.` };
  if (tag(text, "ALTERED") > 0) return { ok: false, error: "Tally changed an existing voucher instead of creating one — check the voucher in Tally." };
  return { ok: false, error: `Tally's answer was not understood: ${snippet(text) || "empty"}` };
}

// The answer to "is this number used?".
export function readExists(text, settings) {
  const errs = lineErrors(text);
  if (errs.length) return { error: explain(errs.join(" "), settings) };
  if (!/<ENVELOPE|<COLLECTION|<RESPONSE/i.test(text || "")) return { error: `Tally's answer was not understood: ${snippet(text) || "empty"}` };
  return { exists: /<VOUCHER[\s>]/i.test(text) };
}

// The answer to "which ledgers are there?".
export function readLedgers(text, settings) {
  const errs = lineErrors(text);
  if (errs.length) return { error: explain(errs.join(" "), settings) };
  const names = new Set();
  // <LEDGER NAME="Cash" RESERVEDNAME=""> — the NAME attribute, not RESERVEDNAME.
  for (const m of String(text).matchAll(/<LEDGER\b[^>]*?\sNAME="([^"]*)"/gi)) { const n = unx(m[1]).trim(); if (n) names.add(n); }
  if (!names.size) {
    if (!/<ENVELOPE|<COLLECTION/i.test(text || "")) return { error: `Tally's answer was not understood: ${snippet(text) || "empty"}` };
    return { error: `No ledgers came back for company "${settings?.company || ""}" — is the company name exactly as in Tally, and is it open?` };
  }
  return { names: [...names] };
}

// ---- The Tally Bridge ------------------------------------------------------
// One .bat file for the Tally computer. Double-click it (Windows may ask
// "Run anyway" the first time) and leave the window open. It is a batch file
// with a PowerShell script inside — PowerShell comes with Windows, nothing to
// install. Every 5 seconds it asks the app for work, sends each request to
// Tally on this computer and hands Tally's reply back. It holds no rules of
// its own; making a new file (Tally settings) stops the old one working.
export function bridgeBat({ apiBase, token, tallyPort = 9000 }) {
  const ps = `
$ErrorActionPreference = 'Stop'
$App = '${String(apiBase).replace(/'/g, "")}/tally-bridge'
$Token = '${String(token).replace(/'/g, "")}'
$Tally = 'http://localhost:${Number(tallyPort) || 9000}'
$H = @{ 'X-Bridge-Token' = $Token }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$Host.UI.RawUI.WindowTitle = 'OORM Tally Bridge'
Write-Host 'Our Own Ready Mix - Tally Bridge'
Write-Host 'Keep this window open while posting invoices to Tally. Close it to stop.'
Write-Host ''
$last = ''
while ($true) {
  try {
    $alive = 'yes'
    try { $null = Invoke-WebRequest -Uri $Tally -Method Get -UseBasicParsing -TimeoutSec 5 }
    catch { if ($_.Exception.Response -eq $null) { $alive = 'no' } }
    $pc = [Uri]::EscapeDataString($env:COMPUTERNAME)
    $work = Invoke-RestMethod -Uri "$App/work?tally=$alive&pc=$pc" -Headers $H -Method Get -TimeoutSec 30
    $msg = if ($alive -eq 'yes') { 'Connected to the app and to Tally.' } else { 'Connected to the app. Tally is not open (or its port is off).' }
    if ($msg -ne $last) { Write-Host (Get-Date -Format 'HH:mm:ss') $msg; $last = $msg }
    foreach ($job in @($work.jobs)) {
      if ($job -eq $null) { continue }
      $res = @{ id = $job.id }
      try {
        $r = Invoke-WebRequest -Uri $Tally -Method Post -Body ([Text.Encoding]::UTF8.GetBytes([string]$job.xml)) -ContentType 'text/xml; charset=utf-8' -UseBasicParsing -TimeoutSec 60
        $res.response = [string]$r.Content
      } catch { $res.error = [string]$_.Exception.Message }
      $json = $res | ConvertTo-Json -Compress
      $null = Invoke-RestMethod -Uri "$App/result" -Headers $H -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
      Write-Host (Get-Date -Format 'HH:mm:ss') ([string]$job.label)
    }
  } catch {
    $m = 'Cannot reach the app: ' + $_.Exception.Message
    if ($m -ne $last) { Write-Host (Get-Date -Format 'HH:mm:ss') $m; $last = $m }
  }
  Start-Sleep -Seconds 5
}
`.trim();
  // Batch on top, PowerShell below the second marker. The batch line reads
  // this same file and runs the part after it; "exit /b" keeps cmd from
  // reading on.
  return [
    "@echo off",
    "title OORM Tally Bridge",
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((Get-Content -LiteralPath '%~f0' -Raw) -split '#OORM-PS#')[2]"`,
    "pause",
    "exit /b",
    "#OORM-PS#",
    ps,
    "",
  ].join("\r\n");
}
