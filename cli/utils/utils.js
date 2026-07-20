import fs from 'fs';
import path from 'path';
import { REPOS_DIR, isDebugMode } from './config.js';

// Simple ANSI color helpers
const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m'
};
function colorize(text, color) {
  try { if (!process.stdout.isTTY) return String(text); } catch (_) { return String(text); }
  const c = ANSI[color] || '';
  return c ? (c + String(text) + ANSI.reset) : String(text);
}

function debugLog(...args) {
    if (isDebugMode()) {
        console.log('[DEBUG]', ...args);
    }
}

/**
 * Finds the manifest.json for a given agent name.
 * @param {string} agentName - The short name or prefixed name (repo:agent) of the agent.
 * @returns {{manifestPath: string, repo: string, shortAgentName: string}} Details of the found agent.
 * @throws {Error} If the agent is not found or the name is ambiguous.
 */
function findAgent(agentName) {
    debugLog(`Searching for agent '${agentName}'...`);
    if (agentName.includes(':') || agentName.includes('/')) {
        const [repoName, shortAgentName] = agentName.split(/[:/]/);
        const manifestPath = path.join(REPOS_DIR, repoName, shortAgentName, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            debugLog(`Found agent directly with prefixed name: ${manifestPath}`);
            return { manifestPath, repo: repoName, shortAgentName };
        } else {
            throw new Error(`Agent '${agentName}' not found.`);
        }
    }

    const foundAgents = [];
    if (!fs.existsSync(REPOS_DIR)) {
        throw new Error("Ploinky environment not initialized. No repos found.");
    }
    const repos = fs.readdirSync(REPOS_DIR);
    debugLog(`Searching in repos: ${repos.join(', ')}`);
    for (const repo of repos) {
        const repoPath = path.join(REPOS_DIR, repo);
        if (fs.statSync(repoPath).isDirectory()) {
            const agentPath = path.join(repoPath, agentName);
            const manifestPath = path.join(agentPath, 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                debugLog(`Found potential match in repo '${repo}': ${manifestPath}`);
                foundAgents.push({ manifestPath, repo: repo, shortAgentName: agentName });
            }
        }
    }

    if (foundAgents.length === 0) {
        throw new Error(`Agent '${agentName}' not found.`);
    }

    if (foundAgents.length > 1) {
        const ambiguousAgents = foundAgents.map(a => `${a.repo}:${a.shortAgentName}`);
        throw new Error(`Agent name '${agentName}' is ambiguous. Please use one of the following:\n${ambiguousAgents.join('\n')}`);
    }

    debugLog(`Resolved agent '${agentName}' to: ${foundAgents[0].manifestPath}`);
    return foundAgents[0];
}

/**
 * Lists all agents across repos.
 * @returns {Array<{repo:string,name:string,manifestPath:string}>}
 */
function listAgentsDetailed() {
  const out = [];
  if (!fs.existsSync(REPOS_DIR)) return out;
  for (const repo of fs.readdirSync(REPOS_DIR)) {
    const repoPath = path.join(REPOS_DIR, repo);
    try {
      if (!fs.statSync(repoPath).isDirectory()) continue;
      for (const name of fs.readdirSync(repoPath)) {
        const mp = path.join(repoPath, name, 'manifest.json');
        try { if (fs.existsSync(mp)) out.push({ repo, name, manifestPath: mp }); } catch(_){}
      }
    } catch(_){}
  }
  return out;
}

/**
 * Returns agent name suggestions for completion.
 * Includes unique short names and repo/name for all.
 */
function getAgentNameSuggestions() {
  const list = listAgentsDetailed();
  const counts = {};
  list.forEach(a => { counts[a.name] = (counts[a.name]||0)+1; });
  const suggestions = new Set();
  for (const a of list) {
    suggestions.add(`${a.repo}/${a.name}`);
    if (counts[a.name] === 1) suggestions.add(a.name);
  }
  return Array.from(suggestions).sort();
}


/**
 * Parses a parameter string into a JSON object.
 * The format is: name=John,life.age=18,life.height="188 cm",hobbies[]=coding,reading,hiking
 * @param {string} paramString
 * @returns {object}
 */
function parseParametersString(paramString) {
    const result = {};
    if (!paramString || !String(paramString).trim()) return result;

    const s = String(paramString);
    let i = 0;

    function skipWs() { while (i < s.length && /\s/.test(s[i])) i++; }
    function readKey() {
        // keys start with '-'
        if (s[i] !== '-') return null;
        i++; // skip '-'
        const start = i;
        while (i < s.length && !/\s/.test(s[i])) i++;
        return s.slice(start, i);
    }
    function readQuoted() {
        // assumes s[i] === '"'
        i++; const start = i;
        let out = '';
        let escaped = false;
        while (i < s.length) {
            const ch = s[i];
            if (!escaped && ch === '"') { i++; break; }
            if (!escaped && ch === '\\') { escaped = true; i++; continue; }
            out += ch; escaped = false; i++;
        }
        return out;
    }
    function readToken() {
        skipWs();
        if (i >= s.length) return '';
        if (s[i] === '"') return readQuoted();
        const start = i;
        while (i < s.length && !/\s/.test(s[i]) && s[i] !== '[' && s[i] !== ']') i++;
        return s.slice(start, i);
    }
    function readArray() {
        // expects current char at '['
        if (s[i] !== '[') return [];
        i++; // skip '['
        const arr = [];
        while (i < s.length) {
            skipWs();
            if (i >= s.length) break;
            if (s[i] === ']') { i++; break; }
            let val;
            if (s[i] === '"') val = readQuoted();
            else {
                const start = i;
                while (i < s.length && !/\s|\]/.test(s[i])) i++;
                val = s.slice(start, i);
            }
            if (val !== undefined && val !== '') arr.push(parseValue(String(val)));
        }
        return arr;
    }

    while (i < s.length) {
        skipWs();
        if (i >= s.length) break;
        if (s[i] !== '-') { // ignore free text
            // consume until next whitespace
            while (i < s.length && !/\s/.test(s[i])) i++;
            continue;
        }
        const keyPath = readKey();
        if (!keyPath) break;
        skipWs();
        let value;
        if (s[i] === '[') {
            value = readArray();
        } else if (s[i] === '"') {
            value = readQuoted();
            value = parseValue('"' + value + '"');
        } else {
            const tok = readToken();
            value = parseValue(tok);
        }
        // If no value provided (e.g., '-flag' end of string), set empty string
        if (value === undefined) value = '';
        setValue(result, keyPath, value);
    }

    return result;
}

function setValue(obj, path, value) {
    const keys = path.split('.');
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (!current[key] || typeof current[key] !== 'object') {
            current[key] = {};
        }
        current = current[key];
    }

    let lastKey = keys[keys.length - 1];

    if (lastKey.endsWith('[]')) {
        lastKey = lastKey.slice(0, -2);
        if (!current[lastKey]) {
            current[lastKey] = [];
        }
        if (typeof value === 'string' && value) {
            current[lastKey].push(...value.split(','));
        } else if (typeof value === 'string' && !value) {
            // do nothing, this is an empty array
        } else if (value) {
            current[lastKey].push(value);
        }
    } else {
        current[lastKey] = value;
    }
}

function parseValue(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (!value.startsWith('"') && !value.endsWith('"')) {
        const num = Number(value);
        if (!isNaN(num) && String(num) === value) {
            return num;
        }
    }
    if (value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1);
    }
    return value;
}
export { findAgent, debugLog, ANSI, colorize, listAgentsDetailed, getAgentNameSuggestions, parseParametersString };
