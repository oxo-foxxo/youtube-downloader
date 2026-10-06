$ErrorActionPreference = 'Stop'

$RepositoryUrl = 'https://github.com/oxo-foxxo/youtube-downloader.git'
$ArchiveUrl = 'https://github.com/oxo-foxxo/youtube-downloader/archive/refs/heads/main.zip'
$InstallDir = if ($Env:VIDEORIX_DIR) { $Env:VIDEORIX_DIR } else { Join-Path $HOME 'Videorix' }
$ManagedMarker = Join-Path $InstallDir '.videorix-managed'
$TempDir = $null

function Write-Step([string]$Message) {
    Write-Host "`nVideorix: $Message" -ForegroundColor Green
}

function Stop-Install([string]$Message) {
    throw "Videorix: $Message"
}

function Test-Docker {
    & docker info *> $null
    return $LASTEXITCODE -eq 0
}

if ($InstallDir -eq $HOME -or [string]::IsNullOrWhiteSpace($InstallDir)) {
    Stop-Install "Небезопасная папка установки: $InstallDir"
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-Install 'Сначала установите Docker Desktop: https://www.docker.com/products/docker-desktop/'
}

& docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
    Stop-Install 'Docker Compose v2 недоступен. Обновите Docker Desktop.'
}

if (-not (Test-Docker)) {
    $DockerDesktop = Join-Path $Env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $DockerDesktop) {
        Write-Step 'Запускаю Docker Desktop'
        Start-Process $DockerDesktop
        foreach ($Attempt in 1..60) {
            Start-Sleep -Seconds 2
            if (Test-Docker) { break }
        }
    }
}
if (-not (Test-Docker)) {
    Stop-Install 'Docker Desktop не запущен. Запустите его и повторите команду.'
}

function Install-FromArchive {
    $script:TempDir = Join-Path ([IO.Path]::GetTempPath()) ("videorix-" + [guid]::NewGuid())
    $Archive = Join-Path $script:TempDir 'videorix.zip'
    $Extracted = Join-Path $script:TempDir 'extracted'
    $Source = Join-Path $Extracted 'youtube-downloader-main'

    Write-Step 'Скачиваю актуальную версию'
    New-Item -ItemType Directory -Path $Extracted -Force | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri $ArchiveUrl -OutFile $Archive
    Expand-Archive -Path $Archive -DestinationPath $Extracted -Force
    if (-not (Test-Path (Join-Path $Source 'docker-compose.yml'))) {
        Stop-Install 'Архив Videorix имеет неверную структуру.'
    }

    if ((Test-Path $InstallDir) -and -not (Test-Path $InstallDir -PathType Container)) {
        Stop-Install "$InstallDir уже существует и не является папкой."
    }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $Existing = @(Get-ChildItem -Force $InstallDir)
    if (-not (Test-Path $ManagedMarker) -and $Existing.Count -gt 0) {
        Stop-Install "$InstallDir уже содержит другие файлы. Задайте другую папку через VIDEORIX_DIR."
    }

    if (Test-Path $ManagedMarker) {
        Get-ChildItem -Force $InstallDir |
            Where-Object { $_.Name -notin @('.env', '.videorix-managed') } |
            Remove-Item -Recurse -Force
    }
    Get-ChildItem -Force $Source | Copy-Item -Destination $InstallDir -Recurse -Force
    Set-Content -Path $ManagedMarker -Value $RepositoryUrl -Encoding UTF8
}

try {
    if ((Test-Path (Join-Path $InstallDir '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Step 'Обновляю существующую установку'
        Push-Location $InstallDir
        try {
            $Changes = & git status --porcelain
            if ($LASTEXITCODE -ne 0) { Stop-Install 'Не удалось проверить Git-репозиторий.' }
            if ([string]::IsNullOrWhiteSpace(($Changes -join ''))) {
                & git pull --ff-only origin main
                if ($LASTEXITCODE -ne 0) { Stop-Install 'Не удалось обновить Git-репозиторий.' }
            }
            else {
                Write-Step 'Найдены локальные изменения — запускаю текущую версию без обновления'
            }
        }
        finally {
            Pop-Location
        }
    }
    else {
        Install-FromArchive
    }

    Push-Location $InstallDir
    try {
        Write-Step 'Собираю и запускаю контейнеры'
        & docker compose up -d --build
        if ($LASTEXITCODE -ne 0) { Stop-Install 'Docker Compose не смог запустить сервис.' }

        $AppPort = if ($Env:APP_PORT) { $Env:APP_PORT } else { $null }
        $EnvFile = Join-Path $InstallDir '.env'
        if (-not $AppPort -and (Test-Path $EnvFile)) {
            foreach ($Line in Get-Content $EnvFile) {
                if ($Line -match '^\s*APP_PORT\s*=\s*["'']?(\d+)["'']?\s*$') {
                    $AppPort = $Matches[1]
                }
            }
        }
        if (-not $AppPort) { $AppPort = '8080' }
        $AppUrl = "http://localhost:$AppPort"

        Write-Step 'Жду готовности сервиса'
        $Ready = $false
        foreach ($Attempt in 1..90) {
            try {
                Invoke-RestMethod -Uri "$AppUrl/health" -TimeoutSec 3 | Out-Null
                $Ready = $true
                break
            }
            catch {
                Start-Sleep -Seconds 2
            }
        }
        if (-not $Ready) {
            & docker compose ps
            & docker compose logs --tail=80 app
            Stop-Install 'Сервис не запустился. Диагностика показана выше.'
        }

        Write-Step "Готово: $AppUrl"
        if ($Env:VIDEORIX_NO_OPEN -ne '1') {
            Start-Process $AppUrl
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($TempDir -and (Test-Path $TempDir)) {
        Remove-Item $TempDir -Recurse -Force
    }
}
