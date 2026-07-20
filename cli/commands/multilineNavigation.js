const ANSI_ESCAPE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const MULTILINE_FLAG = Symbol('ploinkyMultilineNav');

function stripAnsi(value) {
    if (!value) return '';
    return value.replace(ANSI_ESCAPE_PATTERN, '');
}

function getTerminalColumns(rl) {
    const candidate = rl?.output?.columns ?? process.stdout?.columns;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        return candidate;
    }
    return 80;
}

function getPromptColumnOffset(rl, columns) {
    if (!rl) return 0;
    const prompt = typeof rl._prompt === 'string' ? rl._prompt : '';
    if (typeof rl._getDisplayPos === 'function') {
        try {
            const measurement = rl._getDisplayPos(prompt);
            if (measurement && typeof measurement.cols === 'number') {
                return measurement.cols;
            }
        } catch (_) {
            /* noop */
        }
    }
    const visibleLength = stripAnsi(prompt).length;
    if (!columns || !Number.isFinite(columns) || columns <= 0) {
        return visibleLength;
    }
    return visibleLength % columns;
}

function buildRowLayout(line, firstRowOffset, columns, tabSize = 8) {
    const rows = [{
        start: 0,
        end: 0,
        offset: firstRowOffset,
    }];
    let col = firstRowOffset;
    const wrapEnabled = Number.isFinite(columns) && columns > 0;

    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '\r' || ch === '\n') {
            rows[rows.length - 1].end = i;
            rows.push({ start: i + 1, end: i + 1, offset: 0 });
            col = 0;
            continue;
        }
        if (wrapEnabled && col >= columns) {
            rows[rows.length - 1].end = i;
            rows.push({ start: i, end: i, offset: 0 });
            col = 0;
        }
        if (ch === '\t') {
            const spaces = tabSize - (col % tabSize) || tabSize;
            col += spaces;
        } else {
            col += 1;
        }
    }
    rows[rows.length - 1].end = line.length;
    return rows;
}

function locateCursor(rows, cursor) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return null;
    }
    const position = typeof cursor === 'number' ? cursor : 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (position >= row.start) {
            const end = Math.max(row.end, row.start);
            const clamped = Math.min(position, end);
            return {
                rowIndex: i,
                column: clamped - row.start,
            };
        }
    }
    return { rowIndex: 0, column: 0 };
}

function getCursorForRow(rows, rowIndex, desiredColumn) {
    const row = rows[rowIndex];
    if (!row) return null;
    const length = Math.max(row.end - row.start, 0);
    const column = Math.max(0, Math.min(desiredColumn, length));
    return row.start + column;
}

function handleVerticalNavigation(rl, direction) {
    if (!rl || typeof rl.line !== 'string' || rl.line.length === 0) {
        return false;
    }
    const columns = getTerminalColumns(rl);
    const promptOffset = getPromptColumnOffset(rl, columns);
    const tabSize = typeof rl.tabSize === 'number' && rl.tabSize > 0 ? rl.tabSize : 8;
    const rows = buildRowLayout(rl.line, promptOffset, columns, tabSize);
    if (!rows || rows.length <= 1) {
        return false;
    }
    const cursorInfo = locateCursor(rows, rl.cursor);
    if (!cursorInfo) return false;
    const targetRow = direction === 'up'
        ? cursorInfo.rowIndex - 1
        : cursorInfo.rowIndex + 1;
    if (targetRow < 0 || targetRow >= rows.length) {
        return false;
    }
    const nextCursor = getCursorForRow(rows, targetRow, cursorInfo.column);
    if (typeof nextCursor !== 'number') {
        return false;
    }
    rl.cursor = nextCursor;
    if (typeof rl._refreshLine === 'function') {
        rl._refreshLine();
    }
    return true;
}

export function enableMultilineNavigation(rl) {
    if (!rl || typeof rl._ttyWrite !== 'function' || rl[MULTILINE_FLAG]) {
        return;
    }
    const originalTtyWrite = rl._ttyWrite;
    rl[MULTILINE_FLAG] = true;
    rl._ttyWrite = function patchedTtyWrite(s, key) {
        if (key && (key.name === 'up' || key.name === 'down')
            && !key.ctrl && !key.meta && !key.shift) {
            const handled = handleVerticalNavigation(this, key.name);
            if (handled) {
                return;
            }
        }
        return originalTtyWrite.call(this, s, key);
    };
}
