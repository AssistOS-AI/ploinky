import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    CORE_REPOSITORIES,
    INVENTORY_KIND,
    MANIFEST_KIND,
    parseCommandLine,
    readBoundedJsonWithDigest,
    validateInventory,
    validateManifest,
    verifyManifestFile,
    verifyReleaseBundle,
    writeManifestFile,
} from '../release/verifyExplorerReleaseBundle.mjs';
import {
    LOCKED_ROOT_POSTINSTALL,
    validateReleaseManifest,
    verifyManifestFile as verifyLegacyManifestFile,
} from '../release/verifyCopilot421Bundle.mjs';

const VERIFIER = path.resolve(import.meta.dirname, '../release/verifyExplorerReleaseBundle.mjs');
const LEGACY_VERIFIER = path.resolve(import.meta.dirname, '../release/verifyCopilot421Bundle.mjs');
const DIGEST = `sha256:${'5'.repeat(64)}`;
const TEMP_ROOT = fs.realpathSync(os.tmpdir());
const DEPENDENCIES = ['webmeet', 'OnlyOfficeAgent'];

function git(cwd, ...args) {
    return execFileSync('git', [
        '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
        '-C', cwd, ...args,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createRepository(root, files) {
    fs.mkdirSync(root, { recursive: true });
    git(root, 'init', '-q');
    for (const [relative, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), content);
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'fixture');
    return git(root, 'rev-parse', 'HEAD');
}

// A complete, truthful current source graph: core repositories, actual
// dependencies, RoboTeam inside Explorer, and no AchillesCLI repository.
function createFixture(t, { dependencies = DEPENDENCIES } = {}) {
    const base = fs.mkdtempSync(path.join(TEMP_ROOT, 'xrb-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const sources = path.join(base, 'sources');
    const evidence = path.join(base, 'evidence');
    fs.mkdirSync(sources);
    fs.mkdirSync(evidence);
    const roots = {};
    const repositories = {};
    const add = (name, files, role = 'deployed-source') => {
        roots[name] = path.join(sources, name);
        repositories[name] = { root: roots[name], commit: createRepository(roots[name], files), role };
    };
    add('ploinky', {
        'package.json': JSON.stringify({ scripts: { postinstall: LOCKED_ROOT_POSTINSTALL } }),
        'globalDeps/package.json': JSON.stringify({ dependencies: { 'mcp-sdk': 'git+https://github.com/AssistOS-AI/MCPSDK.git#main' } }),
    });
    add('explorer', { 'roboTeamAgent/manifest.json': '{}', 'explorer/manifest.json': '{}' });
    add('achillesAgentLib', { 'package.json': '{"name":"achillesAgentLib"}' }, 'provenance-reference');
    for (const name of dependencies) add(name, { 'manifest.json': '{}' });
    const inventory = {
        schemaVersion: 1,
        kind: INVENTORY_KIND,
        roboTeam: { repository: 'explorer', path: 'roboTeamAgent' },
        repositories,
    };
    const fixture = { base, sources, evidence, roots, inventory, inventoryPath: path.join(evidence, 'source-inventory.json') };
    fixture.writeInventory = (value = fixture.inventory) => {
        const bytes = Buffer.from(JSON.stringify(value, null, 2));
        fs.writeFileSync(fixture.inventoryPath, bytes);
        fixture.inventorySha256 = sha256(bytes);
        return fixture.inventorySha256;
    };
    fixture.manifest = () => ({
        schemaVersion: 1,
        kind: MANIFEST_KIND,
        sourceInventory: { path: fixture.inventoryPath, sha256: fixture.inventorySha256 },
        images: { ploinkyBox: { digest: DIGEST } },
    });
    fixture.writeManifest = (value = fixture.manifest(), name = 'standard-release.json') => {
        const manifestPath = path.join(evidence, name);
        fs.writeFileSync(manifestPath, JSON.stringify(value));
        return manifestPath;
    };
    fixture.writeInventory();
    return fixture;
}

function mutated(fixture, change) {
    const inventory = structuredClone(fixture.inventory);
    change(inventory);
    return inventory;
}

function rejectsInventory(fixture, inventory, expected, message) {
    fixture.writeInventory(inventory);
    assert.throws(() => verifyReleaseBundle(fixture.manifest()), expected, message);
}

test('the verifier accepts a complete current inventory and retains every source entry', (t) => {
    const fixture = createFixture(t);
    const result = verifyReleaseBundle(fixture.manifest());
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.kind, 'explorer-release-bundle');
    assert.equal(result.imageDigest, DIGEST);
    assert.equal(result.sourceInventorySha256, fixture.inventorySha256);
    assert.deepEqual(Object.keys(result.repositories), [
        'OnlyOfficeAgent', 'achillesAgentLib', 'explorer', 'ploinky', 'webmeet',
    ]);
    for (const [name, entry] of Object.entries(fixture.inventory.repositories)) {
        assert.deepEqual(result.repositories[name], {
            name, repositoryPath: entry.root, commit: entry.commit, role: entry.role,
        });
    }
    assert.equal(result.repositories.achillesAgentLib.role, 'provenance-reference');
    assert.ok(CORE_REPOSITORIES.every((name) => Object.hasOwn(result.repositories, name)));
    assert.equal('achillesCLI' in result.repositories, false);
    assert.equal(JSON.stringify(verifyReleaseBundle(fixture.manifest())), JSON.stringify(result), 'order is deterministic');
    const manifestPath = fixture.writeManifest();
    assert.deepEqual(verifyManifestFile(manifestPath), result);
});

test('legacy, versionless, unknown-version and foreign manifests are refused without fallback', (t) => {
    const fixture = createFixture(t);
    const current = fixture.manifest();
    const sha = (character) => character.repeat(40);
    const legacy = {
        repositories: Object.fromEntries(['achillesAgentLib', 'ploinky', 'achillesCLI', 'explorer']
            .map((name, index) => [name, { commit: sha(String(index + 1)) }])),
        images: { ploinkyBox: { digest: DIGEST } },
    };
    assert.throws(() => verifyReleaseBundle(legacy), /versionless legacy release manifests are not accepted/);
    assert.throws(() => verifyReleaseBundle({ ...current, schemaVersion: 2 }), /unsupported release manifest schemaVersion/);
    assert.throws(() => verifyReleaseBundle({ ...current, schemaVersion: '1' }), /unsupported release manifest schemaVersion/);
    assert.throws(() => verifyReleaseBundle({ ...current, kind: 'local-snapshot-v1' }), /kind must be explorer-release-bundle/);
    assert.throws(() => verifyReleaseBundle({ ...current, kind: 'copilot-421' }), /kind must be/);
    assert.throws(() => verifyReleaseBundle({ kind: 'local-snapshot-v1', release: legacy, trees: {} }), /versionless/);
    const withKey = (target, key) => ({ ...target, [key]: 1 });
    assert.throws(() => verifyReleaseBundle(withKey(current, 'repositories')), /release manifest must contain exactly/);
    assert.throws(() => verifyReleaseBundle({ ...current, sourceInventory: withKey(current.sourceInventory, 'extra') }), /sourceInventory must contain exactly/);
    assert.throws(() => verifyReleaseBundle({ ...current, images: withKey(current.images, 'other') }), /images must contain exactly/);
    assert.throws(() => verifyReleaseBundle({ ...current, images: { ploinkyBox: { digest: DIGEST, tag: 'latest' } } }), /image ploinkyBox must contain exactly/);
    for (const digest of ['latest', 'sha256:abc', `sha256:${'A'.repeat(64)}`, `${DIGEST}\n`]) {
        assert.throws(() => verifyReleaseBundle({ ...current, images: { ploinkyBox: { digest } } }), /immutable sha256/);
    }
    assert.throws(() => verifyReleaseBundle({ ...current, sourceInventory: { path: 'relative/inventory.json', sha256: fixture.inventorySha256 } }), /absolute, normalized/);
    assert.throws(() => verifyReleaseBundle({ ...current, sourceInventory: { path: fixture.inventoryPath, sha256: 'ABC' } }), /64-hex/);
    // The unchanged legacy contract still refuses the current manifest, so neither verifier accepts the other's schema.
    assert.throws(() => validateReleaseManifest(current), /release manifest must contain exactly images, repositories/);
    const legacyPath = fixture.writeManifest(legacy, 'legacy.json');
    assert.throws(() => verifyManifestFile(legacyPath), (error) => (
        /versionless legacy release manifests/.test(error.message) && !/Copilot 421/.test(error.message)
    ));
    const currentPath = fixture.writeManifest();
    assert.throws(() => verifyLegacyManifestFile(currentPath), /Copilot 421 release bundle rejected/);
});

test('a truthful source graph without AchillesCLI is rejected by the legacy schema and accepted by the current one', (t) => {
    const fixture = createFixture(t);
    const truthful = {
        repositories: Object.fromEntries(Object.entries(fixture.inventory.repositories)
            .filter(([name]) => CORE_REPOSITORIES.includes(name))
            .map(([name, entry]) => [name, { commit: entry.commit }])),
        images: { ploinkyBox: { digest: DIGEST } },
    };
    assert.throws(() => validateReleaseManifest(truthful), /must contain exactly achillesAgentLib, achillesCLI, explorer, ploinky/);
    assert.doesNotThrow(() => verifyReleaseBundle(fixture.manifest()));
});

test('removing a dependency from the frozen inventory without updating the reviewed hash fails', (t) => {
    const fixture = createFixture(t);
    assert.doesNotThrow(() => verifyReleaseBundle(fixture.manifest()));
    const reducedInventory = mutated(fixture, (inventory) => { delete inventory.repositories.webmeet; });
    const reviewedHash = fixture.inventorySha256;
    fixture.writeInventory(reducedInventory);
    fixture.inventorySha256 = reviewedHash;
    assert.throws(() => verifyReleaseBundle(fixture.manifest()), /SHA-256 does not match the reviewed hash/);
    // Even a reduced inventory with its own new hash keeps all of its own entries: no filtering.
    fixture.writeInventory(reducedInventory);
    const reduced = verifyReleaseBundle(fixture.manifest());
    assert.deepEqual(Object.keys(reduced.repositories), ['OnlyOfficeAgent', 'achillesAgentLib', 'explorer', 'ploinky']);
});

test('a missing core key, malformed entry or invalid role is refused', (t) => {
    const fixture = createFixture(t);
    for (const core of CORE_REPOSITORIES) {
        rejectsInventory(fixture, mutated(fixture, (inventory) => { delete inventory.repositories[core]; }), new RegExp(`core repository ${core}`));
    }
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.extra = true; }), /source inventory must contain exactly/);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.schemaVersion = 2; }), /unsupported source inventory schemaVersion/);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.kind = 'other'; }), /source inventory kind must be/);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.repositories.webmeet.extra = 1; }), /repository webmeet must contain exactly/);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { delete inventory.repositories.webmeet.role; }), /repository webmeet must contain exactly/);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.repositories.webmeet.role = 'latest'; }), /role must be one of/);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.repositories.ploinky.role = 'provenance-reference'; }), /ploinky must be a deployed-source/);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.repositories.explorer.role = 'provenance-reference'; }), /explorer must be a deployed-source/);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.repositories.webmeet.commit = 'master'; }), /exact lowercase 40-hex/);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.repositories.webmeet.root = 'relative/webmeet'; }), /absolute, normalized/);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.repositories['bad name'] = inventory.repositories.webmeet; }), /not a valid identity/);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.repositories.__proto__x = inventory.repositories.webmeet; }), /not a valid identity/);
    assert.throws(() => validateInventory(null), /must be an object/);
});

