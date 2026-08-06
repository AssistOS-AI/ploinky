import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const OUTER_CONTROLLER_FILES = Object.freeze([
    'ploinky-box/bin/ploinky-box.mjs',
    'ploinky-box/command/execute.mjs',
    'ploinky-box/contract/container.mjs',
    'ploinky-box/contract/image.mjs',
    'ploinky-box/contract/release.mjs',
    'ploinky-box/edgeDesired.mjs',
    'ploinky-box/engine/discovery.mjs',
    'ploinky-box/engine/libpodClient.mjs',
    'ploinky-box/lifecycle/container.mjs',
    'ploinky-box/lifecycle/outerJournal.mjs',
    'ploinky-box/lifecycle/transactions.mjs',
    'ploinky-box/supervisor.mjs',
    'ploinky-box/volumes.mjs',
]);

const FORBIDDEN_ORDINARY_CONTAINER_SUBCOMMAND = new RegExp(
    String.raw`['"]container['"]\s*,\s*['"](?:create|inspect|start|stop|rm|restart|kill|wait|logs|exec|cp)['"]`,
    'g',
);

const FORBIDDEN_RUN_REMOVE = new RegExp(
    String.raw`['"]run['"][\s\S]{0,512}['"]--rm['"]`,
    'g',
);

const FORBIDDEN_RUNNER_CONTAINER_CONTROL = new RegExp(
    String.raw`runner\.(?:query|run|stream|pipe)\([\s\S]{0,512}\[(?:[\s\S]{0,128})['"](?:container|run|inspect|start|stop|rm|restart|kill|wait|logs|exec|cp)['"]`,
    'g',
);

test('outer Box controller contains no ordinary host container CLI lifecycle or control shapes', () => {
    const violations = [];
    for (const relativePath of OUTER_CONTROLLER_FILES) {
        const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
        for (const pattern of [
            FORBIDDEN_ORDINARY_CONTAINER_SUBCOMMAND,
            FORBIDDEN_RUN_REMOVE,
            FORBIDDEN_RUNNER_CONTAINER_CONTROL,
        ]) {
            for (const match of source.matchAll(pattern)) {
                violations.push(`${relativePath}: ${match[0].replace(/\s+/g, ' ')}`);
            }
        }
    }
    assert.deepEqual(violations, []);
});

test('the only native discovery CLI inventory is unreachable from the macOS machine path', () => {
    const source = fs.readFileSync(path.join(
        repositoryRoot, 'ploinky-box/engine/discovery.mjs',
    ), 'utf8');
    const darwinDirectReturn = source.indexOf("if (platform === 'darwin') {");
    const nativeInventoryCall = source.indexOf(
        'const podmanInventory = inspectNativePodmanResources(podman, identity, runner);',
    );
    assert.ok(darwinDirectReturn >= 0);
    assert.ok(nativeInventoryCall > darwinDirectReturn);
    assert.match(source, /'container', 'ls', '--all', '--sync=false'/u);
    assert.equal((source.match(/'container', 'ls'/gu) || []).length, 1);
    assert.equal((source.match(/'volume', 'inspect'/gu) || []).length, 1);
});

test('static guard excludes local Linux/in-Box lifecycle modules from the host transport policy', () => {
    assert.equal(OUTER_CONTROLLER_FILES.some((file) => file.startsWith('cli/sandbox/')), false);
    assert.equal(OUTER_CONTROLLER_FILES.some((file) => file.startsWith('ploinky-box/inbox/')), false);
});
