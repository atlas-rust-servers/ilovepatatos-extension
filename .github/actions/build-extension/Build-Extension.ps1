param(
    [Parameter(Mandatory)]
    [string]$Project,
    [Parameter(Mandatory)]
    [string]$Assembly,
    [Parameter(Mandatory)]
    [string]$Version,
    [string]$Platform = 'Any CPU',
    [string]$PrepareReferences = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Assembly -notmatch '^Oxide\.Ext\.[a-zA-Z0-9_]+$' -or $Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$')
{
    throw 'Invalid assembly name or version.'
}
$projectPath = (Resolve-Path -LiteralPath $Project).Path
$sourceDirectory = (Get-Location).Path
if (-not $projectPath.StartsWith($sourceDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))
{
    throw 'Project must be inside the source checkout.'
}

& (Join-Path $PSScriptRoot '../../../Download-AtlasHubDependencies.ps1') -OutputDirectory (Join-Path $sourceDirectory 'src/dependencies') -ProfilePath (Join-Path $sourceDirectory 'atlas-hub.dependencies.json')
$profile = Get-Content atlas-hub.dependencies.json -Raw | ConvertFrom-Json
$parent = Get-Content src/dependencies/.downloads/atlas-hub.build.json -Raw | ConvertFrom-Json
if ($parent.references.platform -ne 'linux' -or -not (Test-Path 'src/dependencies/Facepunch.Steamworks.Posix.dll'))
{
    throw 'The atlas-hub dependency snapshot must target Linux.'
}
$parentFile = $parent.asset.file -replace '^atlas-hub_', ''
$dependencies = @()
if ($parent.PSObject.Properties.Name -contains 'dependencies')
{
    $dependencies += $parent.dependencies
}
$dependencies += [ordered]@{
    repository = $parent.repository
    branch = $parent.branch
    tag = $parent.tag
    commit = $parent.commit
    manifestSha256 = $profile.parent.manifestSha256
    file = $parentFile
    asset = $parent.asset.file
    sha256 = $parent.asset.sha256
}
foreach ($extension in $profile.extensions)
{
    $dependencies += [ordered]@{
        repository = $extension.repository
        tag = $extension.tag
        file = $extension.file
        asset = $extension.file
        sha256 = $extension.sha256
    }
}

$expectedAssemblies = @{}
if ($PrepareReferences)
{
    $preparationPath = (Resolve-Path -LiteralPath $PrepareReferences).Path
    if (-not $preparationPath.StartsWith($sourceDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($preparationPath) -ne '.ps1')
    {
        throw 'Reference preparation must be a PowerShell script inside the source checkout.'
    }
    & $preparationPath
}
foreach ($dependency in $dependencies)
{
    if ($dependency.file -notmatch '^Oxide\.Ext\.[a-zA-Z0-9_.-]+\.dll$')
    {
        throw "Invalid dependency file: $($dependency.file)"
    }
    $path = Join-Path $sourceDirectory "src/dependencies/$($dependency.file)"
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $dependency.sha256)
    {
        throw "Dependency chain hash mismatch: $($dependency.file)"
    }
    $identity = [Reflection.AssemblyName]::GetAssemblyName($path)
    if ($identity.Name + '.dll' -ne $dependency.file -or $expectedAssemblies.ContainsKey($identity.Name))
    {
        throw "Conflicting dependency identity: $($dependency.file)"
    }
    $expectedAssemblies.Add($identity.Name, $identity.Version)
}

dotnet build $projectPath -c Release "/p:Platform=$Platform" "/p:Version=$Version" /p:GITHUB_ACTIONS=true -o obj/atlas-hub-build
if ($LASTEXITCODE -ne 0)
{
    throw 'Extension compilation failed.'
}
$assemblyPath = (Resolve-Path "obj/atlas-hub-build/$Assembly.dll").Path
$identity = [Reflection.AssemblyName]::GetAssemblyName($assemblyPath)
if ($identity.Name -ne $Assembly -or $identity.Version.ToString() -ne "$Version.0")
{
    throw "Unexpected output assembly: $($identity.FullName)"
}
$stream = [IO.File]::OpenRead($assemblyPath)
$reader = [Reflection.PortableExecutable.PEReader]::new($stream)
try
{
    $metadata = [Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($reader)
    $parentFound = $false
    foreach ($handle in $metadata.AssemblyReferences)
    {
        $reference = $metadata.GetAssemblyReference($handle)
        $name = $metadata.GetString($reference.Name)
        if ($name + '.dll' -eq $parentFile)
        {
            $parentFound = $true
        }
        if ($expectedAssemblies.ContainsKey($name) -and $reference.Version -ne $expectedAssemblies[$name])
        {
            throw "Wrong compiled dependency version: $name $($reference.Version)"
        }
    }
    if (-not $parentFound)
    {
        throw "Output assembly does not reference its parent: $parentFile"
    }
}
finally
{
    $reader.Dispose()
    $stream.Dispose()
}

New-Item -ItemType Directory -Path bin -Force | Out-Null
$assetName = "atlas-hub_$Assembly.dll"
Copy-Item -LiteralPath $assemblyPath -Destination "bin/$assetName"
$references = @(foreach ($file in Get-ChildItem src/dependencies -Filter '*.dll' -File | Sort-Object Name)
{
    [ordered]@{
        file = $file.Name
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
})
Compress-Archive -Path 'src/dependencies/*.dll' -DestinationPath bin/atlas-hub.references.zip
$commit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0)
{
    throw 'Source commit lookup failed.'
}
$manifest = [ordered]@{
    schema = 1
    repository = $env:GITHUB_REPOSITORY
    branch = $profile.sourceBranch
    profile = 'atlas-hub'
    commit = $commit
    tag = $env:GITHUB_REF_NAME
    version = $Version
    sdk = (dotnet --version)
    targetFramework = 'net48'
    asset = [ordered]@{
        file = $assetName
        sha256 = (Get-FileHash "bin/$assetName" -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    dependencies = $dependencies
    references = [ordered]@{
        platform = $parent.references.platform
        preparation = $PrepareReferences
        file = 'atlas-hub.references.zip'
        sha256 = (Get-FileHash bin/atlas-hub.references.zip -Algorithm SHA256).Hash.ToLowerInvariant()
        assemblies = $references
    }
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content bin/atlas-hub.build.json -Encoding utf8
Write-Output "Verified $Assembly $Version with $($dependencies.Count) extension dependencies and $($references.Count) reference DLLs."
