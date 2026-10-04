# ROUND 161 - MixTrack print agent, the part that talks to Excel.
#
# Writes the Mix Design sheet and the Load sheet of a COPY of BPR107a.xlsm,
# then calls the workbook's own PrintOrderandAsPDF macro.
#
# WHY A COPY AND NOT THE MASTER. The master is the plant's own file and people
# open it. Filling a copy means a print can never collide with somebody editing
# it, a failed print leaves no half-written master behind, and the values from
# the last load are never left sitting in the master's cells.
#
# WHY THE WORKBOOK'S OWN MACRO. PrintOrderandAsPDF already exists in the file:
# it prints the sheet, builds the PDF name from the cell values and exports it.
# Reimplementing that would mean reproducing a layout we do not own. We fill
# cells and let the vendor's code do its job.
#
# Every number is written as a NUMBER and every string as a string. Handing
# Excel a numeric string puts text in the cell, and the workbook's arithmetic
# then silently treats it as zero - the ticket prints a target of 0 kg.
#
# agent 1.1.0 (Round 188) - READ-BACK. After recalculating, calculation is
# frozen (manual, and no recalculation on save) and the cells the app asked for
# are read off the sheet that is about to print. Then the macro prints. With
# calculation frozen, the RAND()-based "actual" weights cannot change between
# the read and the print, so what the app stores is exactly what is on paper.

param(
  [Parameter(Mandatory=$true)][string]$JobFile,      # the job JSON the agent wrote
  [Parameter(Mandatory=$true)][string]$Template,     # master BPR107a.xlsm
  [Parameter(Mandatory=$true)][string]$WorkDir,      # where the working copy goes
  [Parameter(Mandatory=$true)][string]$PdfFolder     # where the PDF is filed
)

$ErrorActionPreference = "Stop"
$excel = $null
$book  = $null
$step  = "starting"   # agent 1.0.2 - reported with any error, so a failure names its step

function Set-Cell($sheet, $addr, $value) {
  # agent 1.0.2 - every argument handed to Excel is a plain .NET type. Values
  # read from ConvertFrom-Json can arrive wrapped in a PSObject, and COM rejects
  # those with "Specified cast is not valid".
  $a = [string]$addr
  $script:step = "writing cell $($sheet.Name)!$a"
  $rng = $sheet.Range($a)
  if ($null -eq $value -or "$value" -eq "") { [void]$rng.ClearContents(); return }
  $d = 0.0
  $text = [string]$value
  # Invariant culture so "6.000" is six whatever the PC's regional settings.
  if ([double]::TryParse($text, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$d)) {
    $rng.Value2 = [double]$d
  } else {
    $rng.Value2 = $text
  }
}

function Read-Cell($sheet, $addr) {
  # What the ticket SHOWS (.Text, with the sheet's own number format). A column
  # too narrow for its number shows "####"; then the raw value is used instead.
  $rng = $sheet.Range([string]$addr)
  $t = [string]$rng.Text
  if ($t -match '^#+$') {
    $v = $rng.Value2
    if ($null -eq $v) { return "" }
    if ($v -is [double]) { return $v.ToString([System.Globalization.CultureInfo]::InvariantCulture) }
    return [string]$v
  }
  return $t.Trim()
}

