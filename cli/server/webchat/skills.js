export function buildSkillsTree(skills = []) {
    const root = { name: '', path: '', children: new Map(), skills: [] };
    for (const skill of skills) {
        const segments = String(skill?.relativePath || '').split('/').filter(Boolean);
        if (!segments.length) continue;
        let node = root;
        let currentPath = '';
        for (const segment of segments) {
            currentPath = currentPath ? `${currentPath}/${segment}` : segment;
            if (!node.children.has(segment)) {
                node.children.set(segment, { name: segment, path: currentPath, children: new Map(), skills: [] });
            }
            node = node.children.get(segment);
        }
        node.skills.push(skill);
    }
    return root;
}

export function collectNodeSkills(node) {
    const skills = [...(node?.skills || [])];
    for (const child of node?.children?.values?.() || []) skills.push(...collectNodeSkills(child));
    return skills;
}

export function compactFolderNode(startNode) {
    let node = startNode;
    while (node?.skills?.length === 0 && node?.children?.size === 1) {
        const child = node.children.values().next().value;
        if (!child || child.skills.length > 0) break;
        node = child;
    }
    return {
        node,
        label: node !== startNode ? `/${node.path}` : startNode.name,
    };
}

export function getDefaultExpandedPaths(skills = []) {
    const paths = [];
    const visit = (startNode) => {
        const { node } = compactFolderNode(startNode);
        const children = [...node.children.values()];
        if (children.length === 0 && node.skills.length === 1) return;
        paths.push(node.path);
        for (const child of children) visit(child);
    };
    const root = buildSkillsTree(skills);
    for (const node of root.children.values()) visit(node);
    return paths;
}

function isPathInside(relativePath, directory) {
    return relativePath === directory || relativePath.startsWith(`${directory}/`);
}

export function countSkillChanges(originalSkills = [], draftSkills = []) {
    const original = new Map(originalSkills.map((skill) => [skill.name, skill.enabled !== false]));
    return draftSkills.filter((skill) => original.has(skill.name)
        && original.get(skill.name) !== (skill.enabled !== false)).length;
}

export function buildSaveCommands(originalSkills = [], draftSkills = [], folderIntents = new Map()) {
    const original = new Map(originalSkills.map((skill) => [skill.name, skill.enabled !== false]));
    const draft = draftSkills.filter((skill) => original.has(skill.name));
    const singularCommands = draft
        .filter((skill) => original.get(skill.name) !== (skill.enabled !== false))
        .map((skill) => `/skill ${skill.enabled === false ? 'disable' : 'enable'} ${skill.name}`);
    if (!singularCommands.length) return [];

    const simulated = new Map(original);
    const folderCommands = [];
    const intents = folderIntents instanceof Map ? folderIntents.entries() : folderIntents;
    for (const [rawPath, rawEnabled] of intents || []) {
        const directory = String(rawPath || '').trim();
        const enabled = rawEnabled !== false;
        if (!directory) continue;
        const descendants = draft.filter((skill) => isPathInside(skill.relativePath, directory));
        if (!descendants.length || descendants.every((skill) => simulated.get(skill.name) === enabled)) continue;
        folderCommands.push(`/skills ${enabled ? 'enable' : 'disable'} ${directory}`);
        for (const skill of descendants) simulated.set(skill.name, enabled);
    }

    const exceptionCommands = draft
        .filter((skill) => simulated.get(skill.name) !== (skill.enabled !== false))
        .map((skill) => `/skill ${skill.enabled === false ? 'disable' : 'enable'} ${skill.name}`);
    const planned = [...folderCommands, ...exceptionCommands];
    return planned.length <= singularCommands.length ? planned : singularCommands;
}

function cloneSkills(skills) {
    return skills.map((skill) => ({ ...skill }));
}

function folderState(node) {
    const skills = collectNodeSkills(node);
    const enabled = skills.filter((skill) => skill.enabled !== false).length;
    if (enabled === 0) return 'disabled';
    if (enabled === skills.length) return 'enabled';
    return 'mixed';
}

