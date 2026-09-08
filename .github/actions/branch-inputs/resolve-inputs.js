const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function assert(value, message) {
    if (!value) {
        throw new Error(message);
    }
}

function hash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function steamRuntime(text) {
    const start = text.indexOf('"258550"');
    assert(start >= 0, 'Steam app metadata is missing');
    const tokens = text.slice(start).match(/"(?:\\.|[^"\\])*"|[{}]/g) || [];
    let position = 0;
    function value() {
        const token = tokens[position++];
        assert(token !== undefined, 'Incomplete Steam metadata');
        if (token !== '{') {
            assert(token.startsWith('"'), 'Invalid Steam metadata value');
            return token.slice(1, -1);
        }
        const object = Object.create(null);
        while (tokens[position] !== '}') {
            const key = value();
            assert(typeof key === 'string' && !Object.hasOwn(object, key), 'Invalid or duplicate Steam metadata key');
            object[key] = value();
        }
        position++;
        return object;
    }
    assert(value() === '258550', 'Wrong Steam app');
    const app = value();
    const manifest = app.depots?.['258552']?.manifests?.public?.gid;
    const build = app.depots?.branches?.public?.buildid;
    assert(/^\d+$/.test(manifest) && /^\d+$/.test(build), 'Linux public depot manifest or build ID is missing');
    return { rustManifest: manifest, rustBuild: build };
}

function nextVersion(previous) {
    assert(/^\d+\.\d+\.\d+$/.test(previous), 'Latest release has no valid assembly version');
    const parts = previous.split('.').map(Number);
    parts[2]++;
    assert(parts.every(function validPart(part) { return Number.isInteger(part) && part >= 0 && part < 65535; }), 'Assembly version exceeds its range');
    return parts.join('.');
}

class BuildInputs {
    #fetch;
    #token;
    #branches = new Map();
    #stable = new Map();

    constructor(fetchRequest = fetch, token = process.env.GH_TOKEN) {
        this.#fetch = fetchRequest;
        this.#token = token;
    }

    async request(repository, suffix, binary = false) {
        assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Invalid repository');
        const headers = { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'User-Agent': 'Atlas-Branch-Build' };
        if (this.#token) {
            headers.Authorization = `Bearer ${this.#token}`;
        }
        const response = await this.#fetch(`https://api.github.com/repos/${repository}/${suffix}`, { headers, signal: AbortSignal.timeout(30000) });
        assert(response.ok, `GitHub ${repository}: HTTP ${response.status}`);
        return response;
    }

    async bytes(repository, asset, limit) {
        assert(Number.isSafeInteger(asset.id) && asset.id > 0 && asset.size <= limit, 'Invalid release asset metadata');
        const response = await this.request(repository, `releases/assets/${asset.id}`, true);
        const buffer = Buffer.from(await response.arrayBuffer());
        assert(buffer.length <= limit, 'Release asset exceeds size limit');
        if (asset.digest) {
            assert(asset.digest === `sha256:${hash(buffer)}`, 'Release asset digest mismatch');
        }
        return buffer;
    }

    async branch(repository, branch) {
        const key = `${repository}:${branch}`;
        if (this.#branches.has(key)) {
            return this.#branches.get(key);
        }
        const releases = [];
        for (let page = 1; page <= 20; page++) {
            const batch = await (await this.request(repository, `releases?per_page=100&page=${page}`)).json();
            assert(Array.isArray(batch), 'Invalid release list');
            releases.push(...batch);
            if (batch.length < 100) {
                break;
            }
            assert(page < 20, 'Release pagination limit exceeded');
        }
        releases.sort(function newest(left, right) { return Date.parse(right.published_at) - Date.parse(left.published_at) || right.id - left.id; });
        for (const release of releases) {
            if (release.draft) {
                continue;
            }
            const asset = release.assets.find(function manifestAsset(asset) { return asset.name === 'atlas-hub.build.json'; });
            if (!asset) {
                continue;
            }
            const buffer = await this.bytes(repository, asset, 4 * 1024 * 1024);
            const manifest = JSON.parse(buffer.toString('utf8'));
            if (manifest.branch !== branch) {
                continue;
            }
            assert(manifest.schema === 1 && manifest.repository === repository && manifest.tag === release.tag_name && /^[a-f0-9]{40}$/i.test(manifest.commit), 'Invalid branch build metadata');
            assert(manifest.asset && /^[a-f0-9]{64}$/i.test(manifest.asset.sha256), 'Invalid branch assembly hash');
            assert(release.assets.some(function assemblyAsset(asset) { return asset.name === manifest.asset.file; }), 'Latest branch build is missing its DLL');
            const result = { manifest, manifestSha256: hash(buffer), release };
            this.#branches.set(key, result);
            return result;
        }
        throw new Error(`No published ${branch} build in ${repository}`);
    }

