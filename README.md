# Ilovepatatos Framework
Ilovepatatos framework for [Rust](https://store.steampowered.com/app/252490/Rust/) using the [Oxide/uMod](https://umod.org) extension platforms to expose extension & utility functions.

## Dependencies
1. [OxideConsole Framework](https://github.com/ilovepatatos-rust/console-extension)
2. [Ui Framework](https://github.com/dassjosh/Rust.UIFramework)

## Getting Started
1. Grab the Oxide.Ext.IlovepatatosExt.dll from latest release
2. Put the DLL into `RustDedicated_Data\Managed` folder
3. Restart the server

## atlas-hub releases

`atlas-hub.dependencies.json` pins the UiFramework build manifest and the ConsoleExt/GizmosExt release assets by tag and SHA256. `Download-AtlasHubDependencies.ps1` requires an empty dependencies directory, verifies each download, and uses the Rust/Oxide reference snapshot from the selected UiFramework release.

Push a new `atlas-hub-X.Y.Z` tag on the atlas-hub branch to build that commit and publish a versioned prerelease. The workflow verifies the compiled UiFramework assembly reference before publishing. It preserves the stable latest release and does not overwrite existing releases.

Each prerelease contains the DLL, `atlas-hub.build.json` with source and dependency identities, and `atlas-hub.references.zip` with the exact input DLLs for downstream builds. The reference archive is a build input; do not extract it over a running server. Install the extension under its normal name, `Oxide.Ext.IlovepatatosExt.dll`, with the dependency versions recorded in the manifest.

Downstream repositories can use `.github/actions/build-extension` from this repository, pinned to a commit. Their `atlas-hub.dependencies.json` selects a parent release through `parent.repository`, `parent.branch`, `parent.tag`, `parent.commit` and `parent.manifestSha256`. `sourceBranch` records the consumer's actual source branch; it can be `main` even when the dependency profile is `atlas-hub`. The action verifies and inherits the parent's complete dependency set, adds the parent DLL, builds the consumer and checks its assembly references before publication. Each consumer still needs its own release trigger; there is no automatic cross-repository rebuild trigger.

The optional `prepare-references` action input names a PowerShell script inside the source checkout. It runs after downloading the pinned inputs and before compilation. For consumers that require publicized game references, use the repository's existing publicizer in that step. The action still verifies every extension DLL hash after preparation; the output reference archive records the actual compiler inputs.
