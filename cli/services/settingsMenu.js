import readline from 'readline';
import { populateProcessEnvFromEnvFile, resolveEnvFilePath } from './llmProviderUtils.js';
import { getSecret } from './secretInjector.js';
import { deleteVar, setEnvVar } from './secretVars.js';
import * as inputState from './inputState.js';

const SOUL_MODELS_URL = 'https://soul.axiologic.dev/v1/models';
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';

const VAR_SPECS = [
    { key: 'ACHILLES_MODEL_PLAN', label: 'Plan model/tag', type: 'model_or_tag' },
    { key: 'ACHILLES_MODEL_CODE', label: 'Code model/tag', type: 'model_or_tag' },
    { key: 'ACHILLES_DEBUG', label: 'Debug logging', type: 'enum', options: ['true', 'false'] },
];

function formatPrice(priceValue) {
    if (priceValue === null || priceValue === undefined || priceValue === '') return '?';
    const asNumber = Number(priceValue);
    if (Number.isFinite(asNumber)) return `$${asNumber}`;
    return String(priceValue);
}

function formatContextWindow(contextWindow) {
    if (contextWindow === null || contextWindow === undefined || contextWindow === '') return 'ctx ?';
    return `ctx ${contextWindow}`;
}

function formatModelOption(entry) {
    const tags = Array.isArray(entry.tags) && entry.tags.length
        ? `tags: ${entry.tags.join(', ')}`
        : 'tags: -';
    if (entry.isFree) {
        return `${entry.name} [${entry.providerKey}] (free, ${formatContextWindow(entry.contextWindow)}, ${tags})`;
    }
    const inPrice = formatPrice(entry.inputPrice);
    const outPrice = formatPrice(entry.outputPrice);
    return `${entry.name} [${entry.providerKey}] (${inPrice}/${outPrice}, ${formatContextWindow(entry.contextWindow)}, ${tags})`;
}

export async function loadSoulModelCatalog() {
    const apiKey = String(getSecret('PLOINKY_AGENT_API_KEY') || '').trim();
    if (!apiKey) {
        return {
            models: [],
            tags: [],
            warning: 'PLOINKY_AGENT_API_KEY is not set. Add it in .secrets or .env to load models.',
        };
    }

    try {
        const response = await fetch(SOUL_MODELS_URL, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
            },
        });

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Soul models request failed (${response.status}): ${body.slice(0, 300)}`);
        }

        const payload = await response.json();
        const rawList = Array.isArray(payload?.data) ? payload.data : [];

        const discoveredModels = rawList
            .filter((entry) => entry && typeof entry === 'object')
            .map((entry) => ({
                name: String(entry.id || '').trim(),
                providerKey: String(entry.provider || entry.owned_by || '').trim() || 'unknown',
                isFree: entry.is_free === true,
                inputPrice: entry.input_price ?? null,
                outputPrice: entry.output_price ?? null,
                contextWindow: entry.context_window ?? entry.max_context_tokens ?? null,
                tags: Array.isArray(entry.tags)
                    ? entry.tags.map((tag) => String(tag || '').trim()).filter(Boolean)
                    : [],
                sortOrder: Number.isFinite(Number(entry.sort_order)) ? Number(entry.sort_order) : 9999,
            }))
            .filter((entry) => Boolean(entry.name));

        discoveredModels.sort((left, right) => {
            if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
            return left.name.localeCompare(right.name);
        });

        const uniqueModels = [];
        const modelSeen = new Set();
        for (const model of discoveredModels) {
            if (modelSeen.has(model.name)) continue;
            modelSeen.add(model.name);
            uniqueModels.push(model);
        }

        const tagSet = new Set();
        for (const model of uniqueModels) {
            for (const tag of model.tags) {
                tagSet.add(tag);
            }
        }

        return {
            models: uniqueModels,
            tags: [...tagSet].sort((a, b) => a.localeCompare(b)),
            warning: uniqueModels.length
                ? null
                : 'Gateway returned 0 models for this API key.',
        };
    } catch (error) {
        return {
            models: [],
            tags: [],
            warning: `Failed to load Soul models: ${error.message}`,
        };
    }
}

function getCurrentValueDisplay(spec) {
    const raw = getSecret(spec.key);
    if (!raw) return 'unset';
    return String(raw).trim() || 'unset';
}

function buildValueOptions(spec, catalog) {
    if (spec.type === 'enum') {
        return [{ value: 'unset', label: 'unset' }, ...spec.options.map((option) => ({ value: option, label: option }))];
    }

    if (spec.type === 'model_or_tag') {
        const modelOptions = (catalog.models || []).map((entry) => ({
            value: entry.name,
            label: formatModelOption(entry),
        }));
        const tagOptions = (catalog.tags || []).map((tag) => ({
            value: tag,
            label: `#${tag} [tag]`,
        }));
        return [{ value: 'unset', label: 'unset' }, ...modelOptions, ...tagOptions];
    }

    return [{ value: 'unset', label: 'unset' }];
}

