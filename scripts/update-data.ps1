<#
  update-data.ps1
  ----------------
  Downloads the full available daily S&P 500 (^GSPC) price history from
  Yahoo Finance's public chart endpoint, then prepares per-year seasonal
  series for the app to combine client-side:

    For every full historical calendar year available:
      1. Normalize that year's daily closes so the first trading day = 0%.
      2. Compute the daily cumulative % return through the year.
      3. Forward-fill non-trading days (weekends/holidays) so every year
         has a value for every calendar day (Jan 1 - Dec 31, incl. Feb 29
         for leap years; non-leap years carry `null` at Feb 29).
      4. Classify the year as "bull" if its last trading day's close is
         higher than its first trading day's close, otherwise "bear".

  The app itself averages whichever years match the active Bull/Bear/All
  filter, election-cycle filter, and year-range slider, day-by-day, and
  applies light smoothing — see public/app.js. This script only fetches and
  shapes the raw per-year data for the S&P 500; it does not pre-aggregate a
  composite. Any additional ticker a user searches for and adds at runtime
  is fetched the same way, on demand, via the /api/history route in
  scripts/serve.ps1 (kept in sync with the logic here).

  Output: public/data.js  (a plain JS file the app loads directly, no
  server-side fetch needed, no build step, works when opened via file://).

  Re-run this script any time to refresh the data with the latest prices:
      powershell -File scripts/update-data.ps1

  By default it uses every full year the source provides. Pass
  -LookbackYears N to cap it to the most recent N full years instead:
      powershell -File scripts/update-data.ps1 -LookbackYears 20
#>

param([int]$LookbackYears = 0)

$ErrorActionPreference = "Stop"

$root      = Split-Path -Parent $PSScriptRoot
$outFile   = Join-Path $root "public\data.js"
$symbol    = "%5EGSPC"      # ^GSPC = S&P 500 index
# period1 is pushed back to 1900 so Yahoo returns everything it has (it
# clamps to the instrument's actual first trade date automatically).
$period1   = -2208988800
$url       = "https://query1.finance.yahoo.com/v8/finance/chart/$symbol`?period1=$period1&period2=9999999999&interval=1d&events=history"

Write-Host "Fetching full S&P 500 daily history from Yahoo Finance..."
$headers = @{ "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" }
$resp = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 60
$result = $resp.chart.result[0]

$timestamps = $result.timestamp
$closes     = $result.indicators.quote[0].close

if (-not $timestamps -or $timestamps.Count -eq 0) {
    throw "No data returned from Yahoo Finance."
}

Write-Host "Received $($timestamps.Count) raw daily bars."

# Convert to US/Eastern trading dates (handles historical DST correctly).
$tz = [System.TimeZoneInfo]::FindSystemTimeZoneById("Eastern Standard Time")

$records = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $timestamps.Count; $i++) {
    $c = $closes[$i]
    if ($null -eq $c) { continue }
    $utc   = [DateTimeOffset]::FromUnixTimeSeconds([int64]$timestamps[$i]).UtcDateTime
    $local = [System.TimeZoneInfo]::ConvertTimeFromUtc($utc, $tz)
    $records.Add([PSCustomObject]@{ Date = $local.Date; Close = [double]$c })
}

# Sort & de-duplicate by date (keep last if a date repeats).
$byDate = @{}
foreach ($r in $records) { $byDate[$r.Date] = $r.Close }
$sortedDates = $byDate.Keys | Sort-Object
Write-Host "Usable trading days: $($sortedDates.Count) ($([datetime]($sortedDates[0]) | Get-Date -Format 'yyyy-MM-dd') to $([datetime]($sortedDates[-1]) | Get-Date -Format 'yyyy-MM-dd'))"

# Group trading days by calendar year.
$byYear = @{}
foreach ($d in $sortedDates) {
    $y = $d.Year
    if (-not $byYear.ContainsKey($y)) { $byYear[$y] = New-Object System.Collections.Generic.List[object] }
    $byYear[$y].Add($d)
}

$allYears = $byYear.Keys | Sort-Object
$lastFullDataDate = $sortedDates[-1]
$currentYear = $lastFullDataDate.Year

# Only use FULL calendar years (exclude the current, still-in-progress year).
$fullYears = @($allYears | Where-Object { $_ -lt $currentYear })

Write-Host "Full historical years available: $($fullYears.Count) ($($fullYears[0])-$($fullYears[-1]))"

# Optionally cap to the most recent N full years (0 = use everything).
if ($LookbackYears -gt 0 -and $fullYears.Count -gt $LookbackYears) {
    $fullYears = $fullYears | Select-Object -Last $LookbackYears
    Write-Host "Limiting to most recent $LookbackYears years: $($fullYears[0])-$($fullYears[-1])"
}

