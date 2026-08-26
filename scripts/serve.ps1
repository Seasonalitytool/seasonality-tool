<#
  serve.ps1 - tiny static file server for the public/ folder, plus a
  same-origin JSON API used to fetch additional tickers the user searches
  for and adds at runtime.

  Why an API at all: browsers block direct fetch() calls from a webpage to
  Yahoo Finance's chart endpoint (no CORS headers on their side), which is
  why the S&P 500 data is normally fetched server-side by update-data.ps1.
  Running the app through this server gives the page a same-origin route
  (/api/history) that does that same server-side fetch on demand for
  whatever symbol the user picks, sidestepping the browser's CORS block.
  Opening index.html directly (file://) still works fine for the default
  S&P 500 view — it just can't add extra tickers without this server running.

  Usage: powershell -File scripts/serve.ps1 -Port 8080
#>
param([int]$Port = 8080)

$root = Join-Path (Split-Path -Parent $PSScriptRoot) "public"
$prefix = "http://localhost:$Port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "Serving $root at $prefix (Ctrl+C to stop)"

$mime = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".ico"  = "image/x-icon"
}

$headers = @{ "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" }
$refYear = 2024
$refDays = New-Object System.Collections.Generic.List[object]
$rd0 = Get-Date -Year $refYear -Month 1 -Day 1
$rdEnd = Get-Date -Year $refYear -Month 12 -Day 31
while ($rd0 -le $rdEnd) {
    $refDays.Add([PSCustomObject]@{ Month = $rd0.Month; Day = $rd0.Day; Key = $rd0.ToString("MM-dd") })
    $rd0 = $rd0.AddDays(1)
}

# Fetches full history for one symbol from Yahoo Finance and shapes it into
# the same per-year seasonal structure used by public/data.js. Mirrors the
# logic in update-data.ps1 — keep the two in sync if either changes.
function Get-SeasonalHistory {
    param([string]$Symbol)

    $encoded = [uri]::EscapeDataString($Symbol)
    $period1 = -2208988800
    $url = "https://query1.finance.yahoo.com/v8/finance/chart/$encoded`?period1=$period1&period2=9999999999&interval=1d&events=history"
    $resp = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 30
    $result = $resp.chart.result[0]
    if (-not $result -or -not $result.timestamp -or $result.timestamp.Count -eq 0) {
        throw "No data returned for symbol '$Symbol'."
    }

    $tz = [System.TimeZoneInfo]::FindSystemTimeZoneById("Eastern Standard Time")
    $closes = $result.indicators.quote[0].close
    $byDate = @{}
    for ($i = 0; $i -lt $result.timestamp.Count; $i++) {
        $c = $closes[$i]
        if ($null -eq $c) { continue }
        $utc = [DateTimeOffset]::FromUnixTimeSeconds([int64]$result.timestamp[$i]).UtcDateTime
        $local = [System.TimeZoneInfo]::ConvertTimeFromUtc($utc, $tz)
        $byDate[$local.Date] = [double]$c
    }
    $sortedDates = $byDate.Keys | Sort-Object
    if ($sortedDates.Count -eq 0) { throw "No usable daily closes for symbol '$Symbol'." }

    $byYear = @{}
    foreach ($d in $sortedDates) {
        $y = $d.Year
        if (-not $byYear.ContainsKey($y)) { $byYear[$y] = New-Object System.Collections.Generic.List[object] }
        $byYear[$y].Add($d)
    }

    $lastFullDataDate = $sortedDates[-1]
    $currentYear = $lastFullDataDate.Year
    $fullYears = @(($byYear.Keys | Sort-Object) | Where-Object { $_ -lt $currentYear })
    if ($fullYears.Count -eq 0) { throw "Not enough full-year history for symbol '$Symbol'." }

    $bullCount = 0
    $bearCount = 0
    $yearsOut = New-Object System.Collections.Generic.List[object]
    foreach ($y in $fullYears) {
        $daysInYear = $byYear[$y]
        $tradingClose = @{}
        foreach ($td in $daysInYear) { $tradingClose[$td.ToString("MM-dd")] = $byDate[$td] }
        $baseline = $byDate[$daysInYear[0]]
        if (-not $baseline -or $baseline -eq 0) { continue }
        $lastClose = $byDate[$daysInYear[-1]]
        $type = if ($lastClose -gt $baseline) { "bull" } else { "bear" }
        if ($type -eq "bull") { $bullCount++ } else { $bearCount++ }

        $isLeap = [DateTime]::IsLeapYear($y)
        $lastVal = 0.0
        $values = New-Object System.Collections.Generic.List[object]
        foreach ($rd in $refDays) {
            $key = $rd.Key
            if ($key -eq "02-29" -and -not $isLeap) { $values.Add($null); continue }
            if ($tradingClose.ContainsKey($key)) { $lastVal = (($tradingClose[$key] / $baseline) - 1.0) * 100.0 }
            $values.Add([Math]::Round($lastVal, 4))
        }
        $yearsOut.Add([PSCustomObject]@{ year = [int]$y; type = $type; values = $values })
    }

    [PSCustomObject]@{
        symbol = $Symbol.ToUpper()
        years  = $yearsOut
        meta   = [PSCustomObject]@{
            startYear    = [int]$fullYears[0]
            endYear      = [int]$fullYears[-1]
            yearsUsed    = $yearsOut.Count
            bullYears    = $bullCount
            bearYears    = $bearCount
            lastDataDate = $lastFullDataDate.ToString("yyyy-MM-dd")
        }
    }
}

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $req = $context.Request
    $res = $context.Response
    try {
        $path = $req.Url.AbsolutePath

        if ($path -eq "/api/history") {
            $sym = $req.QueryString["symbol"]
            $res.ContentType = "application/json; charset=utf-8"
            if (-not $sym -or $sym.Trim() -eq "") {
                $res.StatusCode = 400
                $body = [Text.Encoding]::UTF8.GetBytes('{"error":"missing symbol"}')
            } else {
                try {
                    $data = Get-SeasonalHistory -Symbol $sym.Trim()
                    $json = $data | ConvertTo-Json -Depth 6 -Compress
                    $body = [Text.Encoding]::UTF8.GetBytes($json)
                } catch {
                    $res.StatusCode = 502
                    $errMsg = ($_.Exception.Message -replace '"', "'")
                    $body = [Text.Encoding]::UTF8.GetBytes("{`"error`":`"$errMsg`"}")
                }
            }
            $res.ContentLength64 = $body.Length
            $res.OutputStream.Write($body, 0, $body.Length)
            $res.OutputStream.Close()
            continue
        }

        if ($path -eq "/") { $path = "/index.html" }
        $filePath = Join-Path $root ($path.TrimStart("/"))

        if (-not (Test-Path $filePath -PathType Leaf)) {
            $res.StatusCode = 404
            $body = [Text.Encoding]::UTF8.GetBytes("404 Not Found: $path")
            $res.ContentLength64 = $body.Length
            $res.OutputStream.Write($body, 0, $body.Length)
            $res.OutputStream.Close()
            continue
        }

        $ext = [IO.Path]::GetExtension($filePath).ToLower()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
        $bytes = [IO.File]::ReadAllBytes($filePath)
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
        $res.OutputStream.Close()
    } catch {
        try {
            $res.StatusCode = 500
            $res.OutputStream.Close()
        } catch {}
    }
}
