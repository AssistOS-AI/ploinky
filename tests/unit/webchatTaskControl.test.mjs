import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createTaskCommandAutocompleteProvider,
    createTaskInteractionAutocompleteProvider,
} from '../../cli/server/webchat/taskCommandAutocomplete.js';
import { createComposerAutocomplete } from '../../cli/server/webchat/composerAutocomplete.js';
import { parseWebchatTaskState } from '../../cli/server/handlers/webchat/runtimeState.js';

test('task command autocomplete uses the classic slash lifecycle and loads arguments in place', async () => {
    let loadingCommand = '';
    const loads = [];
    let commands = [
        {
            name: '/model',
            command: '/task model task_111111111111111111111111',
            description: 'Choose model',
            loadingLabel: 'Loading models…',
            argMatchMode: 'fragment',
        },
        { name: '/login', command: '/task login task_111111111111111111111111', description: 'Connect provider' },
    ];
    const provider = createTaskCommandAutocompleteProvider({
        getCommands: () => commands,
        getLoadingCommand: () => loadingCommand,
        onLoadOptions: async (command) => {
            loadingCommand = command.name;
            loads.push(command.name);
        },
    });

    const suggestions = provider.getSuggestions('/m');
    assert.deepEqual(suggestions.map((entry) => entry.label), ['/model']);
    assert.deepEqual(provider.applySelection('/m', suggestions[0]), {
        value: '/model ', cursor: 7,
    });
    assert.equal(suggestions[0].keepMenuOpen, true);
    const [loading] = provider.getSuggestions('/model ');
    assert.equal(loading.label, 'Loading models…');
    assert.equal(loading.description, 'Choose model');
    assert.equal(loading.disabled, true);
    await provider.requestSuggestions('/model ');
    assert.deepEqual(loads, ['/model']);

    commands = [{
        ...commands[0],
        argCompletions: [
            { value: 'openai/gpt-test', label: 'GPT Test', description: 'OpenAI' },
            { value: 'anthropic/claude-test', label: 'Claude Test', description: 'Anthropic' },
        ],
    }];
    const [model] = provider.getSuggestions('/model claude');
    assert.equal(model.label, '/model Claude Test');
    assert.equal(model.keepMenuOpen, false);
    assert.deepEqual(provider.applySelection('/model claude', model), {
        value: '/model anthropic/claude-test ', cursor: 29,
    });
    assert.equal(provider.requestSuggestions('/model claude'), null);
});

test('task model Enter completes command, then model, and only the following Enter can submit', async (t) => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const createElement = () => {
        const classes = new Set();
        const attributes = new Map();
        return {
            children: [],
            className: '',
            classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
            style: {},
            clientHeight: 0,
            scrollTop: 0,
            appendChild(child) {
                this.children.push(child);
                this.firstChild = this.children[0] || null;
            },
            removeChild(child) {
                this.children.splice(this.children.indexOf(child), 1);
                this.firstChild = this.children[0] || null;
            },
            addEventListener() {},
            setAttribute: (name, value) => attributes.set(name, value),
            querySelector() { return null; },
            remove() {},
        };
    };
    globalThis.document = { createElement, body: { appendChild() {} } };
    globalThis.window = { innerHeight: 800 };
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    });

    let commands = [{
        name: '/model',
        command: '/task model task_111111111111111111111111',
        description: 'Choose model',
        loadingLabel: 'Loading models…',
        argMatchMode: 'fragment',
    }];
    let loads = 0;
    let loadingCommand = '';
    let autocomplete;
    const inputListeners = [];
    const cmdInput = {
        value: '/m',
        selectionStart: 2,
        getBoundingClientRect: () => ({ left: 10, top: 700, width: 400 }),
        closest: () => null,
        focus() {},
        setSelectionRange(start) { this.selectionStart = start; },
        dispatchEvent(event) {
            if (event.type === 'input') inputListeners.forEach((listener) => listener(event));
        },
    };
    const provider = createTaskCommandAutocompleteProvider({
        getCommands: () => commands,
        getLoadingCommand: () => loadingCommand,
        onLoadOptions: () => {
            loads += 1;
            loadingCommand = '/model';
        },
    });
    autocomplete = createComposerAutocomplete({ cmdInput }, {
        providers: [provider],
        positionStrategy: 'viewport',
    });
    inputListeners.push(() => autocomplete.onInputChange());

    const pressEnter = () => {
        let prevented = false;
        const handled = autocomplete.handleKeydown({
            key: 'Enter',
            preventDefault: () => { prevented = true; },
        });
        return { handled, prevented };
    };

    autocomplete.onInputChange();
    assert.deepEqual(pressEnter(), { handled: true, prevented: true });
    assert.equal(cmdInput.value, '/model ');
    await Promise.resolve();
    assert.equal(loads, 1);

    assert.deepEqual(pressEnter(), { handled: true, prevented: true });
    assert.equal(cmdInput.value, '/model ');

    commands = [{
        ...commands[0],
        argCompletions: [{ value: 'openai/gpt-test', label: 'GPT Test', description: 'OpenAI' }],
    }];
    loadingCommand = '';
    autocomplete.onInputChange();
    assert.deepEqual(pressEnter(), { handled: true, prevented: true });
    assert.equal(cmdInput.value, '/model openai/gpt-test ');
    assert.deepEqual(pressEnter(), { handled: false, prevented: false });
    autocomplete.destroy();
});

