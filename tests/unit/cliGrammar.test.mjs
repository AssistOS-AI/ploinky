import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseAgentCliArguments } from '../../ploinky-box/command/agent-cli.mjs';
import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { routeOuterCommand } from '../../ploinky-box/command/route.mjs';
import { parseCoreDebugArguments } from '../../cli/main.js';
import {
    buildManifestCliCommand,
    normalizeCliWorkdirForRuntime,
    resolveCliWorkdir,
    runWithSuspendedInput,
    validateCliWorkdir,
} from '../../cli/commands/workspaceUtil.js';

test('agent CLI grammar preserves every provider argv element after the separator', () => {
    const providerArgv = [
        'two words',
        '--debug',
        '--sso-account=person token',
        '',
        'unicode-λ',
        '--workdir',
        '../provider-owned-text',
    ];
    const parsed = parseAgentCliArguments([
        'futureAgent', '--workdir', 'projects/space dir', '--', ...providerArgv,
    ]);

    assert.equal(parsed.agent, 'futureAgent');
    assert.equal(parsed.workdir, 'projects/space dir');
    assert.deepEqual(parsed.providerArgv, providerArgv);
});

test('agent CLI grammar is universal and accepts only one exact pre-separator selector', () => {
    const rejected = [
        { argv: ['agent'], code: 'PLOINKY_WORKDIR_REQUIRED' },
        { argv: ['agent', '--', '--help'], code: 'PLOINKY_WORKDIR_REQUIRED' },
        { argv: ['agent', '--workdir'], code: 'PLOINKY_WORKDIR_REQUIRED' },
        { argv: ['agent', '--workdir', '', '--'], code: 'PLOINKY_WORKDIR_INVALID' },
        { argv: ['agent', '--workdir=/workspace/project', '--'], code: 'PLOINKY_CLI_ARGUMENT_INVALID' },
        { argv: ['agent', '--workdir', 'one', '--workdir', 'two', '--'], code: 'PLOINKY_CLI_ARGUMENT_INVALID' },
        { argv: ['agent', '--workdir', 'one'], code: 'PLOINKY_CLI_SEPARATOR_REQUIRED' },
        { argv: ['agent', 'legacy-project', '--'], code: 'PLOINKY_WORKDIR_REQUIRED' },
        { argv: ['agent', '--workdir', '/workspace', '--'], code: 'PLOINKY_WORKDIR_ROOT_FORBIDDEN' },
        { argv: ['agent', '--workdir', 'one/../two', '--'], code: 'PLOINKY_WORKDIR_INVALID' },
    ];
    for (const { argv, code } of rejected) {
        assert.throws(() => parseAgentCliArguments(argv), { code }, argv.join(' '));
    }
});

test('outer Box validates agent CLI grammar before preparation and forwards exact argv', () => {
    const argv = [
        'cli', 'futureAgent', '--workdir', '/workspace/projects/space dir', '--',
        'two words', '--debug', '--sso-account=person token', '',
    ];
    const parsed = parseOuterArguments(argv);
    const route = routeOuterCommand(parsed);

    assert.equal(parsed.debug.enabled, false);
    assert.equal(route.kind, 'agent-cli');
    assert.deepEqual(route.coreArgv, argv);
    assert.deepEqual(route.agentCli.providerArgv, [
        'two words', '--debug', '--sso-account=person token', '',
    ]);
});

test('core debug parsing consumes only a leading Ploinky flag', () => {
    assert.deepEqual(parseCoreDebugArguments([
        '--debug', 'cli', 'agent', '--workdir', 'project', '--', '--debug', '-d',
    ]), {
        argv: ['cli', 'agent', '--workdir', 'project', '--', '--debug', '-d'],
        enabled: true,
    });
    assert.deepEqual(parseCoreDebugArguments([
        'cli', 'agent', '--workdir', 'project', '--', '--debug', '-d',
    ]), {
        argv: ['cli', 'agent', '--workdir', 'project', '--', '--debug', '-d'],
        enabled: false,
    });
});

