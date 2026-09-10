// Deterministic subprocess for the wrapper contract. This is not a model or native-registration proof.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const moduleAt = (file) => import(pathToFileURL(path.join(process.env.SKILLS_TEST_ALA, file)).href);
const { discoverTaskSkills, discoverAnthropicSkills } = await moduleAt('src/repositories.mjs');
const { readCatalogEnvelope } = await moduleAt('src/skill-catalog.mjs');
const { catalogSelectionPrompt } = await moduleAt('src/anthropic-skills.mjs');
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
const id = get('--session-id'), home = get('--home'), cwd = get('--cwd'), agent = get('--ca');
const catalogPath = get('--skill-catalog');
const prompt = await fs.readFile(get('--taskFile'), 'utf8');
const sessionFile = path.join(home, '.ala/sessions', `${id}.json`);
await fs.mkdir(path.dirname(sessionFile), { recursive: true });
let session;
if (args.includes('--resume-session')) session = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
else {
    session = { version: 1, id, home, workspace: cwd, agent, continuation: { threadId: randomUUID() } };
    await fs.writeFile(sessionFile, JSON.stringify(session));
}
const emit = (event) => process.stderr.write(`@@ALA_EVENT@@${JSON.stringify(event)}\n`);
async function consume() {
    // Match the public CLI's explicit-catalog empty handling before validation.
    const skills = await discoverTaskSkills((await discoverAnthropicSkills(catalogPath)).length ? [catalogPath] : []);
    const envelope = await readCatalogEnvelope(catalogPath, skills);
    const conveyed = catalogSelectionPrompt(skills, prompt);
    const output = {};
    for (const entry of envelope.entries) {
        const dir = path.join(catalogPath, entry.name);
        const descriptor = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
        const marker = descriptor.match(/^DESCRIPTOR=(.+)$/m)?.[1];
        if (marker) assert.ok(!prompt.includes(marker), 'descriptor answer must not be leaked in the task prompt');
        const helper = execFileSync(process.execPath, [path.join(dir, 'helper.mjs')], { encoding: 'utf8', timeout: 5000 }).trim();
        const asset = await fs.readFile(path.join(dir, 'assets/value.txt'), 'utf8');
        assert.ok(!prompt.includes(asset), 'asset answer must not be leaked in the task prompt');
        output[entry.name] = { descriptor: marker, helper, executable: (await fs.stat(path.join(dir, 'helper.mjs'))).mode & 0o111 };
    }
    return { envelope, conveyed, output };
}
const before = await consume();
emit({ type: 'coding-agent-selected', agent, permissionMode: get('--permissions') });
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
const output = JSON.stringify({ before, after: await consume(), session, resumed: args.includes('--resume-session') });
emit({ type: 'coding-agent-final', agent, message: output });
process.stdout.write(output + '\n');
process.stdin.destroy();