function applyValue(spec, value) {
    if (value === 'unset') {
        deleteVar(spec.key);
        return;
    }

    setEnvVar(spec.key, value);
}

function createMenuRenderer() {
    const renderState = { rendered: false };

    const clearScreen = () => {
        try { readline.cursorTo(process.stdout, 0, 0); } catch (_) { /* noop */ }
        try { readline.clearScreenDown(process.stdout); } catch (_) { /* noop */ }
    };

    const clear = () => {
        if (!renderState.rendered) return;
        clearScreen();
        renderState.rendered = false;
    };

    const computeVisibleOptionWindow = (totalOptions, selectedIndex, maxVisible) => {
        if (totalOptions <= maxVisible) {
            return { start: 0, end: totalOptions };
        }
        const halfWindow = Math.floor(maxVisible / 2);
        let start = selectedIndex - halfWindow;
        if (start < 0) start = 0;
        let end = start + maxVisible;
        if (end > totalOptions) {
            end = totalOptions;
            start = end - maxVisible;
        }
        return { start, end };
    };

    const render = (state) => {
        clearScreen();

        const lines = [
            '=== Ploinky LLM Settings ===',
            'Arrow Up/Down to navigate, Enter to edit/set, Esc/Backspace to exit.',
            '',
        ];

        if (state.warning) {
            lines.push(`! ${state.warning}`);
            lines.push('');
        }

        state.variables.forEach((entry, idx) => {
            const pointer = idx === state.selectedVar ? '>' : ' ';
            lines.push(`${pointer} ${entry.label}: ${entry.current}`);
        });

        if (state.selectingValue) {
            const totalOptions = state.valueOptions.length;
            lines.push('');

            if (!totalOptions) {
                lines.push('No options available.');
            } else {
                const terminalRows = Number(process.stdout.rows) > 0 ? Number(process.stdout.rows) : 24;
                const reservedRows = 1;
                const availableRows = Math.max(1, terminalRows - lines.length - reservedRows);
                const window = computeVisibleOptionWindow(totalOptions, state.selectedValueIndex, availableRows);

                lines.push(`Options ${window.start + 1}-${window.end} / ${totalOptions}`);
                for (let optionIndex = window.start; optionIndex < window.end; optionIndex += 1) {
                    const option = state.valueOptions[optionIndex];
                    const optionPointer = optionIndex === state.selectedValueIndex ? '>' : ' ';
                    lines.push(`   ${optionPointer} ${option.label}`);
                }
            }
        }

        process.stdout.write(`${lines.join('\n')}\n`);
        renderState.rendered = true;
    };

    render.clear = clear;
    return render;
}

