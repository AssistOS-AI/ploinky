import test from 'node:test';
import assert from 'node:assert/strict';
import {
    accessSync,
    constants,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveWebchatCommands } from '../../cli/server/webchat/commandResolver.js';
import { DIRECT_CLI_PATH } from '../../cli/utils/directCli.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

test('Router control handlers dispatch through the direct execution-plane CLI', () => {
    assert.equal(DIRECT_CLI_PATH, path.join(repositoryRoot, 'bin', 'ploinky-local'));
    accessSync(DIRECT_CLI_PATH, constants.X_OK);

    for (const relativePath of [
        'cli/server/handlers/dashboard.js',
        'cli/server/handlers/status.js',
    ]) {
        const source = readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
        assert.match(source, /spawn\(DIRECT_CLI_PATH,/);
        assert.doesNotMatch(source, /spawn\(['"]ploinky['"],/);
    }

    const factorySource = readFileSync(
        path.join(repositoryRoot, 'cli/server/utils/ttyFactories.js'),
        'utf8',
    );
    assert.doesNotMatch(factorySource, /createWebChatTTYFactory|webchat_container_factory_ready/);
    assert.doesNotMatch(factorySource, /command:\s*(?:command|entry)/);

    const ttySource = readFileSync(
        path.join(repositoryRoot, 'cli/server/webchat/tty.js'),
        'utf8',
    );
    assert.doesNotMatch(ttySource, /createTTYFactory|buildExecArgs|safeProcessCwd/);
    assert.doesNotMatch(ttySource, /spawn\(runtime|shellCmd|containerName/);
    const localFactorySource = ttySource.slice(ttySource.indexOf('function createLocalTTYFactory'));
    assert.doesNotMatch(localFactorySource, /shell\s*,\s*\['-lc'|parentShell|fallbackEntry/);
});

test('WebChat host commands use the direct execution-plane CLI', () => {
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'ploinky-direct-cli-'));
    try {
        const agentRoot = path.join(fixtureRoot, 'repo', 'explorer');
        const routingFilePath = path.join(fixtureRoot, 'routing.json');
        mkdirSync(agentRoot, { recursive: true });
        writeFileSync(path.join(agentRoot, 'manifest.json'), JSON.stringify({
            cli: 'node cli.js',
        }));
        writeFileSync(routingFilePath, JSON.stringify({
            static: {
                agent: 'explorer',
                hostPath: agentRoot,
            },
            routes: {
                explorer: {
                    hostPath: agentRoot,
                },
            },
        }));

        const commands = resolveWebchatCommands({
            routingFilePath,
            workdir: 'repo',
            hostWorkdir: fixtureRoot,
            cliArgs: ['--dir=/workspace/repo', '', '--flag=value with spaces'],
        });
        assert.equal(commands.executable, DIRECT_CLI_PATH);
        assert.deepEqual(commands.argv, [
            'cli',
            'explorer',
            '--workdir',
            'repo',
            '--',
            '--dir=/workspace/repo',
            '',
            '--flag=value with spaces',
        ]);
        assert.equal(commands.cwd, fixtureRoot);
        assert.equal(Object.hasOwn(commands, 'container'), false);
        assert.equal(Object.hasOwn(commands, 'host'), false);
    } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
    }
});
