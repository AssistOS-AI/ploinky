import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROBOT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const RUN_ID = /^conversation-skills-\d+-[a-f0-9]{8}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function settingsCleanupBudget(runtimeSource) {
    const matches = [...runtimeSource.matchAll(/^const STREAM_RECONNECT_GRACE_MS = (\d+);$/gm)];
    assert.equal(matches.length, 1, 'The candidate WebChat reconnect grace must be explicit and unambiguous.');
    const disconnectGraceMs = Number(matches[0][1]);
    assert.ok(Number.isSafeInteger(disconnectGraceMs) && disconnectGraceMs > 0 && disconnectGraceMs <= 300_000,
        'The candidate WebChat reconnect grace exceeds the bounded C3 cleanup allowance.');
    // Allow the disconnect handler and CLI termination to settle; deletion still checks the real live owner.
    return { disconnectGraceMs, disconnectDrainMs: 1_000, cleanupTimeoutMs: disconnectGraceMs + 61_000,
        operationTimeoutMs: disconnectGraceMs + 600_000 };
}

export function settingsPolicyEvidence(catalog, robotName, sessionId = null) {
    assert.equal(catalog.robot, robotName, 'The policy belongs to another robot.');
    assert.equal(catalog.scope, sessionId === null ? 'defaults' : 'conversation');
    assert.equal(catalog.sessionId, sessionId);
    assert.ok(Number.isSafeInteger(catalog.policyVersion) && catalog.policyVersion >= 1);
    // Project only the supported noncredential selection fields, never arbitrary tool response fields.
    const { version, mode, selectors, excludedSkills, excludedSources, excludedNames } = catalog.policy;
    return { policyVersion: catalog.policyVersion,
        policySha256: hash({ version, mode, selectors, excludedSkills, excludedSources, excludedNames }) };
}

export function defaultSettingsEvidence(robot, catalog) {
    assert.equal(robot.name, 'default');
    assert.match(robot.id || '', ROBOT_ID);
    const { id, name, codingAgents, skillsets, skillRepositories, repositories, createdAt, updatedAt } = robot;
    assert.ok(Array.isArray(codingAgents) && Array.isArray(skillsets) && Array.isArray(skillRepositories) && Array.isArray(repositories));
    return { robotId: id, configurationSha256: hash({ id, name, codingAgents, skillsets, skillRepositories, repositories, createdAt, updatedAt }),
        ...settingsPolicyEvidence(catalog, 'default') };
}

export function ownedSettingsLaunchURL(baseURL, { robotId, robotName, runId }) {
    assert.match(robotId || '', ROBOT_ID);
    assert.match(runId || '', RUN_ID);
    assert.equal(robotName, `c3-settings-${runId}`, 'The launch must use the exact newly owned settings robot.');
    const url = new URL('/webchat', baseURL);
    for (const [name, value] of Object.entries({ agent: 'roboTeamAgent', robot: robotName,
        'workspace-dir': runId, 'forward-envelope': '1' })) url.searchParams.set(name, value);
    return url.href;
}

