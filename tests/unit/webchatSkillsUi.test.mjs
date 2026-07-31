import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildSaveCommands,
    buildSkillsTree,
    compactFolderNode,
    collectNodeSkills,
    countSkillChanges,
    createSkillsController,
    getDefaultExpandedPaths,
} from '../../cli/server/webchat/skills.js';

const skills = [
    { name: 'alpha-cskill', displayName: 'alpha', relativePath: 'packages/tools/alpha', type: 'cskill', enabled: true },
    { name: 'beta-orchestrator', displayName: 'beta', relativePath: 'packages/tools/beta', type: 'oskill', enabled: false },
    { name: 'gamma-cskill', displayName: 'gamma', relativePath: 'skills/gamma', type: 'cskill', enabled: false },
];

test('skills tree contains only branches leading to terminal skill directories', () => {
    const root = buildSkillsTree(skills);
    assert.deepEqual([...root.children.keys()], ['packages', 'skills']);
    const tools = root.children.get('packages').children.get('tools');
    assert.deepEqual([...tools.children.keys()], ['alpha', 'beta']);
    assert.deepEqual(collectNodeSkills(tools).map((skill) => skill.name), [
        'alpha-cskill',
        'beta-orchestrator',
    ]);
});

test('directory-only chains collapse into one path before the skill leaf', () => {
    const root = buildSkillsTree([{
        name: 'skill-name-cskill',
        displayName: 'skill-name',
        relativePath: 'example/path/skill-name',
        type: 'cskill',
        enabled: true,
    }]);
    const compacted = compactFolderNode(root.children.get('example'));
    assert.equal(compacted.label, '/example/path');
    assert.equal(compacted.node.path, 'example/path');
    assert.deepEqual([...compacted.node.children.keys()], ['skill-name']);
    assert.deepEqual(getDefaultExpandedPaths([{
        name: 'skill-name-cskill',
        displayName: 'skill-name',
        relativePath: 'example/path/skill-name',
        type: 'cskill',
        enabled: true,
    }]), ['example/path']);
});

test('an individual draft change is saved with the singular canonical-name command', () => {
    const draft = skills.map((skill) => ({ ...skill }));
    draft[0].enabled = false;
    assert.equal(countSkillChanges(skills, draft), 1);
    assert.deepEqual(buildSaveCommands(skills, draft), ['/skill disable alpha-cskill']);
});

test('a folder draft change is compressed to the plural relative-directory command', () => {
    const original = [
        { ...skills[0], enabled: true },
        { ...skills[1], enabled: true },
        { ...skills[2], name: 'delta-cskill', relativePath: 'packages/tools/delta', enabled: true },
    ];
    const draft = original.map((skill) => ({ ...skill, enabled: false }));
    const intents = new Map([['packages', false]]);
    assert.deepEqual(buildSaveCommands(original, draft, intents), ['/skills disable packages']);
});

test('folder commands run before singular exceptions and are used only when compact', () => {
    const original = [
        { ...skills[0], enabled: true },
        { ...skills[1], enabled: true },
        { ...skills[2], name: 'delta-cskill', relativePath: 'packages/tools/delta', enabled: true },
    ];
    const draft = original.map((skill) => ({ ...skill, enabled: false }));
    draft[2].enabled = true;
    assert.deepEqual(buildSaveCommands(original, draft, new Map([['packages', false]])), [
        '/skills disable packages',
        '/skill enable delta-cskill',
    ]);
});

test('returning the draft to its original state produces no commands', () => {
    assert.equal(countSkillChanges(skills, skills.map((skill) => ({ ...skill }))), 0);
    assert.deepEqual(buildSaveCommands(skills, skills, new Map([['packages', false]])), []);
});

class FakeElement {
    constructor() {
        this.children = [];
        this.listeners = new Map();
        this.style = { setProperty() {} };
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.indeterminate = false;
        this.className = '';
        this.textContent = '';
    }

    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = [...children]; }
    setAttribute() {}
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    dispatch(type) { this.listeners.get(type)?.({ target: this, stopPropagation() {} }); }
}

function findByClass(root, className) {
    if (root.className === className) return root;
    for (const child of root.children || []) {
        const match = findByClass(child, className);
        if (match) return match;
    }
    return null;
}

test('checkbox changes remain local until Save sends the ordered command batch', async (t) => {
    const previousDocument = globalThis.document;
    globalThis.document = {
        createElement: () => new FakeElement(),
        addEventListener() {},
    };
    t.after(() => { globalThis.document = previousDocument; });

    const elements = {
        skillsBtn: new FakeElement(),
        skillsDialog: new FakeElement(),
        skillsDialogClose: new FakeElement(),
        skillsTree: new FakeElement(),
        skillsSaveBtn: new FakeElement(),
        skillsSaveStatus: new FakeElement(),
        skillsSummary: new FakeElement(),
    };
    const quickCommands = [];
    const batches = [];
    const controller = createSkillsController({
        sendQuickCommand: (command) => { quickCommands.push(command); return true; },
        sendQuickCommands: async (commands) => { batches.push(commands); return true; },
        elements,
        showBanner() {},
    });
    controller.open();
    assert.deepEqual(quickCommands, ['/skills']);
    controller.handleState({ event: 'list', skills });
    assert.equal(elements.skillsSummary.textContent, '3 skills · 1 enabled');

    const folderCheckbox = findByClass(elements.skillsTree, 'wa-skill-checkbox');
    assert.ok(folderCheckbox);
    folderCheckbox.checked = true;
    folderCheckbox.dispatch('change');
    assert.deepEqual(quickCommands, ['/skills']);
    assert.deepEqual(batches, []);
    assert.equal(elements.skillsSaveBtn.disabled, false);
    assert.equal(elements.skillsSummary.textContent, '3 skills · 2 enabled');

    await controller.save();
    assert.deepEqual(batches, [[
        '/skills enable packages/tools',
        '/skills',
    ]]);
    controller.handleState({ event: 'list', skills: skills.map((skill) => (
        skill.relativePath.startsWith('packages/') ? { ...skill, enabled: true } : skill
    )) });
    assert.equal(elements.skillsSaveBtn.disabled, true);
    assert.equal(elements.skillsSaveStatus.textContent, 'No unsaved changes');
});