try {
  $job = Get-Content -Raw -Encoding UTF8 $JobFile | ConvertFrom-Json

  if (-not (Test-Path $Template)) { throw "Template not found: $Template" }
  if (-not (Test-Path $WorkDir))  { New-Item -ItemType Directory -Path $WorkDir  -Force | Out-Null }
  if (-not (Test-Path $PdfFolder)){ New-Item -ItemType Directory -Path $PdfFolder -Force | Out-Null }

  $copy = Join-Path $WorkDir ("mixtrack-job-" + $job.id + ".xlsm")
  Copy-Item -LiteralPath $Template -Destination $copy -Force

  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.EnableEvents = $false # Workbook_Open must not fire

  $step = "opening the workbook copy"
  # agent 1.0.2 - path only. Passing $false for UpdateLinks (which Excel types
  # as a number) is a known source of "Specified cast is not valid".
  $book = $excel.Workbooks.Open([string]$copy)

  # Recalculation is turned off while ~700 cells are written and back on once,
  # which is the difference between a second and most of a minute.
  # FIX (agent 1.0.1): Excel refuses to change Calculation while NO workbook is
  # open (HRESULT 0x800A03EC), so this must come AFTER Workbooks.Open.
  try { $excel.Calculation = -4135 } catch { }   # xlCalculationManual
  $step = "finding the Load and Mix Design sheets"
  $load = $book.Worksheets.Item([string]"Load")
  $mix  = $book.Worksheets.Item([string]"Mix Design")

  # 1. The Mix Design sheet FIRST, because the Load sheet's row 46 looks up into it.
  foreach ($r in $job.payload_json.mix_design_rows) {
    foreach ($p in $r.cells.PSObject.Properties) {
      Set-Cell $mix ([string]$p.Name + [string]$r.row) $p.Value
    }
  }
  # Clear the rows below, so a recipe QC removed cannot be left behind for the
  # lookup to keep finding.
  foreach ($row in $job.payload_json.clear_rows) {
    $rr = [int]$row
    $step = "clearing Mix Design row $rr"
    [void]$mix.Range([string]("B" + $rr + ":X" + $rr)).ClearContents()
  }

  # 2. Where the PDF goes (a local path, not the workbook's mapped drive).
  $folderCell = $job.payload_json.save_folder_cell
  $step = "writing the PDF folder cell"
  $book.Worksheets.Item([string]$folderCell.sheet).Range([string]$folderCell.cell).Value2 = [string]$PdfFolder

  # 3. The Load sheet.
  foreach ($p in $job.payload_json.load_cells.PSObject.Properties) {
    Set-Cell $load ([string]$p.Name) $p.Value
  }
  $step = "recalculating"

  try { $excel.Calculation = -4105 } catch { }  # xlCalculationAutomatic
  $book.Application.CalculateFullRebuild()

  # Sanity check before anything is printed: I40 must agree with the sheet
  # number the app computed, or the wrong number of batch blocks would print.
  $step = "reading Load!I40"
  $i40raw = $load.Range([string]"I40").Value2
  $i40 = 0
  $dd = 0.0
  if ([double]::TryParse([string]$i40raw, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$dd)) { $i40 = [int][math]::Round($dd) }
  else { throw "Load!I40 does not hold a sheet number (it reads '$i40raw') - check Production Qty (AO29)." }
  if ($i40 -ne [int]$job.payload_json.sheet_number) {
    throw "Sheet mismatch: the workbook's I40 says $i40, the app says $($job.payload_json.sheet_number). Nothing printed."
  }

  # agent 1.1.0 - freeze the figures, then read them back. Manual calculation
  # alone is not enough: Excel recalculates on Save unless CalculateBeforeSave
  # is off, and that would re-roll every RAND() after the read.
  $readValues = $null
  $readSheet = $null
  if ($job.payload_json.readback) {
    $step = "freezing calculation for the read-back"
    try { $excel.Calculation = -4135 } catch { }
    try { $excel.CalculateBeforeSave = $false } catch { }
    $readSheet = [string]$job.payload_json.readback.sheet
    $ps = $book.Worksheets.Item($readSheet)
    $readValues = @{}
    foreach ($addr in $job.payload_json.readback.cells) {
      $a = [string]$addr
      $step = "reading back $readSheet!$a"
      $readValues[$a] = Read-Cell $ps $a
    }
  }

  $step = "saving the workbook copy"
  $book.Save()
  $step = "running the PrintOrderandAsPDF macro"
  [void]$excel.Run([string]"PrintOrderandAsPDF")
  $step = "finding the PDF"

  # The macro names the PDF itself from the cell values, so the agent finds it
  # rather than assuming a name: the newest PDF in the folder is the file.
  $pdf = Get-ChildItem -LiteralPath $PdfFolder -Filter *.pdf |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1

  $book.Close($false); $book = $null
  $excel.Quit(); $excel = $null

  # The read-back can be ~600 cells, so it goes to a file next to the job file
  # rather than through stdout, where a console-less host may wrap long lines.
  $readFile = $null
  if ($readValues) {
    $readFile = [System.IO.Path]::ChangeExtension($JobFile, ".readback.json")
    @{ sheet = $readSheet; values = $readValues } | ConvertTo-Json -Compress -Depth 4 |
      Set-Content -LiteralPath $readFile -Encoding UTF8
  }

  @{
    ok = $true
    sheet = $i40
    pdf_path = if ($pdf) { $pdf.FullName } else { $null }
    pdf_filename = if ($pdf) { $pdf.Name } else { $null }
    readback_file = $readFile
  } | ConvertTo-Json -Compress
}
catch {
  # agent 1.0.2 - say WHERE it failed, not just what .NET said.
  $where = "line " + $_.InvocationInfo.ScriptLineNumber
  @{ ok = $false; error = "While $step ($where): $($_.Exception.Message)" } | ConvertTo-Json -Compress
}
finally {
  # Excel left running headless is a real operational problem on a plant PC.
  if ($book)  { try { $book.Close($false)  | Out-Null } catch {} }
  if ($excel) { try { $excel.Quit()        | Out-Null } catch {} }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
