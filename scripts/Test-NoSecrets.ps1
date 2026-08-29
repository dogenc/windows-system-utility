[CmdletBinding()]
param(
    [switch]$Staged
)

$ErrorActionPreference = 'Stop'

function Test-BlockedPath {
    param([string]$Path)

    $normalized = $Path.Replace('\', '/')
    if ($normalized -match '(?i)(^|/)\.env(?:$|\.)' -and
        $normalized -notmatch '(?i)\.env\.(example|sample|template)$') { return $true }

    return $normalized -match '(?i)(^|/)(api_keys|web_config)\.json$' -or
        $normalized -match '(?i)(^|/)certs?/' -or
        $normalized -match '(?i)\.(key|pem|p12|pfx)$'
}

$secretPatterns = @(
    [pscustomobject]@{ Id = 'google-api-key'; Pattern = 'AIza[0-9A-Za-z_-]{20,}' },
    [pscustomobject]@{ Id = 'github-token'; Pattern = 'gh[pousr]_[A-Za-z0-9_]{20,}' },
    [pscustomobject]@{ Id = 'github-pat'; Pattern = 'github_pat_[A-Za-z0-9_]{20,}' },
    [pscustomobject]@{ Id = 'openai-key'; Pattern = 'sk-[A-Za-z0-9_-]{20,}' },
    [pscustomobject]@{ Id = 'aws-key'; Pattern = 'AKIA[0-9A-Z]{16}' },
    [pscustomobject]@{ Id = 'private-key'; Pattern = '[-][-][-][-][-]BEGIN( [A-Z]+)* PRIVATE KEY[-][-][-][-][-]' }
)

$trackedFiles = @(git ls-files)
$violations = [System.Collections.Generic.List[string]]::new()
$allowlist = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)

if (Test-Path -LiteralPath '.secret-scan-allowlist') {
    foreach ($line in Get-Content -LiteralPath '.secret-scan-allowlist') {
        $entry = $line.Trim()
        if ($entry -and -not $entry.StartsWith('#')) { [void]$allowlist.Add($entry) }
    }
}

foreach ($file in $trackedFiles) {
    if (Test-BlockedPath -Path $file) {
        $violations.Add("Forbidden private file path: $file")
    }
}

# Git classifies binary blobs itself. Text files, including extensionless files
# and dotfiles, are searched directly from the index rather than from disk.
foreach ($rule in $secretPatterns) {
    $matches = @(git grep --cached -I -i -l -E -e $rule.Pattern 2>$null)
    if ($LASTEXITCODE -gt 1) {
        throw "Git could not scan the index (exit code $LASTEXITCODE)."
    }
    foreach ($match in $matches) {
        if (-not $allowlist.Contains("$($rule.Id)|$match")) {
            $violations.Add("Potential secret in: $match")
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Error ("Secret scan failed:`n - " + ($violations -join "`n - "))
    exit 1
}

Write-Host "Secret scan passed for $($trackedFiles.Count) tracked files."
exit 0
