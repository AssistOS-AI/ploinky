import {
    applySlashInsertTextToValue,
    buildSuggestions,
} from './autocompleteProviders/slashCommands.js';

function replaceValue(nextValue) {
    return () => ({ value: nextValue, cursor: nextValue.length });
}

function parseSlashInput(value) {
    const input = String(value || '');
    if (!input.startsWith('/')) return null;
    const afterSlash = input.slice(1);
    const firstChar = afterSlash.charAt(0);
    if (firstChar === ' ' || firstChar === '\n') return null;
    const spaceIdx = afterSlash.indexOf(' ');
    return {
        currentToken: spaceIdx === -1 ? afterSlash : afterSlash.slice(0, spaceIdx),
        hasSubToken: spaceIdx !== -1,
        subToken: spaceIdx === -1 ? '' : afterSlash.slice(spaceIdx + 1),
    };
}

function commandForArgument(commands, parsed) {
    if (!parsed?.hasSubToken) return null;
    const token = parsed.currentToken.toLowerCase();
    return commands.find((entry) => String(entry?.name || '').replace(/^\//, '').toLowerCase() === token)
        || null;
}

export function createTaskCommandAutocompleteProvider({
    getCommands,
    getLoadingCommand,
    onLoadOptions,
} = {}) {
    return {
        trigger: '/',
        groupLabel: 'Task controls',
        getSuggestions(value) {
            const parsed = parseSlashInput(value);
            if (!parsed) return [];
            const commands = getCommands?.() || [];
            const argumentCommand = commandForArgument(commands, parsed);
            const hasCompletions = Array.isArray(argumentCommand?.argCompletions)
                && argumentCommand.argCompletions.length > 0;
            if (argumentCommand?.loadingLabel && !hasCompletions) {
                return [{
                    label: 'Loading...',
                    loadingLabel: argumentCommand.loadingLabel,
                    loading: true,
                    disabled: true,
                    command: argumentCommand,
                }];
            }
            return buildSuggestions(commands, parsed).map((suggestion) => ({
                ...suggestion,
                keepMenuOpen: suggestion.keepMenuOpen
                    || (!parsed.hasSubToken && Boolean(suggestion.command?.loadingLabel)),
                trigger: '/',
                group: 'Task controls',
            }));
        },
        requestSuggestions(value) {
            const parsed = parseSlashInput(value);
            const commands = getCommands?.() || [];
            const argumentCommand = commandForArgument(commands, parsed);
            const hasCompletions = Array.isArray(argumentCommand?.argCompletions)
                && argumentCommand.argCompletions.length > 0;
            if (!argumentCommand?.loadingLabel || hasCompletions) return null;
            if (getLoadingCommand?.() === argumentCommand.name) return null;
            return onLoadOptions?.(argumentCommand) || null;
        },
        applySelection(value, suggestion) {
            return suggestion?.insertText
                ? applySlashInsertTextToValue(value, suggestion.insertText)
                : null;
        },
    };
}

export function createTaskInteractionAutocompleteProvider({ getInteraction, onSelect } = {}) {
    return {
        trigger: '/',
        groupLabel: 'Available options',
        getSuggestions(value) {
            const interaction = getInteraction?.();
            if (!interaction) return [];
            if (interaction.loading === true) {
                return [{
                    label: 'Loading...',
                    loadingLabel: interaction.loadingLabel || 'Loading options…',
                    loading: true,
                    disabled: true,
                }];
            }
            if (!Array.isArray(interaction.options)) return [];
            const query = String(value || '').replace(/^\//, '').trim().toLowerCase();
            return interaction.options
                .filter((option) => !query || [option.label, option.description]
                    .some((text) => String(text || '').toLowerCase().includes(query)))
                .map((option) => ({
                    label: option.label,
                    description: option.description || interaction.message || '',
                    ...(interaction.challenge ? { contextPanel: interaction.challenge } : {}),
                    applySelection: replaceValue(''),
                    onSelected: () => onSelect?.(interaction, option),
                }));
        },
    };
}
