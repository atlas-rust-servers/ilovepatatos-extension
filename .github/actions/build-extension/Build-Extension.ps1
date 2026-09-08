param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$Assembly,
    [Parameter(Mandatory)][string]$Version,
    [string]$Platform = 'Any CPU',
    [string]$PrepareReferences = ''
)

$ErrorActionPreference = 'Stop'
& ./.build-tools/ui/Download-References.ps1 -Linux
$referencesDirectory = Join-Path (Get-Location).Path 'src/dependencies'
New-Item -ItemType Directory -Path $referencesDirectory -Force | Out-Null
Get-ChildItem -LiteralPath $referencesDirectory -Filter '*.dll' -File | Remove-Item -Force
Copy-Item -Path .build-tools/ui/src/references/Rust/*.dll -Destination $referencesDirectory
if ($PrepareReferences)
{
    foreach ($file in @('UnityEngine.ARModule.dll', 'UnityEngine.NVIDIAModule.dll', 'Microsoft.Bcl.AsyncInterfaces.dll', 'System.Threading.Tasks.Extensions.dll', 'Microsoft.Win32.Registry.dll', 'System.Text.Encodings.Web.dll', 'System.Numerics.Vectors.dll', 'Newtonsoft.Json.dll'))
    {
        $filePath = Join-Path $referencesDirectory $file
        if (Test-Path -LiteralPath $filePath)
        {
            Remove-Item -LiteralPath $filePath
        }
    }
    & (Resolve-Path -LiteralPath $PrepareReferences).Path
}
& (Join-Path $PSScriptRoot 'Download-BranchDependencies.ps1') -ProfilePath atlas-hub.dependencies.json

dotnet build $Project -c Release "/p:Platform=$Platform" "/p:Version=$Version" /p:GITHUB_ACTIONS=true -o obj/atlas-hub-build
if ($LASTEXITCODE -ne 0)
{
    throw 'Extension compilation failed.'
}
$commit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0)
{
    throw 'Source commit lookup failed.'
}
New-Item -ItemType Directory -Path bin -Force | Out-Null
$asset = "atlas-hub_$Assembly.dll"
Copy-Item "obj/atlas-hub-build/$Assembly.dll" "bin/$asset"
[ordered]@{
    repository = $env:GITHUB_REPOSITORY
    branch = 'atlas-hub'
    commit = $commit
    tag = $env:RELEASE_TAG
    version = $Version
    asset = @{ file = $asset }
    sources = (Get-Content obj/resolved-dependencies.json -Raw | ConvertFrom-Json)
} | ConvertTo-Json -Depth 8 | Set-Content bin/atlas-hub.build.json -Encoding utf8
