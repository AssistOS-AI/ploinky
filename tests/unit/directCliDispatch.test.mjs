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

        const commands = resolveWebchatCommands({ routingFilePath });
        assert.equal(commands.host, `'${DIRECT_CLI_PATH}' cli explorer`);
        assert.doesNotMatch(commands.host, /^ploinky\s/);
    } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
    }
});
