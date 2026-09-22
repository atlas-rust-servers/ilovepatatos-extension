const fs = require('node:fs/promises');
const path = require('node:path');

function requireValue(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function repositoryName(value) {
    requireValue(typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value), 'Invalid repository name');
    return value;
}

function assetName(value) {
    requireValue(typeof value === 'string' && /^[A-Za-z0-9_.-]+\.dll$/.test(value), 'Invalid DLL asset name');
    return value;
}

function outputPath(value) {
    requireValue(typeof value === 'string' && value.length > 0 && !value.includes('\\') && !/[\x00-\x1f]/.test(value) && !path.posix.isAbsolute(value) && !value.split('/').includes('..'), 'Branch output-path must stay inside the server directory');
    assetName(path.posix.basename(value));
    return path.posix.normalize(value);
}

function newestRelease(left, right) {
    return Date.parse(right.published_at) - Date.parse(left.published_at) || right.id - left.id;
}

class BranchResolver {
    #fetchRequest;
    #log;
    #tokens = new Map();
    #releaseLists = new Map();

    constructor(fetchRequest = fetch, log = console.error) {
        this.#fetchRequest = fetchRequest;
        this.#log = log;
    }

    async request(repository, suffix) {
        const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Atlas-Egg' };
        const token = this.#tokens.get(repository);
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        const response = await this.#fetchRequest(`https://api.github.com/repos/${repository}/${suffix}`, { headers, signal: AbortSignal.timeout(30000) });
        requireValue(response.ok, `GitHub ${repository}: HTTP ${response.status}`);
        return response;
    }

    async releases(repository) {
        if (this.#releaseLists.has(repository)) {
            return this.#releaseLists.get(repository);
        }
        const releases = [];
        for (let page = 1; page <= 20; page++) {
            const response = await this.request(repository, `releases?per_page=100&page=${page}`);
            const batch = await response.json();
            requireValue(Array.isArray(batch), `Invalid releases response for ${repository}`);
            for (const release of batch) {
                if (!release.draft && release.published_at && Array.isArray(release.assets)) {
                    releases.push(release);
                }
            }
            if (batch.length < 100) {
                releases.sort(newestRelease);
                this.#releaseLists.set(repository, releases);
                return releases;
            }
        }
        throw new Error(`Too many releases in ${repository}; cannot safely select the latest branch build`);
    }

    async select(entry) {
        const repository = repositoryName(entry.repo);
        requireValue(typeof entry.branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.branch), `Missing or invalid branch for ${repository}`);
        requireValue(!entry.tag && !entry.url, `Use branch without tag or url for ${repository}`);
        const destination = path.posix.basename(outputPath(entry['output-path']));
        const names = entry.file === undefined ? [destination, `${entry.branch}_${destination}`] : [assetName(entry.file)];
        this.#log(`Resolving ${repository} branch ${entry.branch}...`);
        let release;
        if (entry.branch === 'main') {
            const response = await this.request(repository, 'releases/latest');
            release = await response.json();
            requireValue(release && !release.draft && release.prerelease === false && release.published_at && Array.isArray(release.assets), `Invalid latest stable release for ${repository}`);
        } else {
            const prefix = `${entry.branch}-`;
            const releases = await this.releases(repository);
            release = releases.find(function matchesBranch(candidate) {
                return candidate.prerelease === true && typeof candidate.tag_name === 'string' &&
                    candidate.tag_name.startsWith(prefix) && /^v?\d+(?:\.\d+)*(?:[-+][A-Za-z0-9.-]+)?$/.test(candidate.tag_name.slice(prefix.length));
            });
        }
        requireValue(release, `No published prerelease for ${repository} branch ${entry.branch}`);
        requireValue(typeof release.tag_name === 'string' && release.tag_name.length > 0, `Invalid release tag for ${repository}`);
        const matches = release.assets.filter(function matchesAssembly(asset) { return names.includes(asset.name); });
        requireValue(matches.length > 0, `Latest ${entry.branch} release ${release.tag_name} lacks ${names.join(' or ')}`);
        requireValue(matches.length === 1, `Ambiguous DLL assets in ${repository}@${release.tag_name}; specify file`);
        this.#log(`Selected ${repository}@${release.tag_name}`);
        return { file: assetName(matches[0].name), tag: release.tag_name };
    }

    async resolve(config) {
        const resolved = { ...config, 'public-repo': [], 'private-repo': [] };
        for (const section of ['public-repo', 'private-repo']) {
            requireValue(!config[section] || Array.isArray(config[section]), `Invalid ${section}`);
            for (const entry of config[section] || []) {
                requireValue(entry && typeof entry === 'object', `Invalid entry in ${section}`);
                requireValue(!Object.hasOwn(entry, 'tag'), 'tag is not supported in external.json; use branch');
                requireValue(!Object.hasOwn(entry, 'sha256'), 'sha256 is not supported in external.json; remove the hash pin');
                requireValue(!Object.hasOwn(entry, 'resolved-tag'), 'resolved-tag is reserved for the branch resolver');
                if (!Object.hasOwn(entry, 'branch')) {
                    resolved[section].push(entry);
                    continue;
                }
                const repository = repositoryName(entry.repo);
                if (section === 'private-repo' && entry.token) {
                    this.#tokens.set(repository, entry.token);
                }
                const selected = await this.select(entry);
                const download = { 'output-path': outputPath(entry['output-path']) };
                if (section === 'private-repo') {
                    Object.assign(download, { repo: repository, token: entry.token, 'resolved-tag': selected.tag, file: selected.file });
                } else {
                    download.url = `https://github.com/${repository}/releases/download/${encodeURIComponent(selected.tag)}/${encodeURIComponent(selected.file)}`;
                }
                resolved[section].push(download);
            }
        }
        return resolved;
    }
}

async function main() {
    const [input, output] = process.argv.slice(2);
    requireValue(input && output, 'Usage: resolve-deps.js INPUT OUTPUT');
    const config = JSON.parse(await fs.readFile(input, 'utf8'));
    const resolver = new BranchResolver();
    const resolved = await resolver.resolve(config);
    await fs.writeFile(output, JSON.stringify(resolved), { mode: 0o600 });
}

function reportError(error) {
    console.error(`Branch release selection failed: ${error.message}`);
    process.exitCode = 1;
}

if (require.main === module) {
    main().catch(reportError);
}

module.exports = { BranchResolver };
