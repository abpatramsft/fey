#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'fey-hook.js'
& node $script agentStop
exit $LASTEXITCODE
