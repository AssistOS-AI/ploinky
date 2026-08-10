import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
    prepareLocalAgentlibDevelopment,
    runOuterCli,
} from '../../../ploinky-box/bin/ploinky-box.mjs';
import { readDependencyLock } from '../../../ploinky-box/entrypoint/install-dependencies.mjs';
import {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
} from './nativeHelpers.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const AGENTLIB_SMOKE_EXPORT = 'PLOINKY_LOCAL_AGENTLIB_SMOKE';
const START_TIMEOUT_MS = 16 * 60_000;

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout: START_TIMEOUT_MS,
        ...options,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    return result;
}

function copyAgentlibCheckout(source, destination) {
    fs.cpSync(source, destination, {
        recursive: true,
        filter(target) {
            const relative = path.relative(source, target);
            if (!relative) return true;
            return !relative.split(path.sep).some((part) => part === '.git' || part === 'node_modules');
        },
    });
}

function createEditableAgentlibFixture(root) {
    const checkout = path.join(root, 'node_modules', 'achillesAgentLib');
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    copyAgentlibCheckout(path.join(repositoryRoot, 'node_modules', 'achillesAgentLib'), checkout);
    const entrypoint = path.join(checkout, 'index.mjs');
    fs.appendFileSync(entrypoint, `\nexport const ${AGENTLIB_SMOKE_EXPORT} = 'v1';\n`);
    run('git', ['init', '--initial-branch=smoke', checkout]);
    run('git', ['-C', checkout, 'config', 'user.email', 'smoke@ploinky.invalid']);
    run('git', ['-C', checkout, 'config', 'user.name', 'Ploinky smoke']);
    run('git', ['-C', checkout, 'add', '.']);
    run('git', ['-C', checkout, 'commit', '-m', 'local AgentLib smoke fixture']);
    return { checkout, entrypoint };
}

function setFixtureVersion(entrypoint, from, to) {
    const source = fs.readFileSync(entrypoint, 'utf8');
    const expected = `export const ${AGENTLIB_SMOKE_EXPORT} = '${from}';`;
    assert.equal(source.includes(expected), true);
    fs.writeFileSync(entrypoint, source.replace(
        expected,
        `export const ${AGENTLIB_SMOKE_EXPORT} = '${to}';`,
    ));
}

function inspectCoreAgentlib(harness, containerId) {
    return JSON.parse(execInBox(harness.runner, containerId, [
        '/usr/local/bin/node', '--input-type=module', '-e', [
            "const installed=await import('/opt/ploinky/node_modules/achillesAgentLib/index.mjs');",
            `process.stdout.write(JSON.stringify({smoke:installed.${AGENTLIB_SMOKE_EXPORT}??null}));`,
        ].join(''),
    ]));
}

function exerciseNestedCache(harness, containerId, sha256, expectedVersion) {
    const script = [
        "import assert from 'node:assert/strict';",
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "import {spawnSync} from 'node:child_process';",
        "import {pathToFileURL} from 'node:url';",
        "import {localizeLocalAgentlibCacheInput,resolveLocalAgentlibCacheInput,NPM_INSTALL_ARGS} from '/opt/ploinky/cli/utils/dependencies/dependencyCache.js';",
        "import {mergePackageJson} from '/opt/ploinky/cli/utils/dependencies/dependencyInstaller.js';",
        "const [sha,expected]=process.argv.slice(1);",
        "const sourceRoot='/opt/ploinky/node_modules/.ploinky-local-agentlib';",
        "const cache=path.join('/workspace/.ploinky/local-agentlib-smoke',sha);",
        "fs.rmSync(cache,{recursive:true,force:true});fs.mkdirSync(cache,{recursive:true,mode:0o700});",
        "const env={PLOINKY_LOCAL_AGENTLIB_SHA:sha,PLOINKY_AGENTLIB_REF:`file:${sourceRoot}/${sha}.tgz`};",
        "const input=resolveLocalAgentlibCacheInput(cache,{env,sourceRoot});",
        "const pkg=mergePackageJson({name:'ploinky-local-agentlib-smoke',private:true,dependencies:{},devDependencies:{achillesAgentLib:'file:/tmp/dev-attacker.tgz'},optionalDependencies:{achillesAgentLib:'file:/tmp/optional-attacker.tgz'},peerDependencies:{achillesAgentLib:'*'},peerDependenciesMeta:{achillesAgentLib:{optional:true}},bundledDependencies:['achillesAgentLib']},{dependencies:{achillesAgentLib:'file:/tmp/agent-attacker.tgz'}},{agentlibSpec:input.npmSpec});",
        "assert.equal(pkg.dependencies.achillesAgentLib,input.npmSpec);",
        "for(const key of ['devDependencies','optionalDependencies','peerDependencies'])assert.equal(Object.hasOwn(pkg[key]||{},'achillesAgentLib'),false);",
        "assert.equal(Object.hasOwn(pkg.peerDependenciesMeta||{},'achillesAgentLib'),false);",
        "assert.equal((pkg.bundledDependencies||[]).includes('achillesAgentLib'),false);",
        "const archive=localizeLocalAgentlibCacheInput(input);",
        "const sourceStat=fs.lstatSync(input.sourceArchivePath),cacheStat=fs.lstatSync(archive);",
        "assert.equal(cacheStat.nlink,1);assert.notDeepEqual([cacheStat.dev,cacheStat.ino],[sourceStat.dev,sourceStat.ino]);",
        "fs.writeFileSync(path.join(cache,'package.json'),JSON.stringify(pkg));",
        "const installed=spawnSync('npm',NPM_INSTALL_ARGS,{cwd:cache,encoding:'utf8',timeout:600000});",
        "assert.equal(installed.error,undefined,installed.error?.message);assert.equal(installed.status,0,installed.stderr);",
        "const module=await import(pathToFileURL(path.join(cache,'node_modules/achillesAgentLib/index.mjs')).href);",
        `assert.equal(module.${AGENTLIB_SMOKE_EXPORT},expected);`,
        "process.stdout.write(JSON.stringify({sha,expected,npmSpec:input.npmSpec,cacheArchive:path.relative(cache,archive)}));",
    ].join('');
    return JSON.parse(execInBox(harness.runner, containerId, [
        '/usr/local/bin/node', '--input-type=module', '-e', script, sha256, expectedVersion,
    ], { timeoutMs: 12 * 60_000 }));
}