test('duplicate roots, false CLI aliases and wrong component ownership are refused', (t) => {
    const fixture = createFixture(t);
    rejectsInventory(fixture, mutated(fixture, (inventory) => {
        inventory.repositories.webmeet = { ...inventory.repositories.explorer, role: 'deployed-source' };
    }), /repeats the root of/);
    for (const alias of ['achillesCLI', 'AchillesCLI', 'achilles-cli', 'ACHILLES_CLI', 'achillescli']) {
        rejectsInventory(fixture, mutated(fixture, (inventory) => {
            inventory.repositories[alias] = { ...inventory.repositories.explorer, root: fixture.roots.webmeet };
        }), /must not name an AchillesCLI repository/, alias);
        rejectsInventory(fixture, mutated(fixture, (inventory) => {
            inventory.repositories[alias] = { ...inventory.repositories.webmeet };
        }), /must not name an AchillesCLI repository/, `${alias} even for a distinct checkout`);
    }
    // A key rooted at RoboTeam's directory is not a repository top level.
    rejectsInventory(fixture, mutated(fixture, (inventory) => {
        inventory.repositories.roboTeam = { root: path.join(fixture.roots.explorer, 'roboTeamAgent'), commit: inventory.repositories.explorer.commit, role: 'deployed-source' };
    }), /not its Git top level/);
    for (const [roboTeam, expected] of [
        [{ repository: 'achillesCLI', path: 'roboTeamAgent' }, /RoboTeam is owned by explorer\/roboTeamAgent/],
        [{ repository: 'explorer', path: 'other' }, /RoboTeam is owned by explorer\/roboTeamAgent/],
        [{ repository: 'explorer', path: 'roboTeamAgent', extra: 1 }, /roboTeam must contain exactly path, repository/],
    ]) {
        rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.roboTeam = roboTeam; }), expected);
    }
    // RoboTeam must be a tracked real directory inside the verified Explorer.
    const noRoboTeam = createFixture(t);
    git(noRoboTeam.roots.explorer, 'rm', '-q', '-r', 'roboTeamAgent');
    git(noRoboTeam.roots.explorer, 'commit', '-q', '-m', 'remove');
    noRoboTeam.inventory.repositories.explorer.commit = git(noRoboTeam.roots.explorer, 'rev-parse', 'HEAD');
    rejectsInventory(noRoboTeam, noRoboTeam.inventory, /Explorer does not contain roboTeamAgent/);
    const symlinked = createFixture(t);
    git(symlinked.roots.explorer, 'rm', '-q', '-r', 'roboTeamAgent');
    fs.symlinkSync(path.join(symlinked.roots.explorer, 'explorer'), path.join(symlinked.roots.explorer, 'roboTeamAgent'));
    git(symlinked.roots.explorer, 'add', '-A');
    git(symlinked.roots.explorer, 'commit', '-q', '-m', 'symlink');
    symlinked.inventory.repositories.explorer.commit = git(symlinked.roots.explorer, 'rev-parse', 'HEAD');
    rejectsInventory(symlinked, symlinked.inventory, /roboTeamAgent must be a real directory/);
    const ignoredOnly = createFixture(t);
    fs.writeFileSync(path.join(ignoredOnly.roots.explorer, '.gitignore'), 'roboTeamAgent/\n');
    git(ignoredOnly.roots.explorer, 'rm', '-q', '-r', '--cached', 'roboTeamAgent');
    git(ignoredOnly.roots.explorer, 'add', '-A');
    git(ignoredOnly.roots.explorer, 'commit', '-q', '-m', 'untrack');
    ignoredOnly.inventory.repositories.explorer.commit = git(ignoredOnly.roots.explorer, 'rev-parse', 'HEAD');
    rejectsInventory(ignoredOnly, ignoredOnly.inventory, /unable to inspect the RoboTeam ownership/);
});

