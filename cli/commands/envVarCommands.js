import path from 'path';
import { showHelp } from './help.js';
import * as envSvc from '../utils/security/secretVars.js';
import { findAgent } from '../utils/utils.js';
import {
    assertActiveEdgeRoutingSourcesCurrent,
    inactivateEdgeRoutingGeneration,
    readEdgeRoutingSelection,
    withEdgeGenerationApplyLock,
} from '../sandbox/edgeGeneration.js';

const INLINE_ASSIGNMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseInlineAssignmentToken(token) {
    if (typeof token !== 'string') return null;
    if (!token || token.includes('/') || token.includes('\\') || token.startsWith('$')) return null;
    const separators = ['=', ':'];
    let separatorIndex = -1;
    for (const sep of separators) {
        const idx = token.indexOf(sep);
        if (idx > 0 && (separatorIndex === -1 || idx < separatorIndex)) {
            separatorIndex = idx;
        }
    }
    if (separatorIndex <= 0) return null;
    const name = token.slice(0, separatorIndex);
    if (!INLINE_ASSIGNMENT_NAME.test(name)) return null;
    const value = token.slice(separatorIndex + 1);
    return { name, value };
}

function expandInlineAssignment(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) return tokens;
    const assignment = parseInlineAssignmentToken(tokens[0]);
    if (!assignment) return tokens;
    return [assignment.name, assignment.value, ...tokens.slice(1)];
}

function setVarValue(varName, valueOrAlias) {
    if (!varName || typeof valueOrAlias !== 'string' || valueOrAlias.length === 0) {
        showHelp();
        throw new Error('Usage: var <VAR> <value|$OTHER>');
    }
    envSvc.setEnvVar(varName, valueOrAlias);
    console.log(`✓ Set variable '${varName}'.`);
}

function handleVarsCommand() {
    try {
        const env = envSvc;
        let secrets = env.parseSecrets();
        if (!secrets.APP_NAME || !String(secrets.APP_NAME).trim()) {
            try { env.setEnvVar('APP_NAME', path.basename(process.cwd())); } catch (_) { }
        }
        const merged = env.parseSecrets();
        const printOrder = ['APP_NAME'];
        const keys = Array.from(new Set([...printOrder, ...Object.keys(merged).sort()]));
        keys.forEach(k => console.log(`${k}=${merged[k] ?? ''}`));
    } catch (e) { console.error('Failed to list variables:', e.message); }
}

function handleVarCommand(options = []) {
    const assignment = parseInlineAssignmentToken(options[0]);
    const normalized = expandInlineAssignment(options).filter(item => item !== undefined);
    const name = normalized[0];
    let valueTokens = normalized.slice(1);
    if (assignment && assignment.value === '' && valueTokens.length > 1 && valueTokens[0] === '') {
        valueTokens = valueTokens.slice(1);
    }
    const value = valueTokens.join(' ');
    if (!name || !value) { showHelp(); throw new Error('Usage: var <VAR> <value>'); }
    setVarValue(name, value);
}

function handleEchoCommand(options = []) {
    if (!options[0]) { showHelp(); throw new Error('Usage: echo <VAR|$VAR>'); }
    const output = envSvc.echoVar(options[0]);
    console.log(output);
}

function handleExposeCommand(options = []) {
    if (!options[0]) { showHelp(); throw new Error('Usage: expose <EXPOSED_NAME> [<$VAR|value>] [agentName]'); }
    const assignment = parseInlineAssignmentToken(options[0]);
    const normalized = expandInlineAssignment(options).filter(item => item !== undefined);
    const exposedName = normalized[0];
    if (!exposedName) { showHelp(); throw new Error('Usage: expose <EXPOSED_NAME> [<$VAR|value>] [agentName]'); }
    const remainder = normalized.slice(1);
    let valueArg = remainder.length ? remainder.shift() : undefined;
    if (assignment && assignment.value === '' && valueArg === '' && remainder.length) {
        valueArg = remainder.shift();
    }
    let agentArg = remainder.length ? remainder.shift() : undefined;
    if (remainder.length) {
        agentArg = agentArg === undefined ? remainder.join(' ') : [agentArg, ...remainder].join(' ');
    }

    if (agentArg === undefined) {
        if (!valueArg) {
            valueArg = undefined;
        } else if (typeof valueArg === 'string' && valueArg.startsWith('$')) {
            agentArg = undefined;
        } else {
            let agentLookup = null;
            try { agentLookup = findAgent(valueArg); } catch (_) { agentLookup = null; }
            if (agentLookup) {
                agentArg = valueArg;
                valueArg = undefined;
            }
        }
    }

    try {
        const res = withEdgeGenerationApplyLock((applyLockCapability) => {
            return envSvc.exposeEnv(exposedName, valueArg, agentArg, {
                beforeWrite() {
                    const selection = readEdgeRoutingSelection();
                    if (selection.selector.state === 'active') {
                        assertActiveEdgeRoutingSourcesCurrent({ applyLockCapability });
                        inactivateEdgeRoutingGeneration('agent-expose-manifest-change', {
                            applyLockCapability,
                        });
                    }
                },
            });
        });
        console.log(`✓ Exposed '${exposedName}' for agent '${res.agentName}'.`);
    } catch (err) {
        throw new Error(`expose failed: ${err?.message || err}`);
    }
}

export {
    handleVarsCommand,
    handleVarCommand,
    handleEchoCommand,
    handleExposeCommand,
};
