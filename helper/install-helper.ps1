param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$hostName = 'jp.inha.cast_volume'
$installDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CastVolume'
$registryKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"

if ($Uninstall) {
    if (Test-Path -LiteralPath $registryKey) {
        Remove-Item -LiteralPath $registryKey -Force
    }
    if (Test-Path -LiteralPath $installDir) {
        Remove-Item -LiteralPath $installDir -Recurse -Force
    }
    Write-Host 'Cast Volume helper removed.'
    return
}

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'This package requires 64-bit Windows.'
}

$packageDir = Split-Path -Parent $PSScriptRoot
$runtimeArchive = Join-Path $PSScriptRoot 'python-3.14.10-embed-amd64.zip'
$stagingDir = Join-Path $installDir ([Guid]::NewGuid().ToString('N'))
$oldManifest = (Get-ItemProperty -LiteralPath $registryKey -Name '(default)' -ErrorAction SilentlyContinue).'(default)'

try {
    $null = New-Item -Path $stagingDir -ItemType Directory -Force
    Expand-Archive -LiteralPath $runtimeArchive -DestinationPath (Join-Path $stagingDir 'runtime')
    $sourceDir = Join-Path $packageDir 'source'
    $sourceFiles = @('cast_discovery.py', 'cast_protocol.py', 'cast_volume_host.py')
    foreach ($sourceFile in $sourceFiles) {
        Copy-Item -LiteralPath (Join-Path $sourceDir $sourceFile) -Destination $stagingDir
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launch-host.cmd') -Destination $stagingDir

    $runtimeExe = Join-Path $stagingDir 'runtime\python.exe'
    Push-Location -LiteralPath $stagingDir
    try {
        & $runtimeExe -I -B -c "import sys; sys.path.insert(0, '.'); import cast_volume_host"
        if ($LASTEXITCODE -ne 0) {
            throw 'The bundled Python runtime could not start.'
        }
    } finally {
        Pop-Location
    }

    $manifestPath = Join-Path $stagingDir 'native-host.json'
    $manifest = [ordered]@{
        name = $hostName
        description = 'Local receiver volume control for the Cast Volume extension'
        path = 'launch-host.cmd'
        type = 'stdio'
        allowed_origins = @('chrome-extension://elhhnnbjjnhfgncifdfaeibfofkiapap/')
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), $utf8)

    if (-not (Test-Path -LiteralPath $registryKey)) {
        $null = New-Item -Path $registryKey -Force
    }
    Set-Item -LiteralPath $registryKey -Value $manifestPath
} catch {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
    throw
}

if ($oldManifest) {
    $oldDir = Split-Path -Parent $oldManifest
    if ((Split-Path -Parent $oldDir) -eq $installDir -and $oldDir -ne $stagingDir) {
        Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host 'Cast Volume helper installed for this Windows account.'
Write-Host 'Open chrome://extensions, enable Developer mode, and load the extension folder.'
