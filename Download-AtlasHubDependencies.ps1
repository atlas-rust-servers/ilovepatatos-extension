param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'src/dependencies'),
    [string]$ProfilePath = (Join-Path $PSScriptRoot 'atlas-hub.dependencies.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-FileHash
{
    param([string]$Path, [string]$Expected)

    if ($Expected -notmatch '^[a-fA-F0-9]{64}$')
    {
        throw "Invalid SHA256 for $Path"
    }
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Expected)
    {
        throw "SHA256 mismatch: $Path"
    }
}

function Get-ReleaseAsset
{
    param([string]$Repository, [string]$Tag, [string]$File, [string]$Sha256, [string]$Destination)

    if ($Repository -notmatch '^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$' -or [string]::IsNullOrWhiteSpace($Tag))
    {
        throw 'A repository and release tag are required.'
    }
    if ($File -notmatch '^[a-zA-Z0-9_.-]+$' -or $Sha256 -notmatch '^[a-fA-F0-9]{64}$')
    {
        throw "Invalid release asset: $File"
    }
    $url = "https://github.com/$Repository/releases/download/$([Uri]::EscapeDataString($Tag))/$([Uri]::EscapeDataString($File))"
    Write-Output "Downloading $Repository@$Tag/$File"
    Invoke-WebRequest -Uri $url -OutFile $Destination -MaximumRetryCount 2 -RetryIntervalSec 3 -ConnectionTimeoutSeconds 15 -OperationTimeoutSeconds 120
    Assert-FileHash -Path $Destination -Expected $Sha256
}

if ((Test-Path -LiteralPath $OutputDirectory) -and @(Get-ChildItem -LiteralPath $OutputDirectory -Force).Count -ne 0)
{
    throw "Dependencies directory must be empty: $OutputDirectory"
}

$profile = Get-Content -LiteralPath $ProfilePath -Raw | ConvertFrom-Json
$downloads = Join-Path $OutputDirectory '.downloads'
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
$framework = if ($profile.PSObject.Properties.Name -contains 'parent')
{
    $profile.parent
}
else
{
    $profile.uiFramework
}
$branch = if ($framework.PSObject.Properties.Name -contains 'branch')
{
    $framework.branch
}
else
{
    'atlas-hub'
}
$manifestPath = Join-Path $downloads 'atlas-hub.build.json'
Get-ReleaseAsset -Repository $framework.repository -Tag $framework.tag -File 'atlas-hub.build.json' -Sha256 $framework.manifestSha256 -Destination $manifestPath
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.repository -ne $framework.repository -or $manifest.branch -ne $branch -or $manifest.tag -ne $framework.tag -or $manifest.commit -ne $framework.commit)
{
    throw 'Parent build metadata does not match the dependency profile.'
}

$archivePath = Join-Path $downloads 'references.zip'
Get-ReleaseAsset -Repository $framework.repository -Tag $framework.tag -File $manifest.references.file -Sha256 $manifest.references.sha256 -Destination $archivePath
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try
{
    if ($manifest.references.assemblies.Count -eq 0 -or $archive.Entries.Count -ne $manifest.references.assemblies.Count)
    {
        throw 'Reference archive count mismatch.'
    }
    foreach ($entry in $archive.Entries)
    {
        if ($entry.FullName -notmatch '^[a-zA-Z0-9_.-]+\.dll$')
        {
            throw "Unexpected archive entry: $($entry.FullName)"
        }
    }
}
finally
{
    $archive.Dispose()
}
Expand-Archive -LiteralPath $archivePath -DestinationPath $OutputDirectory
foreach ($reference in $manifest.references.assemblies)
{
    if ($reference.file -notmatch '^[a-zA-Z0-9_.-]+\.dll$')
    {
        throw "Invalid reference name: $($reference.file)"
    }
    Assert-FileHash -Path (Join-Path $OutputDirectory $reference.file) -Expected $reference.sha256
}

$parentFile = $manifest.asset.file -replace '^atlas-hub_', ''
if ($parentFile -notmatch '^Oxide\.Ext\.[a-zA-Z0-9_.-]+\.dll$')
{
    throw "Invalid parent assembly name: $parentFile"
}
$parentPath = Join-Path $OutputDirectory $parentFile
if (Test-Path -LiteralPath $parentPath)
{
    throw "Duplicate parent dependency: $parentFile"
}
Get-ReleaseAsset -Repository $framework.repository -Tag $framework.tag -File $manifest.asset.file -Sha256 $manifest.asset.sha256 -Destination $parentPath
foreach ($extension in $profile.extensions)
{
    if ($extension.file -notmatch '^Oxide\.Ext\.[a-zA-Z0-9_.-]+\.dll$')
    {
        throw "Invalid extension name: $($extension.file)"
    }
    $destination = Join-Path $OutputDirectory $extension.file
    if (Test-Path -LiteralPath $destination)
    {
        throw "Duplicate dependency: $($extension.file)"
    }
    Get-ReleaseAsset -Repository $extension.repository -Tag $extension.tag -File $extension.file -Sha256 $extension.sha256 -Destination $destination
}
Write-Output "Verified $($manifest.references.assemblies.Count) shared references, $($framework.repository)@$($framework.tag) and $($profile.extensions.Count) extensions."