test('workdir validation accepts existing real directories and rejects roots, traversal, missing paths, files, and symlinks', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cli-workdir-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'projects', 'space dir'), { recursive: true });
    fs.mkdirSync(path.join(root, '.ploinky', 'repos', 'checked-out-repo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'projects', 'file.txt'), 'not a directory');
    fs.symlinkSync(path.join(root, 'projects', 'space dir'), path.join(root, 'project-link'));
    fs.symlinkSync(os.tmpdir(), path.join(root, 'escape-link'));

    assert.equal(
        validateCliWorkdir('projects/space dir', { workspaceRoot: root }),
        fs.realpathSync(path.join(root, 'projects', 'space dir')),
    );
    assert.equal(
        validateCliWorkdir('/workspace/projects/space dir', { workspaceRoot: root }),
        fs.realpathSync(path.join(root, 'projects', 'space dir')),
    );
    assert.equal(
        validateCliWorkdir('.ploinky/repos/checked-out-repo', { workspaceRoot: root }),
        fs.realpathSync(path.join(root, '.ploinky', 'repos', 'checked-out-repo')),
    );
    for (const alias of ['/workspace//projects/space dir', './projects/space dir', 'projects/space dir/.', 'projects//space dir']) {
        assert.deepEqual(resolveCliWorkdir(alias, { workspaceRoot: root }), {
            canonicalPath: fs.realpathSync(path.join(root, 'projects', 'space dir')),
            canonicalRoot: fs.realpathSync(root),
            relativePath: 'projects/space dir',
            runtimePath: '/workspace/projects/space dir',
        });
    }
    for (const [candidate, code] of [
        ['/workspace', 'PLOINKY_WORKDIR_ROOT_FORBIDDEN'],
        ['/workspace/', 'PLOINKY_WORKDIR_ROOT_FORBIDDEN'],
        ['.', 'PLOINKY_WORKDIR_ROOT_FORBIDDEN'],
        ['projects/../projects/space dir', 'PLOINKY_WORKDIR_INVALID'],
        ['projects/missing', 'PLOINKY_WORKDIR_INVALID'],
        ['projects/file.txt', 'PLOINKY_WORKDIR_INVALID'],
        ['project-link', 'PLOINKY_WORKDIR_INVALID'],
        ['escape-link', 'PLOINKY_WORKDIR_INVALID'],
        ['/tmp/outside', 'PLOINKY_WORKDIR_INVALID'],
        ['.data/provider', 'PLOINKY_WORKDIR_INVALID'],
        ['.ploinky/run/provider', 'PLOINKY_WORKDIR_INVALID'],
    ]) {
        assert.throws(
            () => validateCliWorkdir(candidate, { workspaceRoot: root }),
            { code },
            candidate,
        );
    }
});

test('manifest CLI command shell-quotes provider elements without interpreting SSO-like tokens', () => {
    assert.equal(
        buildManifestCliCommand('node /code/scripts/generic-cli.mjs', [
            'two words', '--debug', "quote'arg", '--sso-token=a b', '',
        ]),
        "node /code/scripts/generic-cli.mjs 'two words' '--debug' 'quote'\\''arg' '--sso-token=a b' ''",
    );
    assert.equal(
        buildManifestCliCommand('node /code/scripts/interactive-cli.mjs', [
            'two words', '--debug', "quote'arg", '--sso-token=a b', '',
        ], { workdir: 'projects/space dir' }),
        "node /code/scripts/interactive-cli.mjs --workdir '/workspace/projects/space dir' -- 'two words' '--debug' 'quote'\\''arg' '--sso-token=a b' ''",
    );
    assert.equal(
        normalizeCliWorkdirForRuntime('/workspace/projects/already-logical'),
        '/workspace/projects/already-logical',
    );
});

test('suspended input remains suspended until an asynchronous attach returns its exact status', async () => {
    const events = [];
    let finishAttach;
    const attach = new Promise((resolve) => { finishAttach = resolve; });
    const running = runWithSuspendedInput(async () => {
        events.push('attach');
        return attach;
    }, {
        prepareForExternalCommand() {
            events.push('suspend');
            return () => events.push('restore');
        },
    });

    await Promise.resolve();
    assert.deepEqual(events, ['suspend', 'attach']);
    finishAttach(143);
    assert.equal(await running, 143);
    assert.deepEqual(events, ['suspend', 'attach', 'restore']);
});