export function createSkillsController({
    sendQuickCommand,
    sendQuickCommands,
    refreshCommandCatalog,
    elements,
    showBanner,
}) {
    const {
        skillsBtn,
        skillsDialog,
        skillsDialogClose,
        skillsTree,
        skillsSaveBtn,
        skillsSaveStatus,
        skillsSummary,
    } = elements;
    const expanded = new Set();
    const folderIntents = new Map();
    let originalSkills = [];
    let draftSkills = [];
    let loading = false;
    let saving = false;

    function changeCount() {
        return countSkillChanges(originalSkills, draftSkills);
    }

    function updateControls() {
        const changes = changeCount();
        const enabled = draftSkills.filter((skill) => skill.enabled !== false).length;
        if (skillsSummary) {
            skillsSummary.textContent = `${draftSkills.length} skill${draftSkills.length === 1 ? '' : 's'} · ${enabled} enabled`;
        }
        if (skillsBtn) skillsBtn.disabled = loading;
        if (skillsSaveBtn) {
            skillsSaveBtn.disabled = loading || saving || changes === 0;
            skillsSaveBtn.textContent = saving ? 'Saving…' : 'Save';
        }
        if (skillsDialogClose) skillsDialogClose.disabled = saving;
        if (skillsSaveStatus) {
            skillsSaveStatus.textContent = saving
                ? 'Applying changes…'
                : (changes ? `${changes} unsaved change${changes === 1 ? '' : 's'}` : 'No unsaved changes');
        }
    }

    function appendCheckbox(row, { checked, mixed = false, label, onChange }) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'wa-skill-checkbox';
        checkbox.checked = checked;
        checkbox.indeterminate = mixed;
        checkbox.disabled = loading || saving;
        checkbox.setAttribute('aria-label', label);
        checkbox.addEventListener('click', (event) => event.stopPropagation());
        checkbox.addEventListener('change', (event) => {
            event.stopPropagation();
            onChange(checkbox.checked);
        });
        row.appendChild(checkbox);
    }

    function setSkillEnabled(name, enabled) {
        const skill = draftSkills.find((candidate) => candidate.name === name);
        if (!skill) return;
        skill.enabled = enabled;
        render();
    }

    function setFolderEnabled(node, enabled) {
        const names = new Set(collectNodeSkills(node).map((skill) => skill.name));
        for (const skill of draftSkills) {
            if (names.has(skill.name)) skill.enabled = enabled;
        }
        for (const path of [...folderIntents.keys()]) {
            if (path === node.path || path.startsWith(`${node.path}/`)) folderIntents.delete(path);
        }
        folderIntents.set(node.path, enabled);
        render();
    }

    function appendSkillRow(container, skill, depth) {
        const row = document.createElement('div');
        row.className = 'wa-skill-tree-row is-skill';
        row.style.setProperty('--skill-depth', String(depth));
        row.setAttribute('role', 'treeitem');
        const spacer = document.createElement('span');
        spacer.className = 'wa-skill-tree-spacer';
        row.appendChild(spacer);
        appendCheckbox(row, {
            checked: skill.enabled !== false,
            label: `${skill.enabled === false ? 'Enable' : 'Disable'} ${skill.displayName}`,
            onChange: (enabled) => setSkillEnabled(skill.name, enabled),
        });
        const label = document.createElement('span');
        label.className = 'wa-skill-tree-label';
        label.textContent = `${skill.displayName} (${skill.type})`;
        row.appendChild(label);
        container.appendChild(row);
    }

    function appendNode(container, startNode, depth) {
        const compacted = compactFolderNode(startNode);
        const node = compacted.node;
        const childNodes = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
        const terminalSingle = childNodes.length === 0 && node.skills.length === 1;
        if (terminalSingle) {
            appendSkillRow(container, node.skills[0], depth);
            return;
        }

        const row = document.createElement('div');
        row.className = 'wa-skill-tree-row is-folder';
        row.style.setProperty('--skill-depth', String(depth));
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-expanded', expanded.has(node.path) ? 'true' : 'false');
        const expand = document.createElement('button');
        expand.type = 'button';
        expand.className = 'wa-skill-tree-expand';
        expand.textContent = expanded.has(node.path) ? '▾' : '▸';
        expand.setAttribute('aria-label', `${expanded.has(node.path) ? 'Collapse' : 'Expand'} ${compacted.label}`);
        const toggleExpanded = () => {
            if (expanded.has(node.path)) expanded.delete(node.path);
            else expanded.add(node.path);
            render();
        };
        expand.addEventListener('click', toggleExpanded);
        row.appendChild(expand);
        const state = folderState(node);
        appendCheckbox(row, {
            checked: state === 'enabled',
            mixed: state === 'mixed',
            label: `${state === 'enabled' ? 'Disable' : 'Enable'} all skills under ${compacted.label}`,
            onChange: (enabled) => setFolderEnabled(node, enabled),
        });
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'wa-skill-tree-folder-label';
        label.textContent = compacted.label;
        label.addEventListener('click', toggleExpanded);
        row.appendChild(label);
        container.appendChild(row);

        if (!expanded.has(node.path)) return;
        const group = document.createElement('div');
        group.className = 'wa-skill-tree-group';
        group.setAttribute('role', 'group');
        for (const skill of node.skills.sort((a, b) => a.name.localeCompare(b.name))) {
            appendSkillRow(group, skill, depth + 1);
        }
        for (const child of childNodes) appendNode(group, child, depth + 1);
        container.appendChild(group);
    }

    function render() {
        updateControls();
        if (!skillsTree) return;
        skillsTree.replaceChildren();
        if (loading && !draftSkills.length) {
            const status = document.createElement('div');
            status.className = 'wa-skills-empty';
            status.textContent = 'Loading skills…';
            skillsTree.appendChild(status);
            return;
        }
        if (!draftSkills.length) {
            const empty = document.createElement('div');
            empty.className = 'wa-skills-empty';
            empty.textContent = 'No registered workspace skills.';
            skillsTree.appendChild(empty);
            return;
        }
        const root = buildSkillsTree(draftSkills);
        for (const node of [...root.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
            appendNode(skillsTree, node, 0);
        }
    }

    function open() {
        if (!skillsDialog) return;
        skillsDialog.hidden = false;
        loading = true;
        folderIntents.clear();
        render();
        if (!sendQuickCommand?.('/skills')) {
            loading = false;
            showBanner('Unable to load workspace skills.', 'err');
            render();
        }
    }

    function close() {
        if (saving) return;
        draftSkills = cloneSkills(originalSkills);
        folderIntents.clear();
        if (skillsDialog) skillsDialog.hidden = true;
    }

    async function save() {
        const commands = buildSaveCommands(originalSkills, draftSkills, folderIntents);
        if (!commands.length || saving) return;
        saving = true;
        render();
        try {
            const accepted = await sendQuickCommands?.([...commands, '/skills']);
            if (!accepted) throw new Error('skill_commands_unavailable');
        } catch (_) {
            saving = false;
            showBanner('Unable to save skill changes.', 'err');
            render();
        }
    }

    function handleState(payload) {
        if (!payload || !Array.isArray(payload.skills)) return;
        if (payload.event === 'error' && payload.error) showBanner(payload.error, 'err');
        if (saving && payload.event !== 'list') return;
        const expandByDefault = loading;
        const completedSave = saving;
        originalSkills = cloneSkills(payload.skills);
        draftSkills = cloneSkills(payload.skills);
        folderIntents.clear();
        if (expandByDefault) {
            expanded.clear();
            for (const folderPath of getDefaultExpandedPaths(draftSkills)) expanded.add(folderPath);
        }
        loading = false;
        saving = false;
        render();
        if (completedSave && typeof refreshCommandCatalog === 'function') {
            Promise.resolve(refreshCommandCatalog()).catch(() => {
                showBanner('Skill state was saved, but command autocomplete could not be refreshed.', 'err');
            });
        }
    }

    skillsBtn?.addEventListener('click', open);
    skillsSaveBtn?.addEventListener('click', save);
    skillsDialogClose?.addEventListener('click', close);
    skillsDialog?.addEventListener('click', (event) => {
        if (event.target === skillsDialog) close();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && skillsDialog && !skillsDialog.hidden) close();
    });

    return { open, close, save, handleState };
}
