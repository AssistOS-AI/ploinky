function createBrowserId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    // Plain HTTP on a bound LAN interface has getRandomValues, but does not
    // expose the secure-context-only randomUUID convenience method.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function initDom() {
    const dlog = () => {};

    const body = document.body;
    const markdown = window.webchatMarkdown;

    const titleBar = document.getElementById('titleBar');
    const runtimeModel = document.getElementById('runtimeModel');
    const avatarInitial = document.getElementById('avatarInitial');
    const statusEl = document.getElementById('statusText');
    const statusDot = document.querySelector('.wa-status-dot');
    const themeSelect = document.getElementById('themeSelect');
    const banner = document.getElementById('connBanner');
    const bannerText = document.getElementById('bannerText');
    const chatList = document.getElementById('chatList');
    const typingIndicator = document.getElementById('typingIndicator');
    const cmdInput = document.getElementById('cmd');
    const sendBtn = document.getElementById('send');
    const cancelBtn = document.getElementById('cancelBtn');
    const chatContainer = document.getElementById('chatContainer');
    const chatArea = document.getElementById('chatArea');
    const sidePanel = document.getElementById('sidePanel');
    const sidePanelContent = document.getElementById('sidePanelContent');
    const sidePanelClose = document.getElementById('sidePanelClose');
    const sidePanelTitle = document.querySelector('.wa-side-panel-title');
    const sidePanelResizer = document.getElementById('sidePanelResizer');
    const settingsBtn = document.getElementById('settingsBtn');
    const headerActions = document.getElementById('headerActions');
    const logoutBtn = document.getElementById('logoutBtn');
    const settingsPanel = document.getElementById('settingsPanel');
    const settingsMobileActions = document.getElementById('settingsMobileActions');
    const settingsActionSlot = document.getElementById('settingsActionSlot');
    const attachmentBtn = document.getElementById('attachmentBtn');
    const attachmentMenu = document.getElementById('attachmentMenu');
    const uploadFileBtn = document.getElementById('uploadFileBtn');
    const uploadFolderBtn = document.getElementById('uploadFolderBtn');
    const cameraActionBtn = document.getElementById('cameraActionBtn');
    const attachmentContainer = document.querySelector('.wa-attachment-container');
    const fileUploadInput = document.getElementById('fileUploadInput');
    const folderUploadInput = document.getElementById('folderUploadInput');
    const filePreviewContainer = document.getElementById('filePreviewContainer');
    const interactionPrompt = document.getElementById('interactionPrompt');
    const interactionPromptTitle = document.getElementById('interactionPromptTitle');
    const interactionPromptMessage = document.getElementById('interactionPromptMessage');
    const interactionPromptDetail = document.getElementById('interactionPromptDetail');
    const interactionPromptInputRow = document.getElementById('interactionPromptInputRow');
    const interactionPromptInput = document.getElementById('interactionPromptInput');
    const interactionPromptSubmit = document.getElementById('interactionPromptSubmit');
    const interactionPromptOptions = document.getElementById('interactionPromptOptions');
    const sessionsBtn = document.getElementById('sessionsBtn');
    const historyGate = document.getElementById('historyGate');
    const sessionDialog = document.getElementById('sessionDialog');
    const sessionDialogClose = document.getElementById('sessionDialogClose');
    const sessionList = document.getElementById('sessionList');
    const sessionListLoading = document.getElementById('sessionListLoading');
    const tasksBtn = document.getElementById('tasksBtn');
    const tasksBadge = document.getElementById('tasksBadge');
    const tasksDialog = document.getElementById('tasksDialog');
    const tasksDialogClose = document.getElementById('tasksDialogClose');
    const tasksList = document.getElementById('tasksList');
    const taskDetail = document.getElementById('taskDetail');
    const taskToast = document.getElementById('taskToast');
    const taskToastText = document.getElementById('taskToastText');
    const taskToastClose = document.getElementById('taskToastClose');

    const agentName = (body.dataset.agent || '').trim();
    const displayName = (body.dataset.title || '').trim();
    const basePath = (body.dataset.base || '').replace(/\/$/, '') || '';
    const agentQuery = (body.dataset.agentQuery || '').trim();
    const workdir = (body.dataset.workdir || '').trim();
    // The trusted workspace root admits absolute file references beneath it.
    const workspaceRoot = body.dataset.workspaceRoot || '';
    let workspaceBase = '';
    try {
        workspaceBase = decodeURIComponent((body.dataset.workspaceBase || '').trim());
    } catch (_) {
        workspaceBase = '';
    }
    const tabStorageKey = `webchat_tab_id:${workdir}:${agentQuery}`;
    let TAB_ID = '';
    try {
        TAB_ID = sessionStorage.getItem(tabStorageKey) || '';
    } catch (_) { }
    if (!TAB_ID) {
        TAB_ID = createBrowserId();
        try { sessionStorage.setItem(tabStorageKey, TAB_ID); } catch (_) { }
    }
    const PAGE_INSTANCE_ID = createBrowserId();

    const launchConfig = {};
    try {
        const params = new URLSearchParams(window.location.search || '');
        for (const [key, value] of params.entries()) {
            launchConfig[String(key).trim()] = String(value);
        }
    } catch (_) {
        // Ignore URL parsing issues; providers fall back to empty config.
    }

    const robotName = new URLSearchParams(agentQuery).get('robot') || launchConfig.robot || '';
    const appTitle = robotName ? `${displayName || agentName || 'WebChat'} · ${robotName}` : displayName || agentName || 'WebChat';
    if (titleBar) {
        titleBar.textContent = appTitle;
    }
    const headerWorkdir = document.getElementById('headerWorkdir');
    if (headerWorkdir && workdir) {
        headerWorkdir.textContent = workdir;
    }
    document.title = `${appTitle} · WebChat`;
    if (avatarInitial) {
        const initial = appTitle.trim().charAt(0) || 'P';
        avatarInitial.textContent = initial.toUpperCase();
    }

    function setRuntimeRobot(value) {
        if (typeof value !== 'string' || !value.trim()) return;
        const title = `${displayName || agentName || 'WebChat'} · ${value.trim()}`;
        if (titleBar) titleBar.textContent = title;
        document.title = `${title} · WebChat`;
    }

    function setRuntimeModel(value, effortValue) {
        if (!runtimeModel) return;
        const model = typeof value === 'string' ? value.trim() : '';
        const effort = typeof effortValue === 'string' ? effortValue.trim() : '';
        const label = model ? `${model}${effort ? ` · ${effort}` : ''}` : '';
        runtimeModel.textContent = label;
        runtimeModel.title = model ? `Selected model: ${label}` : '';
        runtimeModel.hidden = !model;
    }

    function showBanner(text, cls) {
        if (!banner || !bannerText) {
            return;
        }
        banner.className = 'wa-connection-banner show';
        if (cls === 'ok') {
            banner.classList.add('success');
        } else if (cls === 'err') {
            banner.classList.add('error');
        }
        bannerText.textContent = text;
    }

    function hideBanner() {
        if (!banner) {
            return;
        }
        banner.classList.remove('show');
    }

    const THEME_STORAGE_KEY = 'webchat_theme';
    const SUPPORTED_THEMES = new Set(['light', 'dark', 'explorer', 'obsidian']);
    const FALLBACK_THEME = 'explorer';

    function normalizeTheme(theme) {
        return SUPPORTED_THEMES.has(theme) ? theme : FALLBACK_THEME;
    }

    function readThemePreference() {
        try {
            const stored = localStorage.getItem(THEME_STORAGE_KEY);
            return normalizeTheme(stored);
        } catch (_) {
            return FALLBACK_THEME;
        }
    }

    function applyThemePreference(theme) {
        const nextTheme = normalizeTheme(theme);
        document.body.setAttribute('data-theme', nextTheme);
        try {
            localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
        } catch (_) {
            // Ignore storage failures
        }
        if (themeSelect && themeSelect.value !== nextTheme) {
            themeSelect.value = nextTheme;
        }
    }

    const initialTheme = readThemePreference();
    applyThemePreference(initialTheme);

    if (themeSelect) {
        themeSelect.value = initialTheme;
        themeSelect.addEventListener('change', (event) => {
            applyThemePreference(event.target.value);
        });
    }

    const toEndpoint = (path) => {
        const suffix = String(path || '').replace(/^\/+/, '');
        let url = basePath ? `${basePath}/${suffix}` : `/${suffix}`;
        if (agentQuery) {
            url += (url.includes('?') ? '&' : '?') + agentQuery;
        }
        return url;
    };

    return {
        TAB_ID,
        PAGE_INSTANCE_ID,
        dlog,
        markdown,
        basePath,
        agentName,
        displayName: appTitle,
        workdir,
        workspaceRoot,
        workspaceBase,
        launchConfig,
        toEndpoint,
        showBanner,
        hideBanner,
        setRuntimeModel,
        setRuntimeRobot,
        elements: {
            body,
            titleBar,
            runtimeModel,
            avatarInitial,
            statusEl,
            statusDot,
            themeSelect,
            banner,
            bannerText,
            chatList,
            typingIndicator,
            cmdInput,
            sendBtn,
            cancelBtn,
            chatContainer,
            chatArea,
            sidePanel,
            sidePanelContent,
            sidePanelClose,
            sidePanelTitle,
            sidePanelResizer,
            settingsBtn,
            headerActions,
            logoutBtn,
            settingsPanel,
            settingsMobileActions,
            settingsActionSlot,
            attachmentBtn,
            attachmentMenu,
            uploadFileBtn,
            uploadFolderBtn,
            cameraActionBtn,
            fileUploadInput,
            folderUploadInput,
            filePreviewContainer,
            interactionPrompt,
            interactionPromptTitle,
            interactionPromptMessage,
            interactionPromptDetail,
            interactionPromptInputRow,
            interactionPromptInput,
            interactionPromptSubmit,
            interactionPromptCancel: document.getElementById('interactionPromptCancel'),
            interactionPromptOptions,
            attachmentContainer,
            sessionsBtn,
            historyGate,
            sessionDialog,
            sessionDialogClose,
            sessionList,
            sessionListLoading,
            tasksBtn,
            tasksBadge,
            tasksDialog,
            tasksDialogClose,
            tasksList,
            taskDetail,
            taskToast,
            taskToastText,
            taskToastClose,
        },
    };
}