test('dirty, untracked, wrong-commit, non-canonical and missing sources are refused', (t) => {
    const fixture = createFixture(t);
    const alias = path.join(fixture.base, 'webmeet-alias');
    fs.symlinkSync(fixture.roots.webmeet, alias);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.repositories.webmeet.root = alias; }), /canonical real path/);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.repositories.webmeet.root = path.join(fixture.sources, 'absent'); }), /unable to resolve webmeet root/);
    rejectsInventory(fixture, mutated(fixture, (inventory) => { inventory.repositories.webmeet.commit = '0'.repeat(40); }), /webmeet installed HEAD does not match the source inventory/);
    fixture.writeInventory();
    assert.doesNotThrow(() => verifyReleaseBundle(fixture.manifest()));
    for (const name of ['ploinky', 'explorer', 'achillesAgentLib', 'webmeet']) {
        const modified = path.join(fixture.roots[name], name === 'explorer' ? 'explorer/manifest.json' : (name === 'ploinky' ? 'package.json' : (name === 'webmeet' ? 'manifest.json' : 'package.json')));
        const original = fs.readFileSync(modified);
        fs.appendFileSync(modified, '\n');
        assert.throws(() => verifyReleaseBundle(fixture.manifest()), new RegExp(`${name} repository has uncommitted or untracked content`), `${name} modified`);
        fs.writeFileSync(modified, original);
        const stray = path.join(fixture.roots[name], 'stray.txt');
        fs.writeFileSync(stray, 'x');
        assert.throws(() => verifyReleaseBundle(fixture.manifest()), new RegExp(`${name} repository has uncommitted or untracked content`), `${name} untracked`);
        fs.rmSync(stray);
        assert.doesNotThrow(() => verifyReleaseBundle(fixture.manifest()), `${name} restored`);
    }
    // Inventory bytes kept inside a source checkout (locally excluded, so the checkout stays clean) are refused.
    const inventoryInsideSource = createFixture(t);
    fs.appendFileSync(path.join(inventoryInsideSource.roots.webmeet, '.git/info/exclude'), 'inventory.json\n');
    const inside = path.join(inventoryInsideSource.roots.webmeet, 'inventory.json');
    const insideBytes = Buffer.from(JSON.stringify(inventoryInsideSource.inventory));
    fs.writeFileSync(inside, insideBytes);
    assert.doesNotThrow(() => verifyReleaseBundle(inventoryInsideSource.manifest()), 'the same graph is accepted from outside the checkout');
    assert.throws(() => verifyReleaseBundle({
        ...inventoryInsideSource.manifest(), sourceInventory: { path: inside, sha256: sha256(insideBytes) },
    }), /source inventory must be stored outside the webmeet source checkout/);
});

