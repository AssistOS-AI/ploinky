// Deterministic stand-in for the native coding backend that the ALA command wraps. This is not a model or a
// native-registration proof. It parses its command line with the real ALA argument parser, records its conversation
// through ALA's real session transcript (the continuation RoboTeam validates), and reads the skills the way a native
// backend sees them: the live links under <cwd>/.agents/skills, reached through the <cwd>/.claude alias as well.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const alaModule = (file) => import(pathToFileURL(path.join(process.env.SKILLS_TEST_ALA, file)).href);
const { parseArguments } = await alaModule('src/arguments.mjs');
const { openSessionState, resolveSessionsRoot } = await alaModule('src/session-state.mjs');
const { createTranscriptRecorder } = await alaModule('src/transcript-recorder.mjs');
// The private directory name belongs to the system under test; never hard-code it here.
const { ACHILLES_PRIVATE_DIRECTORY_NAME } = await import(pathToFileURL(path.join(process.env.SKILLS_TEST_ACHILLES,
    'roboTeamAgent/copilot/src/lib/storage/privateDataRoot.mjs')).href);
const args = process.argv.slice(2);
// ALA no longer accepts skill catalog options; the real parser rejects any unknown option RoboTeam might still forward.
const options = parseArguments(args);
const { sessionId: id, cwd, agent } = options;
assert.deepEqual(options.ignoredPaths, [path.resolve(cwd, ACHILLES_PRIVATE_DIRECTORY_NAME)], 'the private workspace directory must be masked');
assert.ok(options.folders.some((folder) => folder.alias === 'ploinky-runtime'), 'the generic runtime mount must be supplied');
assert.ok(options.controlStdin);
const prompt = await fs.readFile(options.taskFile, 'utf8');
assert.ok(options.turnId && options.userMessageFile, 'RoboTeam must name the turn and its user message');
const userMessage = await fs.readFile(options.userMessageFile, 'utf8');
assert.ok(prompt.includes(userMessage), 'the recorded user message must come from the task prompt');
// ALA records conversations under ALA_SESSIONS, which RoboTeam sets inside its private workspace directory.
const sessionsRoot = resolveSessionsRoot({ env: process.env, cwd });
assert.equal(sessionsRoot, path.join(cwd, ACHILLES_PRIVATE_DIRECTORY_NAME, '.ala'));
const sessionState = await openSessionState({ id, sessionsRoot, resume: Boolean(options.resumeSession) });
const recorder = createTranscriptRecorder(sessionState, options.turnId);
if (!options.resumeSession) await sessionState.save({ agent, continuation: { threadId: randomUUID() } });
// What RoboTeam passed for this turn, beside the transcript's continuation. The test compares it across turns, so a changed
// home, folder or backend is detected.
const session = { id, home: options.home, cwd: options.cwd, backend: agent, sessionsRoot,
    agent: sessionState.record.agent, continuation: sessionState.record.continuation };
await recorder.user(userMessage);
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
        await recorder.user(message.displayText || message.message);
        emit({ type: 'message-accepted', id: message.id, delivery: 'delivered' });
        input.close();
        break;
    }
}
const output = JSON.stringify({ before, after: await consume(), session, resumed: Boolean(options.resumeSession), prompt });
emit({ type: 'coding-agent-final', agent, message: output });
process.stdout.write(output + '\n');
await recorder.finish({ result: output, status: 'completed' });
await sessionState.close();
process.stdin.destroy();
