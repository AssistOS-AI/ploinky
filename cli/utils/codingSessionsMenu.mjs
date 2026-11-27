// A small full-screen list menu for `ploinky cs`, drawn with ANSI sequences on
// the alternate screen and driven by raw keys. It holds no session logic: the
// command gives it items and receives the chosen action.

const ESC = '\x1b';
const KEYS = Object.freeze({
    [`${ESC}[A`]: 'up', [`${ESC}OA`]: 'up', [`${ESC}[B`]: 'down', [`${ESC}OB`]: 'down',
    [`${ESC}[5~`]: 'pageUp', [`${ESC}[6~`]: 'pageDown', [`${ESC}[H`]: 'home', [`${ESC}[F`]: 'end',
    [`${ESC}[Z`]: 'tab', [`${ESC}[C`]: 'right', [`${ESC}OC`]: 'right', [`${ESC}[D`]: 'left', [`${ESC}OD`]: 'left',
    [`${ESC}[3~`]: 'delete', '\r': 'enter', '\n': 'enter', '\x7f': 'back', '\b': 'back', '\x03': 'quit',
});

// What a coding agent may leave switched on in the terminal when its view
// detaches: mouse reporting in every encoding, focus reporting, bracketed
// paste, color-scheme notifications, the kitty keyboard protocol and application cursor keys. The menu
// turns them off, so a mouse moving over the terminal never reads as a key.
export const TERMINAL_INPUT_RESET = `${ESC}[?9l${ESC}[?1009l${ESC}[?1016l${ESC}[?1000l${ESC}[?1001l${ESC}[?1002l${ESC}[?1003l${ESC}[?1005l${ESC}[?1006l`
    + `${ESC}[?1015l${ESC}[?1004l${ESC}[?2031l${ESC}[?2004l${ESC}[<u${ESC}[?1l${ESC}>`;

