param(
    [switch]$ChecksOnly,
    [string]$DshSource,
    [string]$PiAiSource
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$setupArgs = @()
if ($ChecksOnly) { $setupArgs += "--checks-only" }
if ($DshSource) { $setupArgs += @("--dsh-source", $DshSource) }
if ($PiAiSource) { $setupArgs += @("--pi-ai-source", $PiAiSource) }
& npm.cmd exec -- node scripts/setup.mjs @setupArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
