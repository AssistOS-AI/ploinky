import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const roots = {};
for (const name of ['achilles', 'ala', 'ploinky', 'explorer']) {
    const value = process.env[`SKILLS_TEST_${name.toUpperCase()}`];
    if (!value || !path.isAbsolute(value)) throw new Error(`Set SKILLS_TEST_${name.toUpperCase()} to the absolute ${name} source directory.`);
    roots[name] = await fs.realpath(value);
}
if (process.platform !== 'linux') throw new Error('Run this acceptance test on Linux. RobotStore locks require /proc process identity. See README.md.');

export const source = (repo, file) => import(pathToFileURL(path.join(roots[repo], file)).href);
export const { RobotStore } = await source('achilles', 'roboTeamAgent/server/robot-store.mjs');
export const { RobotSkillsets } = await source('achilles', 'roboTeamAgent/server/robot-skillsets.mjs');
export const { RuntimeManager } = await source('achilles', 'roboTeamAgent/server/runtime-manager.mjs');
export const { ConversationSessionStore } = await source('achilles', 'roboTeamAgent/copilot/src/lib/conversationSessionStore.mjs');
export const { createRobotSkillCatalog } = await source('achilles', 'roboTeamAgent/copilot/src/lib/robotSkillCatalog.mjs');
export const { createAlaEngine } = await source('achilles', 'roboTeamAgent/copilot/src/lib/alaEngine.mjs');
export const { skillCatalogRequest } = await source('achilles', 'roboTeamAgent/server/skill-catalog-api.mjs');
export const { buildHostSkillScope, buildLocalSkillScope } = await source('ploinky', 'ploinky-box/skillScope.mjs');
export const { syncManagedSkillExports: exportPloinky } = await source('ploinky', 'cli/utils/skills/managedExports.js');
export const { syncManagedSkillExports: exportExplorer } = await source('explorer', 'explorer/utils/server/managed-skill-exports.mjs');
export const { createCopilotController } = await source('explorer', 'explorer/web-components/modals/settings-modal/settings-copilot-controller.js');

export const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
};
export async function waitFor(predicate, label, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error(`Timed out waiting for ${label}`);
}
export async function write(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
}
export async function writeSkill(directory, name, { descriptor = randomUUID(), helper = randomUUID(), asset = randomUUID() } = {}) {
    await write(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Produce the acceptance result by reading this skill.\n---\nDESCRIPTOR=${descriptor}\nRun helper.mjs with Node and report its output.\n`);
    await write(path.join(directory, 'helper.mjs'), `import fs from 'node:fs';\nconsole.log(${JSON.stringify(helper)} + ':' + fs.readFileSync(new URL('./assets/value.txt', import.meta.url), 'utf8'));\n`);
    await write(path.join(directory, 'assets/value.txt'), asset);
    return { descriptor, helper, asset };
}
export async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-acceptance-'));
    const workspaceRoot = path.join(root, 'workspace');
    const scopeRoot = path.join(workspaceRoot, 'launch');
    const sibling = path.join(workspaceRoot, 'sibling');
    await fs.mkdir(scopeRoot, { recursive: true });
    await fs.mkdir(sibling);
    const host = buildHostSkillScope(workspaceRoot, scopeRoot);
    assert.equal(host.PLOINKY_SKILL_SCOPE, '/workspace/launch');
    // Translate the container workspace back to this disposable filesystem.
    const local = buildLocalSkillScope(workspaceRoot, workspaceRoot, {
        ...host, PLOINKY_SKILL_SCOPE: path.join(workspaceRoot, path.posix.relative('/workspace', host.PLOINKY_SKILL_SCOPE)),
    });
    const store = new RobotStore({ dataDir: path.join(root, 'private') });
    const robot = await store.create({ name: 'acceptance' });
    const home = path.join(store.robotPath(robot.id), 'home');
    const privateRoot = path.join(store.robotPath(robot.id), 'copilot');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(privateRoot, { recursive: true });
    const env = { PLOINKY_WORKSPACE_ROOT: workspaceRoot, ROBOTEAM_COPILOT_ROOT: privateRoot, ACHILLES_ALA_HOME: home };
    const old = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    const service = new RobotSkillsets({ robotStore: store, workspaceRoot, scopeRoot: local.PLOINKY_SKILL_SCOPE,
        alaCommand: path.join(roots.ala, 'bin/ala.mjs') });
    const sessionStore = new ConversationSessionStore({ workingDir: scopeRoot });
    const session = await sessionStore.createSession();
    const id = session.sessionId;
    await service.policies.ensure(robot, id, { input: { skillSets: ['workspace'] } });
    const catalog = createRobotSkillCatalog({ context: { store, robot, skillsets: service }, sessionStore,
        workingDir: scopeRoot, initialSessionId: id });
    await catalog.refresh(id);
    const cleanup = [];
    t.after(async () => {
        const failures = [];
        for (const close of cleanup.reverse()) {
            try { await close(); } catch (error) { failures.push(error); }
        }
        for (const [key, value] of Object.entries(old)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        await fs.rm(root, { recursive: true, force: true });
        if (failures.length) throw new AggregateError(failures, 'Acceptance fixture cleanup failed');
    });
    const request = async (input = {}, mutate = false) => skillCatalogRequest({ skillsets: service,
        robot: await store.get(robot.id), input: { sessionId: id, ...input }, mutate });
    const capture = async () => {
        const result = await catalog.refresh(id, { execution: true });
        cleanup.push(result.release);
        return result;
    };
    return { root, workspaceRoot, scopeRoot, sibling, home, store, robot, id, service, sessionStore, catalog, cleanup, request, capture };
}
