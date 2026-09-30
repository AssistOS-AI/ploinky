(() => {
  function tokenFactory(prefix) {
    const fn = () => `@@${prefix}_${fn.__idx++}@@`;
    fn.__idx = 0;
    return fn;
  }

  function escapeHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttribute(str) {
    return escapeHtml(str).replace(/`/g, '&#96;');
  }

  function resolveBaseUrl(url) {
    return url.replace(/PLACEHOLDER_BASE_URL/g, (globalThis.window?.location?.origin || 'http://localhost'));
  }

  function sanitizeUrl(rawUrl) {
    try {
      const resolved = resolveBaseUrl(rawUrl);
      const url = new URL(resolved, (globalThis.window?.location?.origin || 'http://localhost'));
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch (_) {
      return null;
    }
    return null;
  }

  function extractCodeBlocks(input, store) {
    const createToken = tokenFactory('CODE_BLOCK');
    return input.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, lang, body) => {
      const token = createToken();
      store[token] = `<pre><code${lang ? ` data-lang="${escapeAttribute(lang.trim())}"` : ''}>${escapeHtml((body || '').replace(/\s+$/g, ''))}</code></pre>`;
      return `\n\n${token}\n\n`;
    });
  }

  function restorePlaceholders(value, placeholders) {
    let output = value;
    Object.keys(placeholders).forEach((token) => {
      output = output.split(token).join(placeholders[token]);
    });
    return output;
  }

  const TABLE_SEPARATOR_RE = /^:?-{1,}:?$/;

  function splitTableRow(row) {
    if (!row) return [];
    const trimmedRow = row.trim();
    if (!trimmedRow) return [];
    let start = 0;
    let end = trimmedRow.length;
    if (trimmedRow[start] === '|') start += 1;
    if (trimmedRow[end - 1] === '|') end -= 1;

    const cells = [];
    let current = '';
    let escaped = false;
    for (let i = start; i < end; i += 1) {
      const ch = trimmedRow[i];
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '|') {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  function parseAlignment(cell) {
    const cleaned = cell.replace(/\s+/g, '');
    if (!TABLE_SEPARATOR_RE.test(cleaned)) return null;
    const starts = cleaned.startsWith(':');
    const ends = cleaned.endsWith(':');
    if (starts && ends) return 'center';
    if (ends) return 'right';
    if (starts) return 'left';
    return null;
  }

  function analyzeTableBlock(block) {
    const trimmed = (block || '').trim();
    if (!trimmed) return null;
    const lines = trimmed
      .split(/\n/)
      .map((line) => line.replace(/\s+$/g, ''))
      .filter((line) => line.trim().length);
    if (lines.length < 2) return null;
    if (!lines[0].includes('|') || !lines[1].includes('|')) return null;

    const headerCells = splitTableRow(lines[0]);
    const separatorCells = splitTableRow(lines[1]);
    if (!headerCells.length || headerCells.length !== separatorCells.length) return null;
    if (!separatorCells.every((cell) => TABLE_SEPARATOR_RE.test(cell.replace(/\s+/g, '')))) return null;

    const alignments = separatorCells.map(parseAlignment);
    const bodyRows = [];
    for (let idx = 2; idx < lines.length; idx += 1) {
      const line = lines[idx];
      if (!line.includes('|')) return null;
      bodyRows.push(splitTableRow(line));
    }

    return { headerCells, alignments, bodyRows };
  }

  function alignAttr(value) {
    if (value === 'center') return ' style="text-align:center"';
    if (value === 'right') return ' style="text-align:right"';
    if (value === 'left') return ' style="text-align:left"';
    return '';
  }

  function tryRenderTable(block, state, processInline) {
    const info = analyzeTableBlock(block);
    if (!info) return null;

    const headHtml = info.headerCells
      .map((cell, idx) => `<th${alignAttr(info.alignments[idx])}>${processInline(cell)}</th>`)
      .join('');

    const bodyHtml = info.bodyRows
      .map((row) => {
        if (!row.some((cell) => cell.trim().length)) return '';
        const normalized = info.headerCells.map((_, idx) => processInline(row[idx] || ''));
        return `<tr>${normalized
          .map((cellHtml, idx) => `<td${alignAttr(info.alignments[idx])}>${cellHtml}</td>`)
          .join('')}</tr>`;
      })
      .filter(Boolean)
      .join('');

    const tableBody = bodyHtml ? `<tbody>${bodyHtml}</tbody>` : '';
    return `<div class="wa-md-table-wrap"><table class="wa-md-table"><thead><tr>${headHtml}</tr></thead>${tableBody}</table></div>`;
  }

  function extractTableFromMixedBlock(block) {
    const lines = block.split('\n');
    if (lines.length < 2) return null;

    for (let i = 0; i < lines.length - 1; i++) {
      const currentLine = lines[i];
      const nextLine = lines[i + 1];

      // Check if current and next line could be table header and separator
      if (!currentLine.includes('|') || !nextLine.includes('|')) continue;

      const headerCells = splitTableRow(currentLine);
      const separatorCells = splitTableRow(nextLine);

      if (!headerCells.length || headerCells.length !== separatorCells.length) continue;
      if (!separatorCells.every((cell) => TABLE_SEPARATOR_RE.test(cell.replace(/\s+/g, '')))) continue;

      // Found a table start at line i
      const tableStart = i;
      let tableEnd = i + 1; // At least header + separator

      // Find where the table ends
      for (let j = i + 2; j < lines.length; j++) {
        const line = lines[j];
        if (!line.includes('|')) break;
        tableEnd = j;
      }

      // Extract the parts
      const beforeTable = lines.slice(0, tableStart).join('\n').trim();
      const tableLines = lines.slice(tableStart, tableEnd + 1).join('\n');
      const afterTable = lines.slice(tableEnd + 1).join('\n').trim();

      return { beforeTable, tableLines, afterTable };
    }

    return null;
  }

  function processInlineFactory(state) {
    return function processInline(text) {
      if (!text) return '';

      const inlineToken = state.inlineCodeFactory;

      const inlineStore = {};
      let working = text.replace(/`([^`]+)`/g, (_, code) => {
        const token = inlineToken();
        inlineStore[token] = `<code>${escapeHtml(code)}</code>`;
        return token;
      });

      working = escapeHtml(working);

      // bold **text**
      working = working.replace(/\*\*([^*]+)\*\*/g, (_, bold) => `<strong>${bold}</strong>`);

      // italics *text*
      working = working.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, (match, lead, italic) => `${lead}<em>${italic}</em>`);

      // links [label](url)
      working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
        const safeUrl = sanitizeUrl(url.trim());
        if (!safeUrl) return `${resolveBaseUrl(label)} (${resolveBaseUrl(url)})`;
        const token = state.linkTokenFactory();
        // Also resolve PLACEHOLDER_BASE_URL in label text
        const resolvedLabel = resolveBaseUrl(label);
        state.placeholders[token] = `<a href="${escapeAttribute(safeUrl)}" target="_blank" rel="noopener noreferrer" data-wc-link="true">${escapeHtml(resolvedLabel)}</a>`;
        return token;
      });

      working = working.replace(/(^|\s)(https?:\/\/[^\s<]+)(?=$|\s)/g, (match, lead, url) => {
        const safeUrl = sanitizeUrl(url);
        if (!safeUrl) return match;
        const token = state.linkTokenFactory();
        state.placeholders[token] = `<a href="${escapeAttribute(safeUrl)}" target="_blank" rel="noopener noreferrer" data-wc-link="true">${escapeHtml(url)}</a>`;
        return `${lead}${token}`;
      });

      working = working.replace(/\n/g, '<br/>');

      Object.keys(inlineStore).forEach((token) => {
        working = working.split(token).join(inlineStore[token]);
      });

      return restorePlaceholders(working, state.placeholders);
    };
  }

  function renderList(block, type, state, processInline) {
    const lines = block.split(/\n/);
    const items = [];
    let current = '';
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const bulletRe = type === 'ul' ? /^[-*+]\s+(.*)$/ : /^\d+\.\s+(.*)$/;
      const match = trimmed.match(bulletRe);
      if (match) {
        if (current) items.push(current);
        current = match[1];
      } else if (current) {
        current += `\n${trimmed}`;
      }
    });
    if (current) items.push(current);
    const rendered = items.map((item) => `<li>${processInline(item)}</li>`).join('');
    return `<${type}>${rendered}</${type}>`;
  }

  function renderHeading(block, processInline) {
    const match = block.trim().match(/^(#{1,6})\s+(.*)$/);
    if (!match) return `<p>${processInline(block)}</p>`;
    const level = Math.min(match[1].length, 4);
    const content = processInline(match[2]);
    return `<h${level}>${content}</h${level}>`;
  }

  function renderBlockquote(block, state) {
    const cleaned = block
      .split(/\n/)
      .map((line) => line.replace(/^\s{0,3}>\s?/, ''))
      .join('\n');
    const inner = renderMarkdown(cleaned);
    return `<blockquote>${inner}</blockquote>`;
  }

  function renderMarkdown(src) {
    if (!src) return '';
    const state = {
      placeholders: {},
      inlineCodeFactory: tokenFactory('INLINE_CODE'),
      linkTokenFactory: tokenFactory('LINK_TOKEN')
    };
    const processInline = processInlineFactory(state);
    const codeStore = {};
    let input = extractCodeBlocks(String(src).replace(/\r\n?/g, '\n'), codeStore);

    input = input.replace(/\n(#{1,6}\s+)/g, (match, heading, offset, str) => {
      const prefix = str.slice(0, offset);
      const lastNewline = prefix.lastIndexOf('\n');
      const prevLine = lastNewline === -1 ? prefix : prefix.slice(lastNewline + 1);
      if (!prevLine.trim()) return '\n' + heading;
      return '\n\n' + heading;
    });

    input = input.replace(/^(#{1,6}\s+[^\n]+)\n(?!\s*\n)/gm, '$1\n\n');

    input = input.replace(/\n(?!\s*\n)(\s{0,3}[-*+]\s+)/g, (match, bullet, offset, str) => {
      const prefix = str.slice(0, offset);
      const lastNewline = prefix.lastIndexOf('\n');
      const prevLine = lastNewline === -1 ? prefix : prefix.slice(lastNewline + 1);
      if (/^\s{0,3}[-*+]\s+/.test(prevLine)) return '\n' + bullet;
      return '\n\n' + bullet;
    });

    input = input.replace(/\n(?!\s*\n)(\s{0,3}\d+\.\s+)/g, (match, bullet, offset, str) => {
      const prefix = str.slice(0, offset);
      const lastNewline = prefix.lastIndexOf('\n');
      const prevLine = lastNewline === -1 ? prefix : prefix.slice(lastNewline + 1);
      if (/^\s{0,3}\d+\.\s+/.test(prevLine)) return '\n' + bullet;
      return '\n\n' + bullet;
    });

    const blocks = input.split(/\n{2,}/);

    let html = blocks
      .map((block) => {
        const trimmed = block.trim();
        if (!trimmed) return '';
        if (codeStore[trimmed]) return codeStore[trimmed];
        const tableHtml = tryRenderTable(trimmed, state, processInline);
        if (tableHtml) return tableHtml;

        // If a table appears inside a larger block with text before/after it,
        // extract the table and render each part separately
        const mixedTable = extractTableFromMixedBlock(trimmed);
        if (mixedTable) {
          const parts = [];
          if (mixedTable.beforeTable) {
            parts.push(renderMarkdown(mixedTable.beforeTable));
          }
          const tableRendered = tryRenderTable(mixedTable.tableLines, state, processInline);
          if (tableRendered) {
            parts.push(tableRendered);
          }
          if (mixedTable.afterTable) {
            parts.push(renderMarkdown(mixedTable.afterTable));
          }
          if (parts.length) return parts.join('');
        }

        // If an HR (---, ***, ___) appears inside a larger block because
        // the text wasn't split with two blank lines, split the block
        // around each HR and render recursively so <hr/> is produced.
        // This is more forgiving than strict Markdown and fixes cases like:
        // "---\n## Next heading" (single blank around HR)
        const hrLineInBlock = /(^|\n)\s*[-*_]{3,}\s*(\n|$)/;
        if (hrLineInBlock.test(trimmed) && !/^[-*_]{3,}$/.test(trimmed)) {
          const segments = trimmed.split(/\n?\s*[-*_]{3,}\s*\n?/g);
          const rendered = segments
            .map(seg => seg.trim() ? renderMarkdown(seg) : '')
            .filter(Boolean)
            .join('<hr/>' );
          if (rendered) return rendered;
        }
        if (/^\s{0,3}[-*+]\s+/.test(trimmed)) return renderList(trimmed, 'ul', state, processInline);
        if (/^\s{0,3}\d+\.\s+/.test(trimmed)) return renderList(trimmed, 'ol', state, processInline);

        const nestedBulletIdx = trimmed.search(/\n\s{0,3}[-*+]\s+/);
        if (nestedBulletIdx !== -1) {
          const listPart = trimmed.slice(nestedBulletIdx).trim();
          const leadPart = trimmed.slice(0, nestedBulletIdx).trim();
          const listLines = listPart.split(/\n/).filter(Boolean);
          const allBullets = listLines.every((line) => /^\s{0,3}[-*+]\s+/.test(line));
          if (allBullets) {
            const pieces = [];
            if (leadPart) pieces.push(`<p>${processInline(leadPart)}</p>`);
            pieces.push(renderList(listPart, 'ul', state, processInline));
            return pieces.join('');
          }
        }

        const nestedOrderedIdx = trimmed.search(/\n\s{0,3}\d+\.\s+/);
        if (nestedOrderedIdx !== -1) {
          const listPart = trimmed.slice(nestedOrderedIdx).trim();
          const leadPart = trimmed.slice(0, nestedOrderedIdx).trim();
          const listLines = listPart.split(/\n/).filter(Boolean);
          const allOrdered = listLines.every((line) => /^\s{0,3}\d+\.\s+/.test(line));
          if (allOrdered) {
            const pieces = [];
            if (leadPart) pieces.push(`<p>${processInline(leadPart)}</p>`);
            pieces.push(renderList(listPart, 'ol', state, processInline));
            return pieces.join('');
          }
        }
        if (/^#{1,6}\s/.test(trimmed)) {
          const lines = trimmed.split('\n');
          const headingLine = lines.shift();
          const headingHtml = renderHeading(headingLine, processInline);
          const remainder = lines.join('\n').trim();
          if (!remainder) return headingHtml;
          return headingHtml + renderMarkdown(remainder);
        }
        if (/^\s{0,3}>\s?/.test(trimmed)) return renderBlockquote(trimmed, state);
        if (/^[-*_]{3,}$/.test(trimmed)) return '<hr/>';
        return `<p>${processInline(trimmed)}</p>`;
      })
      .filter(Boolean)
      .join('');

    html = restorePlaceholders(html, state.placeholders);

    return html;
  }

  const target = typeof window === 'undefined' ? globalThis : window;
  target.webchatMarkdown = {
    render: renderMarkdown
  };
})();
