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
export const { ConversationSessionStore } = await source('achilles', 'roboTeamAgent/copilot/src/lib/storage/conversationSessionStore.mjs');
export const { createRobotSkillCatalog } = await source('achilles', 'roboTeamAgent/copilot/src/lib/skills/robotSkillCatalog.mjs');
export const { createAlaEngine } = await source('achilles', 'roboTeamAgent/copilot/src/lib/execution/alaEngine.mjs');
export const { registerProject } = await source('achilles', 'roboTeamAgent/server/project-storage.mjs');
export const { skillCatalogRequest } = await source('achilles', 'roboTeamAgent/server/skill-catalog-api.mjs');
export const { createCurrentSessionEnvelope } = await source('achilles', 'roboTeamAgent/copilot/src/lib/webchat/webchatSessionState.mjs');
export const { buildHostSkillScope, buildLocalSkillScope } = await source('ploinky', 'ploinky-box/skillScope.mjs');
export const { syncManagedSkillExports: exportPloinky } = await source('ploinky', 'cli/utils/skills/managedExports.js');
export const { installRepositoryLinks, removeRepositoryLinks } = await source('ploinky', 'cli/utils/repositoryInstall.mjs');
export const { syncManagedSkillExports: exportExplorer } = await source('explorer', 'explorer/utils/server/managed-skill-exports.mjs');