    async stable(repository, file) {
        const key = `${repository}:${file}`;
        if (this.#stable.has(key)) {
            return this.#stable.get(key);
        }
        const release = await (await this.request(repository, 'releases/latest')).json();
        const matches = release.assets.filter(function matchingAsset(asset) { return asset.name === file; });
        assert(matches.length === 1 && !release.draft && !release.prerelease, `Missing stable asset ${repository}/${file}`);
        const asset = matches[0];
        const sha256 = /^sha256:[a-f0-9]{64}$/.test(asset.digest || '') ? asset.digest.slice(7) : hash(await this.bytes(repository, asset, 256 * 1024 * 1024));
        const result = { repository, tag: release.tag_name, file, sha256, id: asset.id, url: asset.browser_download_url };
        this.#stable.set(key, result);
        return result;
    }

    async resolve({ repository, branch, commit, profile, steam, force = false }) {
        const current = await this.branch(repository, branch);
        let resolvedProfile = null;
        const inputs = { source: { repository, branch, commit } };
        if (!profile) {
            const oxide = await this.stable('OxideMod/Oxide.Rust', 'Oxide.Rust-linux.zip');
            inputs.runtime = { ...steamRuntime(steam), oxideTag: oxide.tag, oxideAssetId: oxide.id, oxideSha256: oxide.sha256, oxideUrl: oxide.url };
        } else {
            const parentSpec = profile.parent || profile.uiFramework;
            assert(parentSpec && parentSpec.branch && Array.isArray(profile.extensions), 'Expected a branch parent and extensions array');
            const parent = await this.branch(parentSpec.repository, parentSpec.branch);
            if (!parent.manifest.buildInputs?.runtime) {
                return { needed: false, reason: 'Waiting for parent built by the automatic pipeline' };
            }
            for (const dependency of parent.manifest.dependencies || []) {
                const latest = dependency.branch ? (await this.branch(dependency.repository, dependency.branch)).manifest.asset : await this.stable(dependency.repository, dependency.asset || dependency.file);
                if (latest.sha256 !== dependency.sha256) {
                    return { needed: false, reason: `Waiting for parent rebuild with current ${dependency.file}` };
                }
            }
            const parentPin = { repository: parentSpec.repository, branch: parentSpec.branch, tag: parent.manifest.tag, commit: parent.manifest.commit, manifestSha256: parent.manifestSha256 };
            const extensions = [];
            for (const spec of profile.extensions) {
                assert(/^Oxide\.Ext\.[A-Za-z0-9_.-]+\.dll$/.test(spec.file), 'Invalid extension file');
                if (spec.branch) {
                    const selected = await this.branch(spec.repository, spec.branch);
                    extensions.push({ repository: spec.repository, branch: spec.branch, tag: selected.manifest.tag, file: spec.file, asset: selected.manifest.asset.file, sha256: selected.manifest.asset.sha256 });
                } else {
                    const selected = await this.stable(spec.repository, spec.file);
                    extensions.push({ repository: spec.repository, tag: selected.tag, file: spec.file, sha256: selected.sha256 });
                }
            }
            inputs.parent = parentPin;
            inputs.extensions = extensions;
            inputs.runtime = parent.manifest.buildInputs.runtime;
            resolvedProfile = { sourceBranch: branch, [profile.parent ? 'parent' : 'uiFramework']: parentPin, extensions };
        }
        const needed = force || JSON.stringify(inputs) !== JSON.stringify(current.manifest.buildInputs);
        const version = needed ? nextVersion(current.manifest.version) : current.manifest.version;
        return { needed, reason: needed ? 'Source or build inputs changed' : 'Source and build inputs are unchanged', inputs, profile: resolvedProfile, commit, version, tag: `${branch}-${version}` };
    }
}

async function main() {
    const profilePath = process.env.PROFILE_PATH;
    const profile = profilePath ? JSON.parse(await fs.readFile(profilePath, 'utf8')) : null;
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const result = await new BuildInputs().resolve({ repository: process.env.GITHUB_REPOSITORY, branch: 'atlas-hub', commit, profile, steam: profile ? null : await fs.readFile('.branch-build/steam-info.txt', 'utf8'), force: process.env.FORCE_BUILD === 'true' });
    if (result.needed) {
        result.tag += `-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
    }
    console.log(result.reason);
    const output = { needed: String(result.needed), commit, version: result.version || '', tag: result.tag || '', inputs: JSON.stringify(result.inputs || {}), profile: JSON.stringify(result.profile) };
    for (const [key, value] of Object.entries(output)) {
        assert(!value.includes('\n'), 'Invalid multiline output');
        await fs.appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${process.env.GITHUB_REPOSITORY}: ${result.reason}\n`);
}

function reportError(error) {
    console.error(error.message);
    process.exitCode = 1;
}

if (require.main === module) {
    main().catch(reportError);
}

module.exports = { BuildInputs, steamRuntime, nextVersion };
