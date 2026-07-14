const VIEW_MORE_LINES_KEY = 'wa_view_more_lines';
const LEGACY_VIEW_MORE_KEY = 'wa_view_more_enabled';

function readInitialViewMoreLimit() {
    let limit = 1000;
    try {
        const storedLimit = localStorage.getItem(VIEW_MORE_LINES_KEY);
        if (storedLimit !== null) {
            const parsed = parseInt(storedLimit, 10);
            if (!Number.isNaN(parsed) && parsed >= 1) {
                limit = parsed;
            }
        } else {
            const legacy = localStorage.getItem(LEGACY_VIEW_MORE_KEY);
            if (legacy === 'true') {
                limit = 6;
            } else if (legacy === 'false') {
                limit = 1000;
            }
        }
    } catch (_) {
        limit = 1000;
    }
    try {
        localStorage.removeItem(LEGACY_VIEW_MORE_KEY);
        localStorage.setItem(VIEW_MORE_LINES_KEY, String(limit));
    } catch (_) {
        // Ignore storage issues
    }
    return limit;
}

export function initDom() {
    const dlog = () => {};

    const body = document.body;
    const markdown = window.webchatMarkdown;

    const titleBar = document.getElementById('titleBar');
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
    const logoutBtn = document.getElementById('logoutBtn');
    const settingsPanel = document.getElementById('settingsPanel');
    const viewMoreLinesInput = document.getElementById('viewMoreLines');
    const attachmentBtn = document.getElementById('attachmentBtn');
    const attachmentMenu = document.getElementById('attachmentMenu');
    const uploadFileBtn = document.getElementById('uploadFileBtn');
    const uploadFolderBtn = document.getElementById('uploadFolderBtn');
    const cameraActionBtn = document.getElementById('cameraActionBtn');
    const attachmentContainer = document.querySelector('.wa-attachment-container');
    const fileUploadInput = document.getElementById('fileUploadInput');
    const folderUploadInput = document.getElementById('folderUploadInput');
    const filePreviewContainer = document.getElementById('filePreviewContainer');
    const newSessionBtn = document.getElementById('newSessionBtn');
    const loadSessionBtn = document.getElementById('loadSessionBtn');
    const historyGate = document.getElementById('historyGate');
    const loadHistoryBtn = document.getElementById('loadHistoryBtn');
    const sessionDialog = document.getElementById('sessionDialog');
    const sessionDialogClose = document.getElementById('sessionDialogClose');
    const sessionList = document.getElementById('sessionList');
    const tasksBtn = document.getElementById('tasksBtn');
    const tasksBadge = document.getElementById('tasksBadge');
    const tasksDialog = document.getElementById('tasksDialog');
    const tasksDialogClose = document.getElementById('tasksDialogClose');
    const tasksList = document.getElementById('tasksList');
    const taskDetail = document.getElementById('taskDetail');
    const taskToast = document.getElementById('taskToast');

    const agentName = (body.dataset.agent || '').trim();
    const displayName = (body.dataset.title || '').trim();
    const basePath = (body.dataset.base || '').replace(/\/$/, '') || '';
    const agentQuery = (body.dataset.agentQuery || '').trim();
    const workdir = (body.dataset.workdir || '').trim();
    const tabStorageKey = `webchat_tab_id:${workdir}:${agentQuery}`;
    let TAB_ID = '';
    try {
        TAB_ID = sessionStorage.getItem(tabStorageKey) || '';
    } catch (_) { }
    if (!TAB_ID) {
        TAB_ID = crypto.randomUUID();
        try { sessionStorage.setItem(tabStorageKey, TAB_ID); } catch (_) { }
    }

    const launchConfig = {};
    try {
        const params = new URLSearchParams(window.location.search || '');
        for (const [key, value] of params.entries()) {
            launchConfig[String(key).trim()] = String(value);
        }
    } catch (_) {
        // Ignore URL parsing issues; providers fall back to empty config.
    }

    const appTitle = displayName || agentName || 'WebChat';
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

    let viewMoreLineLimit = readInitialViewMoreLimit();
    let viewMoreChangeHandler = null;

    function emitViewMoreChange() {
        if (typeof viewMoreChangeHandler === 'function') {
            viewMoreChangeHandler(viewMoreLineLimit);
        }
    }

    if (viewMoreLinesInput) {
        const normalizeLineLimit = () => {
            const parsed = parseInt(viewMoreLinesInput.value, 10);
            viewMoreLineLimit = Number.isNaN(parsed) ? 1 : Math.max(1, parsed);
            viewMoreLinesInput.value = String(viewMoreLineLimit);
            try {
                localStorage.setItem(VIEW_MORE_LINES_KEY, String(viewMoreLineLimit));
            } catch (_) {
                // Ignore storage failures
            }
            emitViewMoreChange();
        };
        viewMoreLinesInput.value = String(viewMoreLineLimit);
        viewMoreLinesInput.addEventListener('change', normalizeLineLimit);
        viewMoreLinesInput.addEventListener('blur', normalizeLineLimit);
    }

    function setViewMoreChangeHandler(handler) {
        viewMoreChangeHandler = typeof handler === 'function' ? handler : null;
        emitViewMoreChange();
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
        dlog,
        markdown,
        basePath,
        agentName,
        displayName: appTitle,
        workdir,
        launchConfig,
        toEndpoint,
        showBanner,
        hideBanner,
        getViewMoreLineLimit: () => viewMoreLineLimit,
        setViewMoreChangeHandler,
        elements: {
            body,
            titleBar,
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
            logoutBtn,
            settingsPanel,
            viewMoreLinesInput,
            attachmentBtn,
            attachmentMenu,
            uploadFileBtn,
            uploadFolderBtn,
            cameraActionBtn,
            fileUploadInput,
            folderUploadInput,
            filePreviewContainer,
            attachmentContainer,
            newSessionBtn,
            loadSessionBtn,
            historyGate,
            loadHistoryBtn,
            sessionDialog,
            sessionDialogClose,
            sessionList,
            tasksBtn,
            tasksBadge,
            tasksDialog,
            tasksDialogClose,
            tasksList,
            taskDetail,
            taskToast,
        },
    };
}