function syncOptionsForSelection(state, catalog) {
    const spec = state.variables[state.selectedVar];
    const options = buildValueOptions(spec, catalog);
    const currentValue = state.variables[state.selectedVar].current;
    const selectedIndex = options.findIndex((option) => option.value === currentValue);
    state.valueOptions = options;
    state.selectedValueIndex = selectedIndex >= 0 ? selectedIndex : 0;
}

export async function runSettingsMenu({ onEnvChange } = {}) {
    if (!process.stdin.isTTY) {
        console.log('Interactive TTY is required for env configuration.');
        return;
    }

    const envPath = resolveEnvFilePath(process.cwd());
    populateProcessEnvFromEnvFile(envPath);

    const catalog = await loadSoulModelCatalog();

    const variables = VAR_SPECS.map((spec) => ({
        ...spec,
        current: getCurrentValueDisplay(spec),
    }));

    const state = {
        variables,
        selectedVar: 0,
        selectingValue: false,
        selectedValueIndex: 0,
        valueOptions: [],
        warning: catalog.warning,
    };
    syncOptionsForSelection(state, catalog);

    const renderMenu = createMenuRenderer();

    const restoreInput = inputState.prepareForExternalCommand?.() || (() => {});
    const rlInput = process.stdin;
    readline.emitKeypressEvents(rlInput);

    try { rlInput.setRawMode(true); } catch (_) { /* noop */ }
    try { rlInput.resume(); } catch (_) { /* noop */ }

    let altScreenEnabled = false;
    if (process.stdout.isTTY) {
        try {
            process.stdout.write(ENTER_ALT_SCREEN);
            altScreenEnabled = true;
        } catch (_) { /* noop */ }
    }

    let keyHandler = null;
    let cleanedUp = false;

    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        try { renderMenu.clear?.(); } catch (_) { /* noop */ }
        try { if (keyHandler) rlInput.off('keypress', keyHandler); } catch (_) { /* noop */ }
        if (altScreenEnabled) {
            try { process.stdout.write(EXIT_ALT_SCREEN); } catch (_) { /* noop */ }
            altScreenEnabled = false;
        }
        restoreInput();
    };

    return await new Promise((resolve) => {
        const onKey = (str, key) => {
            if (key?.name === 'escape' || key?.name === 'backspace' || (key?.ctrl && key.name === 'c')) {
                cleanup();
                return resolve(0);
            }

            if (key?.name === 'up') {
                if (state.selectingValue) {
                    state.selectedValueIndex = (state.selectedValueIndex - 1 + state.valueOptions.length) % state.valueOptions.length;
                } else {
                    state.selectedVar = (state.selectedVar - 1 + state.variables.length) % state.variables.length;
                    syncOptionsForSelection(state, catalog);
                }
                renderMenu(state);
                return;
            }

            if (key?.name === 'down') {
                if (state.selectingValue) {
                    state.selectedValueIndex = (state.selectedValueIndex + 1) % state.valueOptions.length;
                } else {
                    state.selectedVar = (state.selectedVar + 1) % state.variables.length;
                    syncOptionsForSelection(state, catalog);
                }
                renderMenu(state);
                return;
            }

            if (key?.name === 'return') {
                if (!state.selectingValue) {
                    state.selectingValue = true;
                    renderMenu(state);
                    return;
                }

                const spec = state.variables[state.selectedVar];
                const selected = state.valueOptions[state.selectedValueIndex];
                const value = selected?.value || 'unset';
                applyValue(spec, value);
                if (typeof onEnvChange === 'function') {
                    try { onEnvChange(spec.key, value); } catch (_) { /* noop */ }
                }
                state.variables[state.selectedVar].current = getCurrentValueDisplay(spec);
                state.selectingValue = false;
                syncOptionsForSelection(state, catalog);
                renderMenu(state);
            }
        };

        keyHandler = onKey;
        rlInput.on('keypress', keyHandler);
        renderMenu(state);
    }).finally(() => {
        cleanup();
    });
}
