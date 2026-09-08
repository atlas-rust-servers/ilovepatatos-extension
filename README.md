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

Push to `atlas-hub` or run its workflow manually to build and publish `atlas-hub-X.Y.Z`. The version increments automatically. These prereleases do not replace stable latest.

Each build downloads current Linux Rust/Oxide references. `atlas-hub.dependencies.json` selects each DLL independently: UiFramework from its latest published `atlas-hub` build, ConsoleExt and GizmosExt from stable latest. No dependency tags, hash pins or reference archives are required. Updating a dependency alone does not trigger a rebuild.

Each prerelease contains the extension DLL and `atlas-hub.build.json`, which identifies the source branch and selected downloads. Install the DLL under its normal name, `Oxide.Ext.IlovepatatosExt.dll`, and list every required DLL separately in egg's `external.json`.

Downstream repositories can reuse `.github/actions/build-extension@atlas-hub` with their own dependency profile. The optional `prepare-references` script runs on the game references before extension DLLs are downloaded and compiled.
