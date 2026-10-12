# Install the chopin CLI from a githubnext/chopin release, for Windows x64.
#
#   irm https://github.com/githubnext/chopin/releases/latest/download/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://github.com/githubnext/chopin/releases/latest/download/install.ps1))) 0.2.0
#
# CHOPIN_VERSION              the version to install, like the argument (default: the newest release)
# CHOPIN_VERIFY_ATTESTATION   0 skips `gh attestation verify`, which otherwise runs when gh is installed
# CHOPIN_RELEASE_BASE_URL     where cli-v<version>/ assets are downloaded from
# CHOPIN_RELEASES_API_URL     the GitHub API list of releases used to find the newest version
#
# chopin.exe goes to %LOCALAPPDATA%\chopin\bin, which is added to your user PATH. Nothing here
# needs administrator rights.
param([string]$Version = $env:CHOPIN_VERSION)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repository = 'githubnext/chopin'
$BaseUrl = if ($env:CHOPIN_RELEASE_BASE_URL) { $env:CHOPIN_RELEASE_BASE_URL } else { "https://github.com/$Repository/releases/download" }
$ReleasesApiUrl = if ($env:CHOPIN_RELEASES_API_URL) { $env:CHOPIN_RELEASES_API_URL } else { "https://api.github.com/repos/$Repository/releases" }
$Asset = 'chopin-windows-x64.exe'

function Stop-Install([string]$Message) {
	throw [System.OperationCanceledException]::new("chopin install: $Message")
}

function Install-Chopin([string]$Version) {

	# Windows PowerShell 5.1 has no $IsWindows and only runs on Windows.
	if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
		Stop-Install 'install.ps1 installs chopin on Windows. On Linux or macOS, use install.sh.'
	}
	$Architecture = try {
		[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
	} catch {
		$env:PROCESSOR_ARCHITECTURE
	}
	if ($Architecture -notin @('X64', 'AMD64')) {
		Stop-Install "the $Architecture architecture is not supported. chopin is released for Windows x64."
	}
	if (-not $env:LOCALAPPDATA) {
		Stop-Install 'LOCALAPPDATA is not set, so there is no per-user directory to install into.'
	}

	# Windows PowerShell 5.1 can default to TLS 1.0, which GitHub refuses.
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

	$Scratch = Join-Path ([IO.Path]::GetTempPath()) "chopin-install-$([guid]::NewGuid().ToString('N'))"
	New-Item -ItemType Directory -Path $Scratch | Out-Null
	try {
		if (-not $Version) {
			try {
				$Releases = Invoke-RestMethod -UseBasicParsing -Uri "${ReleasesApiUrl}?per_page=100"
			} catch {
				Stop-Install "could not list releases from ${ReleasesApiUrl}: $_"
			}
			$Latest = @($Releases | Where-Object { $_.tag_name -like 'cli-v*' -and -not $_.draft -and -not $_.prerelease })[0]
			if (-not $Latest) { Stop-Install 'no chopin CLI release (a cli-v* tag) was found.' }
			$Version = $Latest.tag_name
		}
		$Version = $Version -replace '^cli-', '' -replace '^v', ''
		if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$') {
			Stop-Install "`"$Version`" is not a version like 0.2.0."
		}

		$Release = "$BaseUrl/cli-v$Version"
		Write-Host "Installing chopin $Version ($Asset) from $Release"
		$Download = Join-Path $Scratch $Asset
		$Checksums = Join-Path $Scratch 'checksums.txt'
		foreach ($File in @(@($Asset, $Download), @('checksums.txt', $Checksums))) {
			try {
				Invoke-WebRequest -UseBasicParsing -Uri "$Release/$($File[0])" -OutFile $File[1]
			} catch {
				Stop-Install "could not download $Release/$($File[0]): $_"
			}
		}

		$Expected = $null
		foreach ($Line in Get-Content -LiteralPath $Checksums) {
			if ($Line -match '^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$' -and $Matches[2] -eq $Asset) {
				$Expected = $Matches[1].ToLowerInvariant()
				break
			}
		}
		if (-not $Expected) { Stop-Install "checksums.txt has no entry for $Asset." }
		$Actual = (Get-FileHash -LiteralPath $Download -Algorithm SHA256).Hash.ToLowerInvariant()
		if ($Actual -ne $Expected) {
			Stop-Install "the SHA-256 of $Asset is $Actual, but checksums.txt says $Expected. Refusing to install it."
		}
		Write-Host 'Verified the SHA-256 checksum.'

		if ($env:CHOPIN_VERIFY_ATTESTATION -ne '0' -and (Get-Command gh -ErrorAction SilentlyContinue)) {
			& gh attestation verify $Download -R $Repository
			if ($LASTEXITCODE -ne 0) {
				Stop-Install "gh attestation verify could not confirm $Asset was built by $Repository. Refusing to install it. (CHOPIN_VERIFY_ATTESTATION=0 skips this check.)"
			}
			Write-Host 'Verified the build provenance attestation.'
		}

		$Directory = Join-Path $env:LOCALAPPDATA 'chopin\bin'
		$Chopin = Join-Path $Directory 'chopin.exe'
		$Reported = (& $Download --version 2>&1 | Out-String).Trim()
		if ($LASTEXITCODE -ne 0) { Stop-Install "the downloaded chopin does not run on this machine: $Reported" }
		New-Item -ItemType Directory -Path $Directory -Force | Out-Null
		Move-Item -LiteralPath $Download -Destination $Chopin -Force
		Write-Host "Installed $Reported at $Chopin"

		$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
		$Entries = @($UserPath -split ';' | Where-Object { $_ })
		if ($Entries -notcontains $Directory) {
			[Environment]::SetEnvironmentVariable('Path', (@($Entries) + $Directory) -join ';', 'User')
			Write-Host "Added $Directory to your user PATH. Open a new terminal to use chopin."
		}
		if (@($env:Path -split ';') -notcontains $Directory) { $env:Path = "$env:Path;$Directory" }
	} finally {
		Remove-Item -LiteralPath $Scratch -Recurse -Force -ErrorAction SilentlyContinue
	}
}

try {
	Install-Chopin $Version
} catch [System.OperationCanceledException] {
	Write-Host $_.Exception.Message -ForegroundColor Red
	# `exit` would close the window of someone who ran `irm ... | iex`; only a script file exits.
	if ($PSCommandPath) { exit 1 }
}
