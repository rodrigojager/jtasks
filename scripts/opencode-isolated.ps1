# Compatibility entrypoint: reuse the complete original OpenCode profile and service.
# Earlier releases isolated storage and hid native v2 credentials and preferences.
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)][string]$OpenCodeCommand,
    [Parameter(Mandatory)][string]$SourceConfigDir,
    [Parameter(Mandatory)][string]$ProfileConfigDir,
    [Parameter(Mandatory)][string]$JlockBin,
    [string]$BunCommand = 'bun',
    [switch]$Check,
    [Parameter(ValueFromRemainingArguments)][string[]]$OpenCodeArgs
)
$ErrorActionPreference = 'Stop'
# ProfileConfigDir and BunCommand remain accepted for existing wrapper compatibility.
# Never create/migrate a second database or import rotating OAuth credentials.
foreach ($name in @('OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CLI_CONFIG_CONTENT')) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process')) {
        throw "An existing $name override needs an explicit merge before using this launcher."
    }
}
if (@($OpenCodeArgs | Where-Object { $_ -match '^--(?:server|standalone)(?:=|$)' }).Count) {
    throw 'Use the original background service. A separate server can pause goals or hide profile settings.'
}
if (!(Test-Path -LiteralPath $JlockBin -PathType Leaf)) { throw 'The configured jlock binary is missing.' }
$configHome = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.config' }
$original = Join-Path $configHome 'opencode'
if ([IO.Path]::GetFullPath($SourceConfigDir).TrimEnd('\') -ne [IO.Path]::GetFullPath($original).TrimEnd('\')) {
    throw 'SourceConfigDir must be the original native configuration directory.'
}
if (!(Test-Path -LiteralPath $SourceConfigDir -PathType Container)) { throw 'The original configuration directory is missing.' }
if ($Check) {
    [ordered]@{ config = $SourceConfigDir; jlock = $JlockBin; privateServer = $false; privateHistory = $false; profile = 'original'; changesConfiguration = $false } | ConvertTo-Json
    exit 0
}
$before = $env:JLOCK_BIN
try {
    # Existing services keep their loaded modules and environment. This does not restart,
    # reload, unlock or migrate them. Install plugin updates separately while safe.
    $env:JLOCK_BIN = $JlockBin
    & $OpenCodeCommand @OpenCodeArgs
    $result = $LASTEXITCODE
} finally { $env:JLOCK_BIN = $before }
exit $result
