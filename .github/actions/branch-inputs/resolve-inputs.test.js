const test = require('node:test');
const assert = require('node:assert/strict');
const { BuildInputs, steamRuntime, nextVersion } = require('./resolve-inputs');

const STEAM = 'noise "258550" { "depots" { "258552" { "manifests" { "public" { "gid" "123456789" } } } "branches" { "public" { "buildid" "54321" } } } }';
const HASH = 'a'.repeat(64);

function manifest(repository, overrides = {}) {
    return { schema: 1, repository, branch: 'atlas-hub', tag: 'atlas-hub-1.0.1', version: '1.0.1', commit: 'b'.repeat(40), asset: { file: 'atlas-hub_Oxide.Ext.Test.dll', sha256: HASH }, ...overrides };
}

function resolver(manifests, digest = HASH) {
    async function fetchRequest(url) {
        const repository = url.split('/repos/')[1].split('/').slice(0, 2).join('/');
        if (url.includes('/releases/latest')) {
            return Response.json({ tag_name: 'v1', assets: [{ id: 2, name: repository === 'OxideMod/Oxide.Rust' ? 'Oxide.Rust-linux.zip' : 'Oxide.Ext.Other.dll', digest: `sha256:${digest}`, browser_download_url: 'https://github.com/OxideMod/Oxide.Rust/releases/download/v1/Oxide.Rust-linux.zip' }] });
        }
        assert.ok(manifests[repository], `Unexpected repository ${repository}`);
        if (url.includes('/releases?')) {
            return Response.json([{ id: 1, tag_name: 'atlas-hub-1.0.1', published_at: '2026-01-01T00:00:00Z', assets: [{ id: 1, name: 'atlas-hub.build.json', size: 2048 }, { id: 3, name: 'atlas-hub_Oxide.Ext.Test.dll' }] }]);
        }
        return Response.json(manifests[repository]);
    }
    return new BuildInputs(fetchRequest, 'test-token');
}

test('reads Linux public manifest and rejects missing or incomplete Steam metadata', function () {
    assert.deepEqual(steamRuntime(STEAM), { rustManifest: '123456789', rustBuild: '54321' });
    assert.throws(function missing() { steamRuntime('no app'); });
    assert.throws(function truncated() { steamRuntime('"258550" {'); });
    assert.throws(function wrongDepot() { steamRuntime(STEAM.replace('258552', '258551')); });
});

test('versions advance automatically and remain valid assembly versions', function () {
    assert.equal(nextVersion('1.7.23'), '1.7.24');
    assert.throws(function invalid() { nextVersion('main'); });
    assert.throws(function overflow() { nextVersion('1.7.65534'); });
});

test('root rebuilds only for source, Rust, Oxide or explicit force changes', async function () {
    const current = manifest('atlas/ui');
    const options = { repository: 'atlas/ui', branch: 'atlas-hub', commit: current.commit, steam: STEAM };
    const first = await resolver({ 'atlas/ui': current }).resolve(options);
    assert.equal(first.needed, true);
    current.buildInputs = first.inputs;
    assert.equal((await resolver({ 'atlas/ui': current }).resolve(options)).needed, false);
    assert.equal((await resolver({ 'atlas/ui': current }).resolve({ ...options, steam: STEAM.replace('123456789', '987654321') })).needed, true);
    assert.equal((await resolver({ 'atlas/ui': current }, 'c'.repeat(64)).resolve(options)).needed, true);
    assert.equal((await resolver({ 'atlas/ui': current }).resolve({ ...options, commit: 'd'.repeat(40) })).needed, true);
    assert.equal((await resolver({ 'atlas/ui': current }).resolve({ ...options, force: true })).needed, true);
});

test('consumer resolves branch parent and stable extras without changing its configured profile', async function () {
    const runtime = { rustBuild: '123', rustManifest: '456' };
    const root = manifest('atlas/ui', { buildInputs: { runtime } });
    const consumer = manifest('atlas/consumer');
    const profile = { parent: { repository: 'atlas/ui', branch: 'atlas-hub' }, extensions: [{ repository: 'atlas/other', file: 'Oxide.Ext.Other.dll' }] };
    const result = await resolver({ 'atlas/ui': root, 'atlas/consumer': consumer }).resolve({ repository: 'atlas/consumer', branch: 'atlas-hub', commit: consumer.commit, profile });
    assert.equal(result.profile.parent.tag, root.tag);
    assert.equal(result.profile.parent.manifestSha256.length, 64);
    assert.equal(result.profile.extensions[0].sha256, HASH);
    assert.deepEqual(result.inputs.runtime, runtime);
    assert.equal(profile.parent.tag, undefined);
    consumer.buildInputs = result.inputs;
    assert.equal((await resolver({ 'atlas/ui': root, 'atlas/consumer': consumer }).resolve({ repository: 'atlas/consumer', branch: 'atlas-hub', commit: consumer.commit, profile })).needed, false);
});

test('consumer waits for a parent with stale transitive dependencies or missing runtime snapshot', async function () {
    const root = manifest('atlas/ui');
    const consumer = manifest('atlas/consumer');
    const options = { repository: 'atlas/consumer', branch: 'atlas-hub', commit: consumer.commit, profile: { parent: { repository: 'atlas/ui', branch: 'atlas-hub' }, extensions: [] } };
    assert.equal((await resolver({ 'atlas/ui': root, 'atlas/consumer': consumer }).resolve(options)).needed, false);
    root.buildInputs = { runtime: { rustBuild: '1' } };
    root.dependencies = [{ repository: 'atlas/other', file: 'Oxide.Ext.Other.dll', sha256: 'd'.repeat(64) }];
    const result = await resolver({ 'atlas/ui': root, 'atlas/consumer': consumer }).resolve(options);
    assert.equal(result.needed, false);
    assert.match(result.reason, /Waiting for parent rebuild/);
});
