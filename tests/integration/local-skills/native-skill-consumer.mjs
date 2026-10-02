// Deterministic stand-in for the native coding backend that the ALA command wraps. This is not a model or a
// native-registration proof. It parses its command line with the real ALA argument parser, keeps the fixture
// continuation metadata that RoboTeam validates, and reads the skills the way a native backend sees them:
// the live links under <cwd>/.agents/skills, reached through the <cwd>/.claude alias as well.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const { parseArguments } = await import(pathToFileURL(path.join(process.env.SKILLS_TEST_ALA, 'src/arguments.mjs')).href);
const args = process.argv.slice(2);
// ALA no longer accepts skill catalog options; the real parser rejects any unknown option RoboTeam might still forward.
const options = parseArguments(args);
const { sessionId: id, home, cwd, agent } = options;
assert.deepEqual(options.ignoredPaths, [path.resolve(cwd, '.achilles-cli')], 'the private workspace directory must be masked');
assert.ok(options.folders.some((folder) => folder.alias === 'ploinky-runtime'), 'the generic runtime mount must be supplied');
assert.ok(options.controlStdin);
const prompt = await fs.readFile(options.taskFile, 'utf8');
const sessionFile = path.join(home, '.ala/sessions', `${id}.json`);
await fs.mkdir(path.dirname(sessionFile), { recursive: true });
let session;
if (options.resumeSession) session = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
else {
    session = { version: 1, id, home, workspace: cwd, agent, continuation: { threadId: randomUUID() } };
    await fs.writeFile(sessionFile, JSON.stringify(session));
}
const emit = (event) => process.stderr.write(`@@ALA_EVENT@@${JSON.stringify(event)}\n`);
async function consume() {
    const skills = path.join(cwd, '.agents/skills');
    const names = (await fs.readdir(skills)).sort();
    assert.deepEqual((await fs.readdir(path.join(cwd, '.claude/skills'))).sort(), names, 'the .claude alias must expose the same skills');
    const output = {};
    for (const name of names) {
        const dir = path.join(skills, name);
        const descriptor = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
        assert.equal(descriptor.match(/^name: (.+)$/m)?.[1], name, 'a skill directory must carry its descriptor name');
        const marker = descriptor.match(/^DESCRIPTOR=(.+)$/m)?.[1];
        if (marker) assert.ok(!prompt.includes(marker), 'descriptor answer must not be leaked in the task prompt');
        const helper = execFileSync(process.execPath, [path.join(dir, 'helper.mjs')], { encoding: 'utf8', timeout: 5000 }).trim();
        const asset = await fs.readFile(path.join(dir, 'assets/value.txt'), 'utf8');
        assert.ok(!prompt.includes(asset), 'asset answer must not be leaked in the task prompt');
        output[name] = { descriptor: marker, helper, executable: (await fs.stat(path.join(dir, 'helper.mjs'))).mode & 0o111,
            link: (await fs.lstat(dir)).isSymbolicLink() ? await fs.realpath(dir) : null };
    }
    return { names, output };
}
const before = await consume();
emit({ type: 'coding-agent-selected', agent, permissionMode: options.permissionMode });
emit({ type: 'session-ready', sessionId: id });
if (prompt.includes('WAIT_FOR_STEERING')) {
    const input = readline.createInterface({ input: process.stdin });
    for await (const line of input) {
        const message = JSON.parse(line);
        emit({ type: 'message-accepted', id: message.id, delivery: 'delivered' });
        input.close();
        break;
    }
}
const output = JSON.stringify({ before, after: await consume(), session, resumed: Boolean(options.resumeSession), prompt });
emit({ type: 'coding-agent-final', agent, message: output });
process.stdout.write(output + '\n');
process.stdin.destroy();
