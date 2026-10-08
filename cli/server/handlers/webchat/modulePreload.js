// Every ES module reachable from webchat/index.js, so the browser can fetch the
// whole graph in parallel instead of discovering it one import level at a time.
// tests/unit/webchatModulePreload.test.mjs fails when this list and the real
// static import graph differ. Paths are relative to the /webchat/assets base.
export const WEBCHAT_MODULE_PRELOADS = Object.freeze([
    'index.js',
    'autocompleteProviders/slashCommands.js',
    'autocompleteProviders/workspacePaths.js',
    'autocompleteState.js',
    'composer.js',
    'composerAutocomplete.js',
    'composerMentionHighlights.js',
    'domSetup.js',
    'fileHelpers.js',
    'headerMenu.js',
    'interactionPrompt.js',
    'logMarkdown.js',
    'markdown.js',
    'messages.js',
    'network.js',
    'sessionSettings.js',
    'sessions.js',
    'sidePanel.js',
    'startupCatalogRefresh.js',
    'taskDetails.js',
    'taskLiveSession.js',
    'taskPresentation.js',
    'tasks.js',
    'upload.js',
    'uploadDestinationDialog.js',
    'workspaceFileIndex.js',
    'workspaceFileLinks.js',
]);

function escapeAttribute(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderModulePreloadLinks(assetBase) {
    return WEBCHAT_MODULE_PRELOADS
        .map((file) => `<link rel="modulepreload" href="${escapeAttribute(`${assetBase}/${file}`)}"/>`)
        .join('\n    ');
}
