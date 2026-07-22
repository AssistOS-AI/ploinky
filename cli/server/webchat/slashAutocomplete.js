import { createComposerAutocomplete } from './composerAutocomplete.js';
import { createSlashCommandsProvider } from './autocompleteProviders/slashCommands.js';

export {
    applySlashSelectionToValue,
    applySlashInsertTextToValue,
    buildSuggestions,
    createSlashCommandsProvider,
    loadSlashCommandsWithRetry
} from './autocompleteProviders/slashCommands.js';

export function createSlashAutocomplete({ cmdInput }, { agentName, dlog } = {}) {
    const provider = createSlashCommandsProvider({ agentName, dlog });
    const autocomplete = createComposerAutocomplete({ cmdInput }, {
        providers: [provider],
        dlog
    });
    return {
        handleKeydown: autocomplete.handleKeydown,
        onInputChange: autocomplete.onInputChange,
        fetchCommandCatalog: autocomplete.refresh,
        destroy: autocomplete.destroy,
        get isActive() { return autocomplete.isActive; }
    };
}
