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

param(
  [Parameter(Mandatory=$true)][string]$JobFile,      # the job JSON the agent wrote
  [Parameter(Mandatory=$true)][string]$Template,     # master BPR107a.xlsm
  [Parameter(Mandatory=$true)][string]$WorkDir,      # where the working copy goes
  [Parameter(Mandatory=$true)][string]$PdfFolder     # where the PDF is filed
)

$ErrorActionPreference = "Stop"
$excel = $null
$book  = $null

function Set-Cell($sheet, $addr, $value) {
  if ($null -eq $value -or "$value" -eq "") { $sheet.Range($addr).ClearContents() | Out-Null; return }
  $d = 0.0
  # [ref] parse rather than a cast: a cast throws on 'KL14 AF 2789', and a
  # try/catch per cell across ~700 cells is measurably slower.
  if ([double]::TryParse("$value", [ref]$d)) { $sheet.Range($addr).Value2 = $d }
  else { $sheet.Range($addr).Value2 = "$value" }
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
  # Recalculation is turned off while ~700 cells are written and back on once,
  # which is the difference between a second and most of a minute. The workbook
  # is one big web of VLOOKUPs.
  $excel.Calculation = -4135   # xlCalculationManual
  $excel.EnableEvents = $false # Workbook_Open must not fire

  $book = $excel.Workbooks.Open($copy, $false, $false)
  $load = $book.Worksheets.Item("Load")
  $mix  = $book.Worksheets.Item("Mix Design")

  # 1. The Mix Design sheet FIRST, because the Load sheet's row 46 looks up
  #    into it. Order matters only for clarity here (calculation is manual),
  #    but writing them the other way round reads as though it might not.
  foreach ($r in $job.payload_json.mix_design_rows) {
    foreach ($p in $r.cells.PSObject.Properties) {
      Set-Cell $mix ($p.Name + $r.row) $p.Value
    }
  }
  # Clear the rows below, so a recipe QC removed cannot be left behind for the
  # lookup to keep finding.
  foreach ($row in $job.payload_json.clear_rows) {
    $mix.Range("B$row" + ":X$row").ClearContents() | Out-Null
  }

  # 2. Where the PDF goes. The workbook shipped with a mapped drive here, which
  #    is invisible to the account a scheduled agent runs under; the agent
  #    supplies a local path instead.
  $folderCell = $job.payload_json.save_folder_cell
  $book.Worksheets.Item($folderCell.sheet).Range($folderCell.cell).Value2 = $PdfFolder

  # 3. The Load sheet.
  foreach ($p in $job.payload_json.load_cells.PSObject.Properties) {
    Set-Cell $load $p.Name $p.Value
  }

  $excel.Calculation = -4105   # xlCalculationAutomatic
  $book.Application.CalculateFullRebuild()

  # Sanity check before anything is printed: I40 must agree with the sheet
  # number the app computed. If they disagree the app's arithmetic and the
  # workbook's formula have drifted, and the wrong sheet would print - which on
  # this ticket means the wrong NUMBER OF BATCH BLOCKS for the load.
  $i40 = [int]$load.Range("I40").Value2
  if ($i40 -ne [int]$job.payload_json.sheet_number) {
    throw "Sheet mismatch: the workbook's I40 says $i40, the app says $($job.payload_json.sheet_number). Nothing printed."
  }

  $book.Save()
  $excel.Run("PrintOrderandAsPDF") | Out-Null

  # The macro names the PDF itself from the cell values, so the agent finds it
  # rather than assuming a name: whatever appeared in the folder since this run
  # began is the file.
  $pdf = Get-ChildItem -LiteralPath $PdfFolder -Filter *.pdf |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1

  $book.Close($false); $book = $null
  $excel.Quit(); $excel = $null

  @{
    ok = $true
    sheet = $i40
    pdf_path = if ($pdf) { $pdf.FullName } else { $null }
    pdf_filename = if ($pdf) { $pdf.Name } else { $null }
  } | ConvertTo-Json -Compress
}
catch {
  @{ ok = $false; error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
}
finally {
  # Excel left running headless is a real operational problem on a plant PC -
  # the processes stack up invisibly until it runs out of memory.
  if ($book)  { try { $book.Close($false)  | Out-Null } catch {} }
  if ($excel) { try { $excel.Quit()        | Out-Null } catch {} }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
