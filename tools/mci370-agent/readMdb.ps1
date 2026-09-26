# Round 157 — read an MS Access .mdb and print the rows as JSON.
#
# THIS SCRIPT MUST RUN IN 32-BIT POWERSHELL, and that is the entire point of it.
#
# MCI370's database is a Jet 4.0 .mdb. The `Microsoft.Jet.OLEDB.4.0` provider
# that reads it ships with Windows itself — but only as 32-bit. The 64-bit
# PowerShell that opens by default has no such provider, so the usual advice is
# to install Microsoft's Access Database Engine redistributable.
#
# We deliberately do NOT do that. This runs on a plant control PC that is
# batching concrete; installing a database engine onto it, on a machine whose
# vendor software is a VB6 program from 2004, is a risk with no upside. Running
# the 32-bit PowerShell that is already on every Windows machine needs nothing
# installed at all:
#
#   C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe
#
# agent.js always invokes that path explicitly. If you run this file from an
# ordinary prompt it will fail with "provider is not registered", and that is
# the symptom of running it 64-bit rather than anything being wrong.
#
# READ-ONLY, ALWAYS. Mode=Read is set on the connection, and agent.js copies the
# file before calling this so the live database is never even opened by us.

param(
  [Parameter(Mandatory = $true)][string]$MdbPath,
  [Parameter(Mandatory = $true)][string]$Sql,
  # Round 157 follow-up — MCI370's live database is protected with a Jet
  # database password. It is the plant's own credential, held by MCI370 and
  # supplied here from config.json's dbPassword; empty means an unprotected
  # database, which is how the installer template and the vendor's sample copy
  # both open. This is a credential the operator provides, not one we recover.
  [string]$DbPassword = ""
)

$ErrorActionPreference = "Stop"

try {
  if (-not (Test-Path -LiteralPath $MdbPath)) {
    Write-Output (@{ error = "Database not found at $MdbPath" } | ConvertTo-Json -Compress)
    exit 0
  }

  $conn = New-Object -ComObject ADODB.Connection
  # Mode 1 = adModeRead. Jet also wants to create a .ldb lock file beside the
  # database; on a copy that is harmless, and read-only mode means we never
  # take a write lock even if pointed at the original.
  $conn.Mode = 1
  # A Jet database password rides in the connection string as Jet OLEDB:Database
  # Password. Left blank the clause is harmless, so the same code opens a
  # protected and an unprotected database.
  $connStr = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=$MdbPath;"
  if ($DbPassword -ne "") {
    $connStr += "Jet OLEDB:Database Password=$DbPassword;"
  }
  $conn.Open($connStr)

  $rs = New-Object -ComObject ADODB.Recordset
  # 3 = adOpenStatic, 1 = adLockReadOnly.
  $rs.Open($Sql, $conn, 3, 1)

  $rows = New-Object System.Collections.ArrayList
  if (-not ($rs.BOF -and $rs.EOF)) {
    $rs.MoveFirst()
    while (-not $rs.EOF) {
      $row = @{}
      foreach ($f in $rs.Fields) {
        $v = $f.Value
        if ($v -eq $null -or $v -is [System.DBNull]) {
          $row[$f.Name] = $null
        } elseif ($v -is [datetime]) {
          # Plant-local time, written by MCI370 with no zone. Stamped +05:30
          # explicitly rather than left for whatever the receiving process
          # assumes — this app's single most recurring bug class.
          $row[$f.Name] = $v.ToString("yyyy-MM-ddTHH:mm:ss") + "+05:30"
        } else {
          $row[$f.Name] = $v
        }
      }
      [void]$rows.Add($row)
      $rs.MoveNext()
    }
  }

  $rs.Close()
  $conn.Close()

  # -Depth matters: the default of 2 silently truncates nested structures.
  # -Compress keeps a few hundred rows inside a sane stdout buffer.
  Write-Output (@{ rows = $rows } | ConvertTo-Json -Depth 6 -Compress)
}
catch {
  Write-Output (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)
  exit 0
}
