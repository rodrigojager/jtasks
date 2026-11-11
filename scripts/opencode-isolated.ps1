# Launch future OpenCode v2 sessions with private storage, without reloading an existing server.
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)][string]$OpenCodeCommand,
    [Parameter(Mandatory)][string]$SourceConfigDir,
    [Parameter(Mandatory)][string]$ProfileConfigDir,
    [Parameter(Mandatory)][string]$JlockBin,
    [switch]$Check,
    [Parameter(ValueFromRemainingArguments)][string[]]$OpenCodeArgs
)
$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path $PSScriptRoot -Parent
foreach ($name in @('OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CLI_CONFIG_CONTENT')) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process')) {
        throw "An existing $name override needs an explicit merge before using this isolated launcher."
    }
}
if (@($OpenCodeArgs | Where-Object { $_ -match '^--server(?:=|$)' }).Count) { throw 'This launcher requires a private server; --server is incompatible.' }
if (!(Test-Path -LiteralPath $JlockBin -PathType Leaf)) { throw 'The configured jlock binary is missing.' }
$serverFile = Join-Path $SourceConfigDir 'opencode.json'
$cliFile = Join-Path $SourceConfigDir 'cli.json'
$server = Get-Content -LiteralPath $serverFile -Raw | ConvertFrom-Json -AsHashtable
$cli = Get-Content -LiteralPath $cliFile -Raw | ConvertFrom-Json -AsHashtable
$pluginDir = [Uri]::new((Join-Path $packageRoot 'opencode')).AbsoluteUri.TrimEnd('/')
# OpenCode v2 resolves /tui from the package directory's exports, not a source-file URL.
$pluginTui = $pluginDir
function Is-JtasksPlugin($entry) {
    $target = if ($entry -is [string]) { $entry } else { $entry.package }
    return $target -match '(?i)(?:^|[/\\])(?:opencode-)?jtasks(?:[/\\]|@|$)' -or $target -match '(?i)/jtasks-[^/]+/opencode(?:/|$)'
}
$server.plugins = @($server.plugins | Where-Object { !(Is-JtasksPlugin $_) }) + @($pluginDir)
$cli.plugins = @($cli.plugins | Where-Object { !(Is-JtasksPlugin $_) }) + @($pluginTui)
$rules = Join-Path $SourceConfigDir 'AGENTS.md'
if (Test-Path -LiteralPath $rules -PathType Leaf) {
    $server.instructions = @($server.instructions | Where-Object { $_ -ne $rules }) + @($rules)
}
# Keep existing hooks, skills and themes visible by reference, never by copying or editing them.
New-Item -ItemType Directory -Path $ProfileConfigDir -Force | Out-Null
# A second server sharing a database can pause the first server's goals during boot.
# Isolate both roots, retaining the original history and runtime state untouched.
$dataHome = Join-Path $ProfileConfigDir 'data'
$stateHome = Join-Path $ProfileConfigDir 'state'
$dataDir = Join-Path $dataHome 'opencode'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
New-Item -ItemType Directory -Path $stateHome -Force | Out-Null
$sourceDataHome = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.local/share' }
$sourceAuth = Join-Path $sourceDataHome 'opencode/auth.json'
$authLink = Join-Path $dataDir 'auth.json'
# OpenCode v2's legacy credential migration only reads this file into its private database.
# Reference the existing file instead of exporting credentials or copying a live database.
if (Test-Path -LiteralPath $sourceAuth -PathType Leaf) {
    if (Test-Path -LiteralPath $authLink) {
        $item = Get-Item -LiteralPath $authLink -Force
        if ($item.LinkType -ne 'SymbolicLink' -or [IO.Path]::GetFullPath($item.Target) -ne [IO.Path]::GetFullPath($sourceAuth)) {
            throw 'The private profile credential reference is not the expected symbolic link.'
        }
    } else { New-Item -ItemType SymbolicLink -Path $authLink -Target $sourceAuth | Out-Null }
}
foreach ($name in @('plugins', 'skills', 'themes', 'agents', 'commands', 'tools')) {
    $source = Join-Path $SourceConfigDir $name
    $link = Join-Path $ProfileConfigDir $name
    if (!(Test-Path -LiteralPath $source -PathType Container)) { continue }
    if (Test-Path -LiteralPath $link) {
        $item = Get-Item -LiteralPath $link -Force
        if ($item.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath($item.Target).TrimEnd('\') -ne [IO.Path]::GetFullPath($source).TrimEnd('\')) {
            throw "The profile path $link is not the expected junction."
        }
    } else { New-Item -ItemType Junction -Path $link -Target $source | Out-Null }
}
if ($Check) {
    [ordered]@{ serverPlugin = $pluginDir; tuiPlugin = $pluginTui; jlock = $JlockBin; privateServer = $true; privateData = $dataDir; privateState = (Join-Path $stateHome 'opencode'); serverPluginCount = $server.plugins.Count; tuiPluginCount = $cli.plugins.Count } | ConvertTo-Json
    exit 0
}
$names = @('OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CLI_CONFIG_CONTENT', 'JLOCK_BIN', 'XDG_DATA_HOME', 'XDG_STATE_HOME')
$before = @{}
foreach ($name in $names) { $before[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:OPENCODE_CONFIG_DIR = $ProfileConfigDir
    # Provider settings stay in memory for this child; never persist or print their values.
    $env:OPENCODE_CONFIG_CONTENT = $server | ConvertTo-Json -Depth 100 -Compress
    $env:OPENCODE_CLI_CONFIG_CONTENT = $cli | ConvertTo-Json -Depth 100 -Compress
    $env:JLOCK_BIN = $JlockBin
    $env:XDG_DATA_HOME = $dataHome
    $env:XDG_STATE_HOME = $stateHome
    & $OpenCodeCommand --standalone @OpenCodeArgs
    $result = $LASTEXITCODE
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $before[$name], 'Process') }
}
exit $result
