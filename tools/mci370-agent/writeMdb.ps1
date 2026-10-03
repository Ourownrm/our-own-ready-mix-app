# Round 174 - write ONE recipe row back into MCI370's Recipe_Master.
#
# THIS SCRIPT MUST RUN IN 32-BIT POWERSHELL, same reason as readMdb.ps1: the
# Microsoft.Jet.OLEDB.4.0 provider that opens MCI370's Jet 4.0 .mdb ships with
# Windows only as 32-bit. agent.js invokes
#   C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe
# explicitly.
#
# SAFETY - this script can only ever UPDATE Recipe_Master:
#   * the table name is hard-coded here, never taken from input;
#   * every value is bound as an ADODB parameter, so a recipe name with a quote
#     cannot change the statement;
#   * it writes the LIVE database (not a copy), so agent.js must point it at the
#     real file and must NOT also hold a read copy open in write mode. The write
#     targets exactly one row, matched on Recipe_Code.
#
# The change to apply is read from a JSON file (-PayloadPath), not the command
# line, to avoid quoting problems. Shape:
#   { "where_recipe_code": "M30 B",
#     "rename_to": null | "NEWCODE",
#     "set": { "Cement1_Target": 250, "Recipe_Name": "M30B", ... } }
#
# Prints {"ok":true,"affected":N} or {"error":"..."} and always exits 0 so the
# agent reads the JSON rather than a non-zero exit.

param(
  [Parameter(Mandatory = $true)][string]$MdbPath,
  [Parameter(Mandatory = $true)][string]$PayloadPath,
  [string]$DbPassword = ""
)

$ErrorActionPreference = "Stop"

try {
  if (-not (Test-Path -LiteralPath $MdbPath)) {
    Write-Output (@{ error = "Database not found at $MdbPath" } | ConvertTo-Json -Compress); exit 0
  }
  if (-not (Test-Path -LiteralPath $PayloadPath)) {
    Write-Output (@{ error = "Payload not found at $PayloadPath" } | ConvertTo-Json -Compress); exit 0
  }

  $payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json
  $whereCode = [string]$payload.where_recipe_code
  if ([string]::IsNullOrEmpty($whereCode)) {
    Write-Output (@{ error = "payload.where_recipe_code is required" } | ConvertTo-Json -Compress); exit 0
  }

  # Build the SET list and the parameter list in the SAME order as the "?"s.
  $setCols = @()
  $params  = New-Object System.Collections.ArrayList   # each: @{ value=..; isText=$bool }
  foreach ($prop in $payload.set.PSObject.Properties) {
    $setCols += "[" + $prop.Name + "] = ?"
    $v = $prop.Value
    $isText = ($v -is [string])
    [void]$params.Add(@{ value = $v; isText = $isText })
  }
  if ($setCols.Count -eq 0) {
    Write-Output (@{ error = "payload.set is empty - nothing to write" } | ConvertTo-Json -Compress); exit 0
  }
  # Optional rename: change the key itself, still matching on the old code.
  if ($payload.rename_to -and [string]$payload.rename_to -ne "") {
    $setCols += "[Recipe_Code] = ?"
    [void]$params.Add(@{ value = [string]$payload.rename_to; isText = $true })
  }
  # WHERE parameter is bound last.
  [void]$params.Add(@{ value = $whereCode; isText = $true })

  $sql = "UPDATE Recipe_Master SET " + ($setCols -join ", ") + " WHERE [Recipe_Code] = ?"

  $conn = New-Object -ComObject ADODB.Connection
  $conn.Mode = 3   # adModeReadWrite
  $connStr = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=$MdbPath;"
  if ($DbPassword -ne "") { $connStr += "Jet OLEDB:Database Password=$DbPassword;" }
  $conn.Open($connStr)

  $cmd = New-Object -ComObject ADODB.Command
  $cmd.ActiveConnection = $conn
  $cmd.CommandText = $sql
  # adParamInput = 1; adDouble = 5; adVarWChar = 202; adBoolean = 11.
  $n = 0
  foreach ($p in $params) {
    $n++
    if ($p.isText) {
      $s = [string]$p.value
      $size = [Math]::Max(255, $s.Length)
      $par = $cmd.CreateParameter("p$n", 202, 1, $size, $s)
    } else {
      # Numbers (targets, percentages, times) go in as doubles.
      $par = $cmd.CreateParameter("p$n", 5, 1, 0, [double]$p.value)
    }
    $cmd.Parameters.Append($par)
  }

  $affected = 0
  $cmd.Execute([ref]$affected) | Out-Null
  $conn.Close()

  Write-Output (@{ ok = $true; affected = [int]$affected } | ConvertTo-Json -Compress)
}
catch {
  Write-Output (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)
  exit 0
}