test('task interaction options reuse the contextual autocomplete provider', () => {
    const selected = [];
    const interaction = {
        id: 'task_control_12345678',
        message: 'Select the execution model for this task.',
        options: [
            { id: 'choice_0', label: 'GPT Test', description: 'openai/gpt-test' },
            { id: 'choice_1', label: 'Claude Test', description: 'anthropic/claude-test' },
        ],
    };
    const provider = createTaskInteractionAutocompleteProvider({
        getInteraction: () => interaction,
        onSelect: (request, option) => selected.push([request.id, option.id]),
    });
    const suggestions = provider.getSuggestions('/claude');
    assert.deepEqual(suggestions.map((entry) => entry.label), ['Claude Test']);
    assert.equal(suggestions[0].applySelection().value, '');
    suggestions[0].onSelected();
    assert.deepEqual(selected, [['task_control_12345678', 'choice_1']]);
});

test('task runtime state preserves validated model and generic task commands', () => {
    const parsed = parseWebchatTaskState({
        __webchatTask: 1,
        version: 1,
        event: 'view',
        task: {
            id: 'task_111111111111111111111111',
            status: 'finished',
            execution: {
                model: { key: 'pi/gpt', provider: 'pi', model: 'gpt', label: 'GPT' },
            },
            commands: [{
                name: '/model',
                command: '/task model task_111111111111111111111111',
                description: 'Choose model',
                loadingLabel: 'Loading models…',
                argMatchMode: 'fragment',
                argSuggestionLimit: 25,
                argCompletions: [{
                    value: 'openai/gpt-test',
                    label: 'GPT Test',
                    description: 'OpenAI model',
                }],
            }],
        },
        log: {},
    });
    assert.deepEqual(parsed.task.execution.model, {
        key: 'pi/gpt', provider: 'pi', model: 'gpt', label: 'GPT',
    });
    assert.deepEqual(parsed.task.commands, [{
        name: '/model',
        command: '/task model task_111111111111111111111111',
        description: 'Choose model',
        loadingLabel: 'Loading models…',
        argMatchMode: 'fragment',
        argSuggestionLimit: 25,
        argCompletions: [{
            value: 'openai/gpt-test',
            label: 'GPT Test',
            description: 'OpenAI model',
        }],
    }]);
});

test('task runtime state drops malformed command descriptors', () => {
    const parsed = parseWebchatTaskState({
        __webchatTask: 1,
        version: 1,
        event: 'view',
        task: {
            id: 'task_111111111111111111111111',
            status: 'finished',
            commands: [
                { name: 'model', command: '/task model task_111111111111111111111111' },
                { name: '/bad', command: 'not-a-command' },
                { name: '/other', command: '/task other task_222222222222222222222222' },
            ],
        },
        log: {},
    });
    assert.equal(parsed.task.commands, undefined);
});