test('real Podman smoke installs two local AgentLib snapshots into core and a nested cache, then restores the lock', {
    timeout: 40 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;

    const observedStarts = [];
    let harness;
    const startCore = async (_engine, containerId, _coreArgs, _hostPort, _mediaPort, _runner, options) => {
        const localSha = String(options.localAgentlibSha || '');
        const core = inspectCoreAgentlib(harness, containerId);
        if (localSha) {
            const expected = observedStarts.length === 0 ? 'v1' : 'v2';
            assert.equal(core.smoke, expected);
            const nested = exerciseNestedCache(harness, containerId, localSha, expected);
            assert.equal(nested.sha, localSha);
            assert.equal(nested.expected, expected);
            assert.equal(nested.npmSpec, `file:./.ploinky-inputs/achillesAgentLib-${localSha}.tgz`);
            observedStarts.push({ mode: 'local', sha256: localSha, core, nested });
            return;
        }
        assert.equal(core.smoke, null);
        const identity = execInBox(harness.runner, containerId, [
            '/usr/local/bin/node',
            '/opt/ploinky/ploinky-box/entrypoint/install-dependencies.mjs',
            '--print-agentlib-identity',
        ]);
        observedStarts.push({ mode: 'locked', identity, core });
    };
    harness = createPodmanHarness(t, candidateReference, {
        removeRootAfterCleanup: true,
        supervisorEnv: { PLOINKY_BOX_IMAGE: candidateReference },
        supervisorOverrides: {
            startCore,
            healthCheck: async () => undefined,
        },
    });
    const fixtureRoot = path.join(harness.root, 'editable-ploinky');
    const fixture = createEditableAgentlibFixture(fixtureRoot);
    const preparedSnapshots = [];
    const prepareLocalAgentlib = (options) => {
        const snapshot = prepareLocalAgentlibDevelopment(options);
        preparedSnapshots.push(snapshot);
        return snapshot;
    };
    const runStart = (env) => runOuterCli(['start', 'local-agentlib-smoke'], {
        env,
        supervisor: harness.supervisor,
        repositoryRoot: fixtureRoot,
        detectInsideBox: () => false,
        prepareLocalAgentlib,
        input: { isTTY: false },
        output: harness.output,
        errorOutput: harness.output,
    });

    assert.equal(await runStart({}), 0);
    assert.equal(observedStarts.length, 1);
    assert.equal(observedStarts[0].mode, 'local');
    assert.equal(fs.existsSync(preparedSnapshots[0].tempArchivePath), false,
        'host snapshot must be cleaned after the bounded start');

    setFixtureVersion(fixture.entrypoint, 'v1', 'v2');
    assert.equal(await runStart({}), 0);
    assert.equal(observedStarts.length, 2);
    assert.equal(observedStarts[1].mode, 'local');
    assert.notEqual(observedStarts[1].sha256, observedStarts[0].sha256);
    assert.equal(fs.existsSync(preparedSnapshots[1].tempArchivePath), false,
        'rebuilt host snapshot must also be cleaned');

    fs.renameSync(fixture.checkout, `${fixture.checkout}.unavailable`);
    assert.equal(await runStart({ PLOINKY_PROD: 'true' }), 0,
        'production mode must not inspect or package the local checkout');
    assert.equal(preparedSnapshots.length, 2);
    assert.equal(observedStarts.length, 3);
    assert.deepEqual(observedStarts[2], {
        mode: 'locked',
        identity: readDependencyLock().repositories.achillesAgentLib.commit,
        core: { smoke: null },
    });

    const published = fs.readdirSync(path.join(
        harness.identity.dataPaths.dependencies,
        '.ploinky-local-agentlib',
    )).sort();
    assert.deepEqual(published, observedStarts.slice(0, 2)
        .map(({ sha256 }) => `${sha256}.tgz`).sort());
});