test('Ploinky installer and AgentLib delivery metadata are still enforced from the inventory Ploinky root', (t) => {
    const fixture = createFixture(t);
    const rootPackage = path.join(fixture.roots.ploinky, 'package.json');
    const globalPackage = path.join(fixture.roots.ploinky, 'globalDeps/package.json');
    const commit = (name, file, content) => {
        fs.writeFileSync(file, content);
        git(fixture.roots[name], 'add', '-A');
        git(fixture.roots[name], 'commit', '-q', '-m', 'change');
        fixture.inventory.repositories[name].commit = git(fixture.roots[name], 'rev-parse', 'HEAD');
        fixture.writeInventory();
    };
    commit('ploinky', rootPackage, JSON.stringify({ scripts: { postinstall: 'git clone https://example.invalid/x' } }));
    assert.throws(() => verifyReleaseBundle(fixture.manifest()), (error) => (
        /Box dependency installer/.test(error.message) && error.code === 'PLOINKY_EXPLORER_RELEASE_BUNDLE_REJECTED'
        && !/Copilot 421/.test(error.message)
    ));
    commit('ploinky', rootPackage, JSON.stringify({ scripts: { postinstall: LOCKED_ROOT_POSTINSTALL } }));
    assert.doesNotThrow(() => verifyReleaseBundle(fixture.manifest()));
    commit('ploinky', globalPackage, JSON.stringify({ dependencies: { achillesAgentLib: 'git+https://github.com/AssistOS-AI/achillesAgentLib.git' } }));
    assert.throws(() => verifyReleaseBundle(fixture.manifest()), /globalDeps must not declare achillesAgentLib/);
});