# Reference day list spanning a leap year so Feb 29 is included (Jan 1 - Dec 31).
$refYear = 2024
$refDays = New-Object System.Collections.Generic.List[object]
$d = Get-Date -Year $refYear -Month 1 -Day 1
$end = Get-Date -Year $refYear -Month 12 -Day 31
while ($d -le $end) {
    $refDays.Add([PSCustomObject]@{ Month = $d.Month; Day = $d.Day; Key = $d.ToString("MM-dd") })
    $d = $d.AddDays(1)
}
$refCount = $refDays.Count

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
    # Walk the canonical 366-slot reference day list (not this year's own
    # 365/366-day calendar) so every year's values array lines up 1:1 with
    # $days regardless of leap-year length.
    foreach ($rd in $refDays) {
        $key = $rd.Key
        if ($key -eq "02-29" -and -not $isLeap) {
            $values.Add($null)  # doesn't exist this year; excluded client-side
            continue
        }
        if ($tradingClose.ContainsKey($key)) {
            $lastVal = (($tradingClose[$key] / $baseline) - 1.0) * 100.0
        }
        $values.Add([Math]::Round($lastVal, 4))
    }

    $yearsOut.Add([PSCustomObject]@{
        year   = [int]$y
        type   = $type
        values = $values
    })
}

Write-Host "Bull years: $bullCount  Bear years: $bearCount"

# --- Current (in-progress) year, for the "overlay current year" toggle -----
# Unlike the historical years above, this one is NOT forward-filled all the
# way to Dec 31 — it stops (null) right after the most recent trading day,
# so the overlay line just ends at "today" instead of drawing a flat
# projection into the future.
$currentYearOut = $null
if ($byYear.ContainsKey($currentYear) -and $byYear[$currentYear].Count -gt 0) {
    $curDays = $byYear[$currentYear]
    $curTradingClose = @{}
    foreach ($td in $curDays) { $curTradingClose[$td.ToString("MM-dd")] = $byDate[$td] }
    $curBaseline = $byDate[$curDays[0]]
    $curIsLeap = [DateTime]::IsLeapYear($currentYear)
    $lastTradingDate = $curDays[-1]

    $curValues = New-Object System.Collections.Generic.List[object]
    $lastVal = 0.0
    foreach ($rd in $refDays) {
        $key = $rd.Key
        if ($key -eq "02-29" -and -not $curIsLeap) {
            $curValues.Add($null)
            continue
        }
        $thisDate = Get-Date -Year $currentYear -Month $rd.Month -Day $rd.Day
        if ($curTradingClose.ContainsKey($key)) {
            $lastVal = (($curTradingClose[$key] / $curBaseline) - 1.0) * 100.0
        }
        if ($thisDate -gt $lastTradingDate) {
            $curValues.Add($null)
        } else {
            $curValues.Add([Math]::Round($lastVal, 4))
        }
    }

    $currentYearOut = [PSCustomObject]@{
        year         = [int]$currentYear
        lastDataDate = $lastTradingDate.ToString("yyyy-MM-dd")
        values       = $curValues
    }
    Write-Host "Current year ($currentYear) tracked through $($lastTradingDate.ToString('yyyy-MM-dd'))"
}

# Canonical calendar day list (label/month/day only, shared by every year).
$days = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $refCount; $i++) {
    $rd = $refDays[$i]
    $label = (Get-Date -Year $refYear -Month $rd.Month -Day $rd.Day).ToString("MMM d")
    $days.Add([PSCustomObject]@{ month = $rd.Month; day = $rd.Day; label = $label })
}

# --- Emit public/data.js -----------------------------------------------
function ToJs($obj) { $obj | ConvertTo-Json -Depth 6 -Compress }

$meta = [PSCustomObject]@{
    symbol       = "^GSPC (S&P 500)"
    source       = "Yahoo Finance (query1.finance.yahoo.com)"
    generatedAt  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    startYear    = [int]$fullYears[0]
    endYear      = [int]$fullYears[-1]
    yearsUsed    = $fullYears.Count
    bullYears    = $bullCount
    bearYears    = $bearCount
    lastDataDate = $lastFullDataDate.ToString("yyyy-MM-dd")
}

$js = "// Auto-generated by scripts/update-data.ps1 - do not edit by hand.`n"
$js += "window.SEASONALITY_META = " + (ToJs $meta) + ";`n"
$js += "window.SEASONALITY_DAYS = " + (ToJs $days) + ";`n"
$js += "window.SEASONALITY_YEARS = " + (ToJs $yearsOut) + ";`n"
$js += "window.CURRENT_YEAR_DATA = " + (if ($currentYearOut) { ToJs $currentYearOut } else { "null" }) + ";`n"

Set-Content -Path $outFile -Value $js -Encoding UTF8
Write-Host "Wrote $outFile"
Write-Host "Years: $($fullYears.Count) ($($fullYears[0])-$($fullYears[-1])), last price date: $($lastFullDataDate.ToString('yyyy-MM-dd'))"