// Injected APIs let offline controls exercise the same ownership and cleanup behavior used by the deployed check.
export function createOwnedSettingsTarget({ runId, repositoryName, workspaceRoot, api }) {
    assert.match(runId || '', RUN_ID);
    assert.match(repositoryName || '', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.notEqual(repositoryName, 'copilot');
    assert.ok(path.isAbsolute(workspaceRoot) && path.resolve(workspaceRoot) === workspaceRoot);
    const robotName = `c3-settings-${runId}`;
    assert.ok(robotName.length <= 80);
    const repositorySource = path.join(workspaceRoot, runId, 'skills-repo');
    const state = { robotCreationAttempted: false, robotCreated: false, registrationAttempted: false,
        registeredRepository: null, repositoryRemovalAttempted: false, robotRemovalAttempted: false,
        robotRemoved: false, cleanup: 'not-started' };
    let proof = null;
    const request = async (input, status) => {
        const result = await api(input);
        assert.equal(result.status, status, `C3 owned target ${input.method || 'GET'} ${input.path} failed.`);
        return result.payload;
    };
    async function robots() {
        const payload = await request({ path: 'api/robots' }, 200);
        assert.ok(Array.isArray(payload.robots), 'Robot inventory must be an array.');
        return payload;
    }
    async function current() {
        assert.ok(proof && state.robotCreated && !state.robotRemovalAttempted, 'The settings robot is not provably owned.');
        const matches = (await robots()).robots.filter(robot => robot.id === proof.robotId || robot.name === robotName);
        assert.equal(matches.length, 1, 'The owned settings robot is missing or ambiguous.');
        const robot = matches[0];
        assert.equal(robot.id, proof.robotId);
        assert.equal(robot.name, robotName);
        assert.equal(robot.createdAt, proof.createdAt, 'The owned robot creation identity changed.');
        assert.deepEqual(robot.codingAgents, ['codex']);
        assert.ok(Array.isArray(robot.repositories));
        return robot;
    }
    function fixtureRepositories(robot) {
        const matches = robot.repositories.filter(repo => repo.id === repositoryName || repo.source === repositorySource);
        assert.ok(matches.length <= 1, 'The owned repository identity is ambiguous.');
        if (matches.length) {
            assert.equal(matches[0].id, repositoryName);
            assert.equal(matches[0].source, repositorySource, 'The owned repository source changed.');
        }
        return matches;
    }
    return {
        state, robots, current,
        identity() { assert.ok(proof, 'The settings robot is not provably owned.'); return { ...proof }; },
        retained() { return { robotName, robotId: proof?.robotId || null, robotCreationAttempted: state.robotCreationAttempted,
            robotRemoved: state.robotRemoved, registeredRepository: state.registeredRepository,
            registrationAttempted: state.registrationAttempted, repositorySource }; },
        async create() {
            assert.equal(state.robotCreationAttempted, false, 'Never retry ambiguous robot creation.');
            const before = await robots();
            assert.equal(before.canAdmin, true, 'Creating the settings robot requires an administrator.');
            assert.ok(!before.robots.some(robot => robot.name === robotName), 'Refuse an existing settings robot name.');
            state.robotCreationAttempted = true;
            const payload = await request({ method: 'POST', path: 'api/robots', body: { name: robotName, codingAgents: ['codex'] } }, 201);
            const robot = payload.robot;
            assert.match(robot?.id || '', ROBOT_ID);
            assert.ok(!before.robots.some(previous => previous.id === robot.id), 'Refuse a preexisting robot ID.');
            assert.equal(robot.name, robotName);
            assert.deepEqual(robot.codingAgents, ['codex']);
            assert.ok(typeof robot.createdAt === 'string' && Number.isFinite(Date.parse(robot.createdAt)));
            proof = { robotId: robot.id, robotName, runId, createdAt: robot.createdAt };
            state.robotCreated = true;
            assert.equal(fixtureRepositories(await current()).length, 0, 'A newly owned robot must have no fixture registration.');
            return { ...proof };
        },
        async register() {
            assert.equal(state.registrationAttempted, false, 'Never retry ambiguous repository registration.');
            assert.equal(fixtureRepositories(await current()).length, 0);
            state.registrationAttempted = true;
            await request({ method: 'POST', path: `api/robots/${proof.robotId}/skillsets`,
                body: { name: repositoryName, source: repositorySource } }, 200);
            state.registeredRepository = repositoryName;
            assert.equal(fixtureRepositories(await current()).length, 1, 'The owned repository registration was not confirmed.');
        },
        async cleanup({ pagesClosed, waitForDisconnect, removeFolder }) {
            state.cleanup = 'failed';
            assert.ok(!state.repositoryRemovalAttempted && !state.robotRemovalAttempted,
                'Never retry ambiguous resource deletion.');
            assert.equal(pagesClosed, true, 'Close the owned settings and chat pages before cleanup.');
            assert.equal(state.robotCreated, true, 'Ambiguous robot creation must retain the fixture.');
            assert.equal(state.registeredRepository, repositoryName, 'Ambiguous registration must retain the fixture.');
            await waitForDisconnect();
            const robot = await current();
            assert.equal(robot.run?.state, 'stopped', 'The owned robot workstation must be stopped.');
            assert.equal(robot.run?.queueDepth, 0, 'The owned robot task queue must be empty.');
            assert.equal(robot.run?.task, null, 'A settings-only robot must have no runtime task.');
            assert.equal(fixtureRepositories(robot).length, 1);
            state.repositoryRemovalAttempted = true;
            await request({ method: 'DELETE', path: `api/robots/${proof.robotId}/skillsets?name=${repositoryName}` }, 200);
            assert.equal(fixtureRepositories(await current()).length, 0, 'Owned repository deletion was not confirmed.');
            state.registeredRepository = null;
            state.robotRemovalAttempted = true;
            const removed = await request({ method: 'POST', path: 'api/control',
                body: { operation: 'robot-delete', robotId: proof.robotId } }, 200);
            assert.equal(removed.deleted, robotName);
            assert.ok(!(await robots()).robots.some(item => item.id === proof.robotId || item.name === robotName),
                'Owned robot deletion was not confirmed.');
            state.robotRemoved = true;
            await removeFolder();
            state.cleanup = 'owned-repository-robot-and-folder-deleted';
        },
    };
}
