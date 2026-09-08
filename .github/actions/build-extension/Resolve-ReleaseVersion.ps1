param([string]$Prefix = '')

$ErrorActionPreference = 'Stop'
$pattern = '^' + [regex]::Escape($Prefix) + '([0-9]+\.[0-9]+\.[0-9]+)(?:-[0-9]+-[0-9]+)?$'
if ($env:GITHUB_REF_TYPE -eq 'tag' -and $env:GITHUB_REF_NAME -match $pattern)
{
    $version = $Matches[1]
    $tag = $env:GITHUB_REF_NAME
}
else
{
    $tags = gh api --paginate "repos/$env:GITHUB_REPOSITORY/tags?per_page=100" --jq '.[].name'
    if ($LASTEXITCODE -ne 0)
    {
        throw 'Release version lookup failed.'
    }
    $latest = [version]'1.0.0'
    foreach ($existingTag in $tags)
    {
        if ($existingTag -match $pattern)
        {
            $candidate = [version]$Matches[1]
            if ($candidate -gt $latest)
            {
                $latest = $candidate
            }
        }
    }
    $version = '{0}.{1}.{2}' -f $latest.Major, $latest.Minor, ($latest.Build + 1)
    $tag = "$Prefix$version"
}
"VERSION=$version" | Add-Content $env:GITHUB_ENV
"RELEASE_TAG=$tag" | Add-Content $env:GITHUB_ENV
Write-Output "Release: $tag"