test('the bounded reader hashes exactly the parsed bytes and refuses symlinks, aliases and oversize storage', (t) => {
    const fixture = createFixture(t);
    const read = readBoundedJsonWithDigest(fixture.inventoryPath, { label: 'source inventory' });
    assert.equal(read.sha256, sha256(fs.readFileSync(fixture.inventoryPath)));
    assert.deepEqual(read.value, fixture.inventory);
    const link = path.join(fixture.evidence, 'inventory-link.json');
    fs.symlinkSync(fixture.inventoryPath, link);
    assert.throws(() => verifyReleaseBundle({ ...fixture.manifest(), sourceInventory: { path: link, sha256: fixture.inventorySha256 } }), /canonical real path/);
    assert.throws(() => readBoundedJsonWithDigest(link, { label: 'source inventory' }), /single-link regular file/);
    const hardLink = path.join(fixture.evidence, 'inventory-hardlink.json');
    fs.linkSync(fixture.inventoryPath, hardLink);
    assert.throws(() => readBoundedJsonWithDigest(fixture.inventoryPath, { label: 'source inventory' }), /single-link regular file/);
    fs.rmSync(hardLink);
    const oversized = path.join(fixture.evidence, 'oversized.json');
    fs.writeFileSync(oversized, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }));
    assert.throws(() => readBoundedJsonWithDigest(oversized, { label: 'source inventory' }), /exceeds 65536 bytes/);
    assert.throws(() => verifyReleaseBundle({ ...fixture.manifest(), sourceInventory: { path: path.join(fixture.evidence, 'absent.json'), sha256: fixture.inventorySha256 } }), /unable to resolve source inventory path/);
    const manifestLink = path.join(fixture.evidence, 'manifest-link.json');
    fs.symlinkSync(fixture.writeManifest(), manifestLink);
    assert.throws(() => verifyManifestFile(manifestLink), /single-link regular file/);
});