// RoboTeam declares the conversation-skill tools in its MCP manifest. Each manifest entry names the command serving the
// tool, and tools/copilot-catalog.mjs passes `mutate` to skillCatalogRequest only for `--set-skill`.
const toolDeclarations = JSON.parse(await fs.readFile(path.join(roots.achilles, 'roboTeamAgent/mcp-config.json'), 'utf8')).tools;
const toolEntry = await fs.readFile(path.join(roots.achilles, 'roboTeamAgent/tools/copilot-catalog.mjs'), 'utf8');
const isType = { string: (v) => typeof v === 'string', boolean: (v) => typeof v === 'boolean', number: (v) => typeof v === 'number' };
// The process behind each tool resolves its robot store from the fixed /data volume, so it cannot be spawned against a
// temporary directory. This caller resolves the tool as the manifest declares it, rejects any input the declared schema
// would reject, and invokes the same skillCatalogRequest that the tool entry point calls.
export function declaredToolCall(name) {
    const tool = toolDeclarations.find((entry) => entry.name === name);
    assert.ok(tool, `RoboTeam must declare the ${name} tool`);
    assert.equal(tool.command, 'node');
    assert.equal(tool.args[0], 'tools/copilot-catalog.mjs');
    const mutate = tool.args.includes('--set-skill');
    assert.deepEqual(tool.args.slice(1), [mutate ? '--set-skill' : '--skills']);
    assert.ok(toolEntry.includes('skillCatalogRequest({') && toolEntry.includes("mutate: process.argv.includes('--set-skill')"),
        'tools/copilot-catalog.mjs must pass the --set-skill flag to skillCatalogRequest as mutate');
    return { mutate, validate(input) {
        for (const key of Object.keys(input)) assert.ok(tool.inputSchema[key], `${name} declares no ${key} input`);
        for (const [key, rule] of Object.entries(tool.inputSchema)) {
            if (input[key] === undefined) assert.ok(rule.optional, `${name} requires ${key}`);
            else assert.ok(isType[rule.type](input[key]), `${name} input ${key} must be a ${rule.type}`);
        }
    } };
}

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
    // The Box mounts the workspace at its own path, so the host scope needs no translation.
    assert.equal(host.PLOINKY_SKILL_SCOPE, scopeRoot);
    const local = buildLocalSkillScope(workspaceRoot, workspaceRoot, host);
    const store = new RobotStore({ dataDir: path.join(workspaceRoot, '.data/roboTeamAgent') });
    const robot = await store.create({ name: 'acceptance', codingAgents: ['codex'] });
    const home = path.join(store.robotPath(robot.id), 'home');
    const privateRoot = path.join(store.robotPath(robot.id), 'copilot');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(privateRoot, { recursive: true });
    const env = { PLOINKY_WORKSPACE_ROOT: workspaceRoot, ROBOTEAM_COPILOT_ROOT: privateRoot, ACHILLES_ALA_HOME: home };
    const old = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);

    // RoboTeam resolves skills only from repositories that Ploinky knows, and every robot always receives the required
    // human-report skill from the DocumentationSkills repository. Ploinky alone publishes the .agents/skills links, so
    // the repository client runs Ploinky's real link installer against this temporary workspace.
    const documentation = path.join(workspaceRoot, 'DocumentationSkills');
    const required = await writeSkill(path.join(documentation, 'skills/human-report'), 'human-report');
    const repositories = [{ name: 'DocumentationSkills', source: documentation, origin: 'workspace' }];
    const installs = { count: 0, removals: 0 };
    const resolveRepository = (name) => repositories.find((repository) => repository.name === name);
    const options = { workspaceRoot, resolveRepository };
    const client = {
        listRepositories: async () => repositories.map((repository) => ({ ...repository })),
        install: async (input) => { installs.count += 1; return installRepositoryLinks(input, options); },
        remove: async (paths) => { installs.removals += 1; return removeRepositoryLinks(paths, options); },
        prepareRepository: async () => { throw new Error('The acceptance workspace never downloads repositories'); },
    };
    const service = new RobotSkillsets({ robotStore: store, workspaceRoot, scopeRoot: local.PLOINKY_SKILL_SCOPE,
        alaCommand: path.join(roots.ala, 'bin/ala.mjs'), repositoriesClient: client });
    // The conversation runtime registers its working folder, which is how the tools find a saved conversation.
    registerProject({ dataDir: store.dataDir, workspaceRoot }, scopeRoot);
    const sessionStore = new ConversationSessionStore({ workingDir: scopeRoot });
    const session = await sessionStore.createSession();
    const id = session.sessionId;
    const catalog = createRobotSkillCatalog({ context: { store, robot, skillsets: service }, sessionStore,
        workingDir: scopeRoot, initialSessionId: id });
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

    // Register a local directory as a repository on the robot (the administrator action the Marketplace performs). The
    // robot then reads its skills live, and Ploinky knows it as a workspace repository that may be linked.
    const register = async (name, directory) => {
        const record = await service.add(robot.id, { name, source: directory });
        repositories.push({ name, source: record.source, origin: 'workspace' });
        return record;
    };
    // Register the named sources and create this conversation's policy the way a task start does: selecting whole
    // sources, or an explicit selection such as the empty one.
    const useSources = async (sources, selection = { skillSets: Object.keys(sources) }) => {
        for (const [name, directory] of Object.entries(sources)) await register(name, directory);
        await service.policies.ensure(await store.get(robot.id), id, { input: selection, useDefaults: false });
        await catalog.refresh(id);
    };

    const callTool = async (name, input) => {
        const declared = declaredToolCall(name);
        declared.validate(input);
        return skillCatalogRequest({ skillsets: service, robot: await store.get(robot.id), input, mutate: declared.mutate });
    };
    // The WebChat conversation-settings action carries the robot and saved session identity to the settings surface,
    // which sends the declared tool inputs with exactly that context.
    const settingsAction = () => {
        const action = createCurrentSessionEnvelope(sessionStore.loadSession(id), { robot: robot.name }).settingsAction;
        assert.equal(action?.label, 'Conversation skills');
        const url = new URL(action.href, 'https://workspace.invalid');
        assert.equal(url.pathname, '/explorer/index.html');
        assert.deepEqual([...url.searchParams.keys()].sort(), ['copilot-robot', 'copilot-session']);
        return { robot: url.searchParams.get('copilot-robot'), sessionId: url.searchParams.get('copilot-session') };
    };
    const settings = { context: settingsAction(), policyVersion: null, items: [], scope: null,
        async load(extra = {}) {
            return this.apply(await callTool('list_achilles_skills', { ...this.context, ...extra }));
        },
        apply(catalog) {
            assert.equal(catalog.scope, 'conversation');
            assert.equal(catalog.sessionId, this.context.sessionId);
            assert.ok(Number.isSafeInteger(catalog.policyVersion) && catalog.policyVersion >= 0);
            Object.assign(this, { items: catalog.skills, policyVersion: catalog.policyVersion, scope: catalog.scope });
            return catalog;
        },
        async toggle(identity) {
            const item = this.items.find((entry) => entry.identity === identity);
            assert.ok(item, `${identity} must be in the loaded inventory`);
            return this.apply(await callTool('set_achilles_skill_enabled', { ...this.context, identity,
                enabled: !item.enabled, policyVersion: this.policyVersion }));
        } };
    // Every selection read and change the tests make goes through the declared tool inputs.
    const request = async (input = {}, mutate = false) => callTool(mutate ? 'set_achilles_skill_enabled' : 'list_achilles_skills',
        { robot: robot.name, sessionId: id, ...input });
    // An execution prepares the live links exactly as the engine does at its execution boundary.
    const capture = async () => {
        const result = await catalog.refresh(id, { execution: true });
        cleanup.push(result.release);
        return result;
    };
    return { root, workspaceRoot, scopeRoot, sibling, home, store, robot, id, service, sessionStore, catalog, cleanup, request,
        capture, settings, register, useSources, installs, required, documentation };
}
