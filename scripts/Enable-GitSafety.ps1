[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
git config core.hooksPath .githooks
Write-Host 'Git secret-scan hook enabled for this clone.'