test('the writer validates first, creates a private exclusive file and exposes no subset option', (t) => {
    const fixture = createFixture(t);
    const outputPath = path.join(fixture.evidence, 'cohort-release.json');
    const input = {
        inventoryPath: fixture.inventoryPath,
        expectedInventorySha256: fixture.inventorySha256,
        imageDigest: DIGEST,
        outputPath,
    };
    const written = writeManifestFile(input);
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), fixture.manifest());
    assert.deepEqual(verifyManifestFile(outputPath), written.verified);
    assert.deepEqual(Object.keys(written.verified.repositories), Object.keys(verifyReleaseBundle(fixture.manifest()).repositories));
    const before = fs.readFileSync(outputPath);
    assert.throws(() => writeManifestFile(input), /already exists; the writer never overwrites/);
    assert.deepEqual(fs.readFileSync(outputPath), before, 'an existing artifact is never overwritten');
    const target = path.join(fixture.evidence, 'victim.txt');
    fs.writeFileSync(target, 'keep');
    const linked = path.join(fixture.evidence, 'linked.json');
    fs.symlinkSync(target, linked);
    assert.throws(() => writeManifestFile({ ...input, outputPath: linked }), /already exists; the writer never overwrites/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep', 'a symlink is never followed');
    const dangling = path.join(fixture.evidence, 'dangling.json');
    fs.symlinkSync(path.join(fixture.evidence, 'nowhere.json'), dangling);
    assert.throws(() => writeManifestFile({ ...input, outputPath: dangling }), /already exists; the writer never overwrites/);
    assert.equal(fs.existsSync(path.join(fixture.evidence, 'nowhere.json')), false, 'a dangling symlink is never followed');
    // No subset, filter or extra option exists.
    for (const extra of ['repositories', 'only', 'exclude', 'subset', 'allowDirty']) {
        assert.throws(() => writeManifestFile({ ...input, outputPath: path.join(fixture.evidence, `${extra}.json`), [extra]: ['ploinky'] }), /manifest writer input must contain exactly/);
    }
    const { outputPath: omitted, ...withoutOutput } = input;
    assert.throws(() => writeManifestFile(withoutOutput), /manifest writer input must contain exactly/);
    // Validation precedes any file creation.
    const refused = path.join(fixture.evidence, 'refused.json');
    for (const bad of [
        { expectedInventorySha256: '0'.repeat(64) },
        { imageDigest: 'latest' },
        { inventoryPath: 'relative.json' },
        { outputPath: 'relative.json' },
    ]) {
        assert.throws(() => writeManifestFile({ ...input, outputPath: refused, ...bad }));
    }
    assert.equal(fs.existsSync(refused), false);
    fs.appendFileSync(path.join(fixture.roots.webmeet, 'manifest.json'), '\n');
    assert.throws(() => writeManifestFile({ ...input, outputPath: refused }), /webmeet repository has uncommitted/);
    assert.equal(fs.existsSync(refused), false, 'a dirty source blocks the writer before output exists');
    git(fixture.roots.webmeet, 'checkout', '-q', '--', 'manifest.json');
    assert.throws(() => writeManifestFile({ ...input, outputPath: path.join(fixture.roots.webmeet, 'out.json') }), /must be stored outside the webmeet source checkout/);
    assert.throws(() => writeManifestFile({ ...input, outputPath: path.join(fixture.evidence, 'absent-dir', 'out.json') }), /output directory must exist/);
});

