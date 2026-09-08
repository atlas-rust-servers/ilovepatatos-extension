param([Parameter(Mandatory)][string]$ProfilePath)

$ErrorActionPreference = 'Stop'
$profile = Get-Content -LiteralPath $ProfilePath -Raw | ConvertFrom-Json
$inputPath = [IO.Path]::GetTempFileName()
$resolvedPath = [IO.Path]::GetTempFileName()
try
{
    foreach ($dependency in $profile.'private-repo')
    {
        if ([string]::IsNullOrWhiteSpace($env:GH_TOKEN))
        {
            throw 'GH_TOKEN is required for private dependencies.'
        }
        $dependency | Add-Member -NotePropertyName token -NotePropertyValue $env:GH_TOKEN -Force
    }
    $profile | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $inputPath -Encoding utf8
    node (Join-Path $PSScriptRoot 'resolve-deps.js') $inputPath $resolvedPath
    if ($LASTEXITCODE -ne 0)
    {
        throw 'Dependency branch resolution failed.'
    }
    $resolved = Get-Content -LiteralPath $resolvedPath -Raw | ConvertFrom-Json
    foreach ($section in @('public-repo', 'private-repo'))
    {
        foreach ($dependency in $resolved.$section)
        {
            $destination = [IO.Path]::GetFullPath($dependency.'output-path')
            $workspace = [IO.Path]::GetFullPath((Get-Location).Path) + [IO.Path]::DirectorySeparatorChar
            if (-not $destination.StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase))
            {
                throw "Dependency destination is outside the checkout: $destination"
            }
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
            if ($section -eq 'public-repo')
            {
                Invoke-WebRequest -Uri $dependency.url -OutFile $destination -MaximumRetryCount 2 -RetryIntervalSec 3 -ConnectionTimeoutSeconds 15 -OperationTimeoutSeconds 120
            }
            else
            {
                $arguments = @('release', 'download', '--repo', $dependency.repo, '--pattern', $dependency.file, '--output', $destination, '--clobber')
                if ($dependency.PSObject.Properties.Name -contains 'resolved-tag')
                {
                    $arguments += $dependency.'resolved-tag'
                }
                gh @arguments
                if ($LASTEXITCODE -ne 0)
                {
                    throw "Private dependency download failed: $($dependency.repo)"
                }
            }
            $identity = [Reflection.AssemblyName]::GetAssemblyName($destination)
            if ($identity.Name + '.dll' -ne [IO.Path]::GetFileName($destination))
            {
                throw "Unexpected dependency identity: $($identity.Name)"
            }
            Write-Output "Downloaded $($identity.FullName)"
            $dependency.PSObject.Properties.Remove('token')
        }
    }
    New-Item -ItemType Directory -Path obj -Force | Out-Null
    $resolved | ConvertTo-Json -Depth 8 | Set-Content obj/resolved-dependencies.json -Encoding utf8
}
finally
{
    Remove-Item -LiteralPath $inputPath, $resolvedPath -Force
}