// Splits a chunk of raw input into keys. Every escape sequence stays whole: a
// CSI with any parameters (including private markers such as `<`), an SS3
// key, and a legacy X10 mouse report, whose three raw bytes follow `ESC [ M`.
export function parseKeys(text) {
    const keys = [];
    let index = 0;
    while (index < text.length) {
        if (text[index] === ESC) {
            const match = text.slice(index).match(/^\x1b(?:\[M[\s\S]{3}|\[[0-?]*[ -/]*[@-~]|O[@-~])/u);
            const sequence = match ? match[0] : ESC;
            keys.push(KEYS[sequence] || (sequence === ESC ? 'escape' : 'unknown'));
            index += sequence.length;
            continue;
        }
        const character = text[index];
        keys.push(KEYS[character] || (character >= ' ' ? character : 'unknown'));
        index += 1;
    }
    return keys;
}

// Keep incomplete reports and keys out of the menu across stream reads.
export function createKeyParser() {
    let pending = '';
    return chunk => {
        let text = pending + chunk.toString('utf8');
        pending = '';
        const partial = /\x1b\][^\x07\x1b]*(?:\x1b)?$|\x1b(?:\[[0-?]*[ -/]*|O|\[M[\s\S]{0,2})?$/u.exec(text);
        if (partial) { pending = partial[0]; text = text.slice(0, partial.index); }
        // Colour/device reports left in flight by the detached terminal are not menu input.
        text = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, '');
        return parseKeys(text);
    };
}

// Visible width is approximated by code points; control characters never reach
// the screen.
export function fit(text, width) {
    const clean = Array.from(String(text ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' '));
    if (clean.length <= width) return clean.join('');
    return width <= 1 ? clean.slice(0, width).join('') : `${clean.slice(0, width - 1).join('')}…`;
}

function pad(text, width) {
    const fitted = fit(text, width);
    return fitted + ' '.repeat(Math.max(0, width - Array.from(fitted).length));
}

// The tab line names the two menus of this command; the active one is inverted.
function renderTabs(tabs, activeTab, width) {
    const each = Math.max(6, Math.floor((width - 2 * (tabs.length - 1)) / Math.max(1, tabs.length)));
    return tabs.map((label, index) => {
        const text = pad(label, each);
        return index === activeTab ? `${ESC}[7m${text}${ESC}[0m` : `${ESC}[2m${text}${ESC}[0m`;
    }).join('  ');
}

// The rows of one screen: header lines, an optional tab line, a window of items
// around the selection, a status line and the key help.
export function renderMenu({ title = [], items = [], selected = 0, status = '', help = '', columns = 80, rows = 24,
    tabs = [], activeTab = 0 }) {
    const width = Math.max(20, columns);
    const lines = title.map(line => `${ESC}[1m${fit(line, width)}${ESC}[0m`);
    if (tabs.length) lines.push(renderTabs(tabs, activeTab, width));
    lines.push(`${ESC}[2m${'─'.repeat(width)}${ESC}[0m`);
    const capacity = Math.max(1, rows - lines.length - 3);
    const start = Math.min(Math.max(0, selected - Math.floor(capacity / 2)), Math.max(0, items.length - capacity));
    const visible = items.slice(start, start + capacity);
    if (!items.length) lines.push(`${ESC}[2m  (empty)${ESC}[0m`);
    visible.forEach((item, offset) => {
        const index = start + offset;
        const marker = index === selected ? '▸ ' : '  ';
        const detailWidth = item.detail ? Math.min(Math.max(12, Math.floor(width / 3)), width - 10) : 0;
        const labelWidth = width - 2 - (detailWidth ? detailWidth + 1 : 0);
        const text = `${marker}${pad(item.label, labelWidth)}${detailWidth ? ` ${pad(item.detail, detailWidth)}` : ''}`;
        const styled = item.dim ? `${ESC}[2m${text}${ESC}[0m` : text;
        lines.push(index === selected ? `${ESC}[7m${fit(text, width)}${ESC}[0m` : styled);
    });
    while (lines.length < rows - 2) lines.push('');
    lines.push(status ? `${ESC}[33m${fit(status, width)}${ESC}[0m` : '');
    lines.push(`${ESC}[2m${fit(help, width)}${ESC}[0m`);
    return lines.slice(0, rows);
}

export function moveSelection(selected, key, count, page = 10) {
    if (!count) return 0;
    const steps = { up: -1, down: 1, pageUp: -page, pageDown: page };
    if (key === 'home') return 0;
    if (key === 'end') return count - 1;
    if (!(key in steps)) return selected;
    return Math.min(count - 1, Math.max(0, selected + steps[key]));
}

export class ListMenu {
    constructor({ input = process.stdin, output = process.stdout } = {}) {
        Object.assign(this, { input, output });
        this.active = false;
    }

    open() {
        if (this.active) return;
        this.active = true;
        if (this.input.isTTY && typeof this.input.setRawMode === 'function') this.input.setRawMode(true);
        this.input.resume();
        this.output.write(`${TERMINAL_INPUT_RESET}${ESC}[?1049h${ESC}[?25l`);
    }

    // Leaves the alternate screen, so a terminal session draws on the normal one.
    close() {
        if (!this.active) return;
        this.active = false;
        this.output.write(`${TERMINAL_INPUT_RESET}${ESC}[?25h${ESC}[?1049l`);
        if (this.input.isTTY && typeof this.input.setRawMode === 'function') {
            try { this.input.setRawMode(false); } catch (_) { }
        }
        this.input.pause();
    }

    draw(view) {
        const lines = renderMenu({ ...view, columns: this.output.columns || 80, rows: this.output.rows || 24 });
        this.output.write(`${ESC}[H${ESC}[2J${lines.join('\r\n')}`);
    }

    // Shows a message while `operation` runs and resolves to its result.
    async busy(view, operation) {
        this.open();
        this.draw({ ...view, items: [], status: view.status || 'Loading…' });
        return operation();
    }

    // Resolves {action, index}: 'enter', 'back', 'quit' and, on a screen that
    // shows tabs, 'tab'; plus the letters or keys of `actions` (for example
    // {k: 'kill', delete: 'kill'}). `refreshMs` with `load` redraws a live
    // screen in place, so a list of running terminals stays current.
    select(view, { selected = 0, actions = {}, refreshMs = 0, load = null } = {}) {
        this.open();
        let current = view;
        let index = Math.min(Math.max(0, selected), Math.max(0, current.items.length - 1));
        let status = current.status || '';
        this.draw({ ...current, selected: index, status });
        return new Promise((resolve) => {
            let timer = null;
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.input.off('data', onData);
                this.output.off?.('resize', onResize);
                resolve(result);
            };
            const onResize = () => this.draw({ ...current, selected: index, status });
            const schedule = () => {
                if (!refreshMs || typeof load !== 'function' || settled) return;
                timer = setTimeout(async () => {
                    if (settled) return;
                    try {
                        const next = await load();
                        if (next && !settled) {
                            current = { ...current, ...next };
                            index = Math.min(index, Math.max(0, current.items.length - 1));
                            if (typeof next.status === 'string') status = next.status;
                            this.draw({ ...current, selected: index, status });
                        }
                    } catch (_) { /* the next refresh tries again */ }
                    schedule();
                }, refreshMs);
                timer.unref?.();
            };
            const readKeys = createKeyParser();
            const onData = (chunk) => {
                for (const key of readKeys(chunk)) {
                    if (key === 'quit' || key === 'q') return finish({ action: 'quit', index });
                    if (key === 'back') return finish({ action: 'back', index });
                    // The two menus of this command sit on one line: either Shift+Tab
                    // or a horizontal arrow moves between them.
                    if ((key === 'tab' || key === 'left' || key === 'right') && current.tabs) {
                        return finish({ action: 'tab', index });
                    }
                    if (key === 'enter' && current.items.length) return finish({ action: 'enter', index });
                    if (actions[key]) return finish({ action: actions[key], index });
                    const next = moveSelection(index, key, current.items.length);
                    if (next !== index) {
                        index = next;
                        status = '';
                        this.draw({ ...current, selected: index, status });
                    }
                }
                return undefined;
            };
            this.input.on('data', onData);
            this.output.on?.('resize', onResize);
            schedule();
        });
    }

    // A yes/no question on the status line; anything but y or Y answers no.
    confirm(view, question) {
        this.open();
        this.draw({ ...view, status: `${question} [y/N]` });
        return new Promise((resolve) => {
            const onData = (chunk) => {
                this.input.off('data', onData);
                const [key] = parseKeys(chunk.toString('utf8'));
                resolve(key === 'y' || key === 'Y');
            };
            this.input.on('data', onData);
        });
    }
}