test('command line grammar is exact for verify and write', () => {
    const sha = 'a'.repeat(64);
    assert.deepEqual({ ...parseCommandLine(['verify', '--manifest', '/abs/m.json']) }, { command: 'verify', manifestPath: '/abs/m.json' });
    assert.deepEqual({ ...parseCommandLine(['write', '--inventory', '/abs/i.json', '--inventory-sha256', sha, '--image-digest', DIGEST, '--output', '/abs/o.json']) }, {
        command: 'write', inventoryPath: '/abs/i.json', expectedInventorySha256: sha, imageDigest: DIGEST, outputPath: '/abs/o.json',
    });
    for (const argv of [
        [], ['deploy'], ['verify'], ['verify', '--manifest'], ['verify', '--manifest', '--x'],
        ['verify', '--manifest', '/a', '--manifest', '/b'], ['verify', '--manifest', '/a', '--only', 'ploinky'],
        ['write', '--inventory', '/i', '--inventory-sha256', sha, '--image-digest', DIGEST],
        ['write', '--inventory', '/i', '--inventory-sha256', sha, '--image-digest', DIGEST, '--output', '/o', '--subset', 'x'],
        ['--manifest', '/a'],
    ]) {
        assert.throws(() => parseCommandLine(argv), /Explorer release bundle rejected/, JSON.stringify(argv));
    }
});

test('the CLI writes then verifies a manifest, prints only safe identities and fails closed', (t) => {
    const fixture = createFixture(t);
    const outputPath = path.join(fixture.evidence, 'cli-release.json');
    const run = (...args) => spawnSync(process.execPath, [VERIFIER, ...args], { encoding: 'utf8' });
    const written = run('write', '--inventory', fixture.inventoryPath, '--inventory-sha256', fixture.inventorySha256,
        '--image-digest', DIGEST, '--output', outputPath);
    assert.equal(written.status, 0, written.stderr);
    assert.match(written.stdout, new RegExp(`Explorer release bundle verified \\(${DIGEST}\\); source inventory sha256 ${fixture.inventorySha256}`));
    for (const [name, entry] of Object.entries(fixture.inventory.repositories)) {
        assert.ok(written.stdout.includes(`${name}=${entry.commit} (${entry.role})`));
    }
    assert.equal(written.stdout.includes(fixture.sources), false, 'no source roots are printed');
    assert.equal(written.stderr, '');
    const verified = run('verify', '--manifest', outputPath);
    assert.equal(verified.status, 0, verified.stderr);
    const again = run('write', '--inventory', fixture.inventoryPath, '--inventory-sha256', fixture.inventorySha256,
        '--image-digest', DIGEST, '--output', outputPath);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);
    const legacyPath = fixture.writeManifest({ repositories: {}, images: {} }, 'legacy-cli.json');
    const legacy = run('verify', '--manifest', legacyPath);
    assert.equal(legacy.status, 1);
    assert.match(legacy.stderr, /versionless legacy release manifests are not accepted/);
    // The unchanged legacy CLI does not accept the current manifest either.
    const legacyCli = spawnSync(process.execPath, [LEGACY_VERIFIER, '--manifest', outputPath, '--branch-fallback', 'fail',
        '--require-agentlib-sha', '--require-ploinky-sha', '--require-achillescli-sha', '--require-explorer-sha', '--require-box-digest'], { encoding: 'utf8' });
    assert.equal(legacyCli.status, 1);
    assert.match(legacyCli.stderr, /Copilot 421 release bundle rejected/);
});

test('validateManifest returns only the exact identities and the module is not tied to the legacy schema', () => {
    const validated = validateManifest({
        schemaVersion: 1, kind: MANIFEST_KIND,
        sourceInventory: { path: '/evidence/source-inventory.json', sha256: 'b'.repeat(64) },
        images: { ploinkyBox: { digest: DIGEST } },
    });
    assert.deepEqual({ ...validated }, { inventoryPath: '/evidence/source-inventory.json', inventorySha256: 'b'.repeat(64), imageDigest: DIGEST });
    assert.throws(() => validateManifest('manifest'), /must be an object/);
    assert.throws(() => validateManifest({ schemaVersion: 1 }), /must contain exactly/);
});
