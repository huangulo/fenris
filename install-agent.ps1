#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Install the Fenris monitoring agent as a Windows service.

.DESCRIPTION
    Downloads the latest fenris-agent binary from GitHub Releases,
    writes the configuration file, installs and starts the Windows service.

.EXAMPLE
    # Interactive install (prompts for values):
    irm https://raw.githubusercontent.com/huangulo/fenris/main/install-agent.ps1 | iex

    # Unattended install:
    $env:FENRIS_SERVER_URL = "https://fenris.example.com"
    $env:FENRIS_API_KEY    = "your-api-key"
    $env:FENRIS_SERVER_NAME = "web-01"
    irm https://raw.githubusercontent.com/huangulo/fenris/main/install-agent.ps1 | iex
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Config ─────────────────────────────────────────────────────────────────────

$ServiceName   = "FenrisAgent"
$InstallDir    = "C:\Program Files\Fenris"
$ConfigDir     = "C:\ProgramData\Fenris"
$ConfigFile    = "$ConfigDir\fenris-agent.yaml"
$BinaryName    = "fenris-agent.exe"
$BinaryPath    = "$InstallDir\$BinaryName"
$GithubRepo    = "huangulo/fenris"
$ReleaseAsset  = "fenris-agent-windows-amd64.exe"

# ── Helpers ────────────────────────────────────────────────────────────────────

function Prompt-Value {
    param([string]$Name, [string]$EnvVar, [string]$Default = "", [bool]$Secret = $false)
    $val = [System.Environment]::GetEnvironmentVariable($EnvVar)
    if ($val) { return $val }
    $prompt = if ($Default) { "$Name [$Default]" } else { $Name }
    if ($Secret) {
        $secure = Read-Host "$prompt" -AsSecureString
        return [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    }
    $input = Read-Host "$prompt"
    if ($input -eq "" -and $Default -ne "") { return $Default }
    return $input
}

function Write-Step { param([string]$Msg) Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "    OK: $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "    WARN: $Msg" -ForegroundColor Yellow }

# ── Gather config ──────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Fenris Agent Installer" -ForegroundColor White
Write-Host "  ─────────────────────" -ForegroundColor DarkGray
Write-Host ""

$ServerURL   = Prompt-Value "Fenris server URL"  "FENRIS_SERVER_URL"  "http://localhost:3200"
$ApiKey      = Prompt-Value "API key"            "FENRIS_API_KEY"     ""       $true
$ServerName  = Prompt-Value "Server name (display name)" "FENRIS_SERVER_NAME" $env:COMPUTERNAME
$Interval    = Prompt-Value "Collect interval (seconds)" "FENRIS_COLLECT_INTERVAL" "30"
$VerifySSL   = Prompt-Value "Verify SSL certificate? (true/false)" "FENRIS_VERIFY_SSL" "true"

if (-not $ApiKey) {
    Write-Host "API key is required." -ForegroundColor Red
    exit 1
}

# ── Download binary ────────────────────────────────────────────────────────────

Write-Step "Fetching latest release from GitHub"

$releaseUrl = "https://api.github.com/repos/$GithubRepo/releases/latest"
try {
    $release = Invoke-RestMethod -Uri $releaseUrl -Headers @{ "User-Agent" = "fenris-installer" }
    $asset = $release.assets | Where-Object { $_.name -eq $ReleaseAsset } | Select-Object -First 1
    if (-not $asset) { throw "Asset '$ReleaseAsset' not found in release $($release.tag_name)" }
    $downloadUrl = $asset.browser_download_url
    Write-Ok "Found $($release.tag_name) — $ReleaseAsset"
} catch {
    Write-Warn "Could not fetch release: $_"
    Write-Warn "Please download $ReleaseAsset manually and re-run with FENRIS_BINARY_PATH set."
    exit 1
}

Write-Step "Downloading binary"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-WebRequest -Uri $downloadUrl -OutFile $BinaryPath -UseBasicParsing
Write-Ok "Saved to $BinaryPath"

# ── Write config ───────────────────────────────────────────────────────────────

Write-Step "Writing configuration"
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

@"
server_url: "$ServerURL"
api_key: "$ApiKey"
server_name: "$ServerName"
collect_interval_seconds: $Interval
verify_ssl: $($VerifySSL.ToLower())
"@ | Set-Content -Path $ConfigFile -Encoding UTF8

Write-Ok "Config written to $ConfigFile"

# ── Stop + remove existing service ────────────────────────────────────────────

Write-Step "Preparing service"
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    Write-Warn "Existing service found — stopping and removing"
    if ($svc.Status -eq "Running") {
        Stop-Service -Name $ServiceName -Force
        Start-Sleep -Seconds 2
    }
    & $BinaryPath uninstall 2>&1 | Out-Null
}

# ── Install and start service ─────────────────────────────────────────────────

Write-Step "Installing service"
& $BinaryPath install --config $ConfigFile
if ($LASTEXITCODE -ne 0) { Write-Host "Install failed." -ForegroundColor Red; exit 1 }
Write-Ok "Service registered"

Write-Step "Starting service"
Start-Service -Name $ServiceName
Start-Sleep -Seconds 3

$svc = Get-Service -Name $ServiceName
if ($svc.Status -eq "Running") {
    Write-Ok "Service is RUNNING"
} else {
    Write-Warn "Service state: $($svc.Status)"
    Write-Warn "Check Event Viewer → Windows Logs → Application for errors."
    exit 1
}

# ── Summary ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Server:   $ServerURL"   -ForegroundColor DarkGray
Write-Host "  Name:     $ServerName"  -ForegroundColor DarkGray
Write-Host "  Interval: ${Interval}s" -ForegroundColor DarkGray
Write-Host "  Config:   $ConfigFile"  -ForegroundColor DarkGray
Write-Host "  Binary:   $BinaryPath"  -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Manage with:" -ForegroundColor DarkGray
Write-Host "    Stop:      Stop-Service FenrisAgent" -ForegroundColor DarkGray
Write-Host "    Start:     Start-Service FenrisAgent" -ForegroundColor DarkGray
Write-Host "    Uninstall: & '$BinaryPath' uninstall" -ForegroundColor DarkGray
Write-Host ""
