#!/usr/bin/env node
/**
 * Demo script showing wildcard env variable expansion with real .env file.
 * Run: node tests/unit/wildcardDemo.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    expandEnvWildcard,
    getManifestEnvSpecs,
    isApiKeyVariable
} from '../../cli/utils/security/secretVars.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the .env file from ~/work/.env
const envPath = path.resolve(__dirname, '../../../../.env');
console.log('='.repeat(60));
console.log('Wildcard Environment Variable Demo');
console.log('='.repeat(60));
console.log(`\nLoading .env from: ${envPath}\n`);

function parseEnvFile(filePath) {
    const result = {};
    try {
        const contents = fs.readFileSync(filePath, 'utf8');
        for (const line of contents.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf(' ');
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const value = trimmed.slice(eqIdx + 1).trim();
            if (key) result[key] = value;
        }
    } catch (e) {
        // Try KEY=VALUE format
        try {
            const contents = fs.readFileSync(filePath, 'utf8');
            for (const line of contents.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx === -1) continue;
                const key = trimmed.slice(0, eqIdx).trim();
                const value = trimmed.slice(eqIdx + 1).trim();
                if (key) result[key] = value;
            }
        } catch (_) {}
    }
    return result;
}

try {
    const envVars = parseEnvFile(envPath);
    
    // Inject into process.env for the demo
    for (const [key, value] of Object.entries(envVars)) {
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
    
    console.log(`Loaded ${Object.keys(envVars).length} variables from .env\n`);
} catch (e) {
    console.log(`Note: Could not load .env file (${e.message}), using process.env only\n`);
}

// Demo 1: LLM_MODEL_* expansion
console.log('-'.repeat(60));
console.log('Demo 1: LLM_MODEL_* wildcard expansion');
console.log('-'.repeat(60));
const llmModels = expandEnvWildcard('LLM_MODEL_*');
console.log(`Found ${llmModels.length} variables matching LLM_MODEL_*:`);
llmModels.forEach(name => {
    const value = process.env[name];
    const truncated = value?.length > 50 ? value.substring(0, 50) + '...' : value;
    console.log(`  ${name} = ${truncated}`);
});

// Demo 2: ACHILLES_* expansion
console.log('\n' + '-'.repeat(60));
console.log('Demo 2: ACHILLES_* wildcard expansion');
console.log('-'.repeat(60));
const achillesVars = expandEnvWildcard('ACHILLES_*');
console.log(`Found ${achillesVars.length} variables matching ACHILLES_*:`);
achillesVars.forEach(name => {
    const value = process.env[name];
    const truncated = value?.length > 50 ? value.substring(0, 50) + '...' : value;
    console.log(`  ${name} = ${truncated}`);
});

// Demo 3: OPENAI_*_URL expansion
console.log('\n' + '-'.repeat(60));
console.log('Demo 3: OPENAI_*_URL wildcard expansion');
console.log('-'.repeat(60));
const openaiUrls = expandEnvWildcard('OPENAI_*_URL');
console.log(`Found ${openaiUrls.length} variables matching OPENAI_*_URL:`);
openaiUrls.forEach(name => {
    console.log(`  ${name} = ${process.env[name]}`);
});

// Demo 4: API_KEY detection
console.log('\n' + '-'.repeat(60));
console.log('Demo 4: API_KEY detection (excluded from * wildcard)');
console.log('-'.repeat(60));
const allVars = Object.keys(process.env);
const apiKeyVars = allVars.filter(isApiKeyVariable);
console.log(`Found ${apiKeyVars.length} API_KEY variables that would be excluded from *:`);
apiKeyVars.slice(0, 10).forEach(name => {
    console.log(`  ${name} (excluded)`);
});
if (apiKeyVars.length > 10) {
    console.log(`  ... and ${apiKeyVars.length - 10} more`);
}

// Demo 5: Full manifest simulation
console.log('\n' + '-'.repeat(60));
console.log('Demo 5: Full manifest with wildcards');
console.log('-'.repeat(60));

const sampleManifest = {
    container: 'node:20-bullseye',
    env: [
        'LLM_MODEL_*',           // All LLM model definitions
        'ACHILLES_*',            // All Achilles configuration
        'OPENAI_*_URL',          // All OpenAI provider URLs
        'ANTHROPIC_*_URL',       // All Anthropic provider URLs
        'DATABASE_URL=default',  // Explicit with default
        'LOG_LEVEL=info',        // Explicit with default
        // Note: API keys must be explicit
        'OPENAI_API_KEY',
        'AXIOLOGIC_API_KEY'
    ]
};

console.log('Sample manifest.json:');
console.log(JSON.stringify(sampleManifest, null, 2));

console.log('\nResolved environment variables:');
const specs = getManifestEnvSpecs(sampleManifest);
console.log(`Total: ${specs.length} variables\n`);

// Group by pattern
const groups = {
    'LLM_MODEL_*': specs.filter(s => s.insideName.startsWith('LLM_MODEL_')),
    'ACHILLES_*': specs.filter(s => s.insideName.startsWith('ACHILLES_')),
    'OPENAI_*_URL': specs.filter(s => s.insideName.match(/^OPENAI_.*_URL$/)),
    'ANTHROPIC_*_URL': specs.filter(s => s.insideName.match(/^ANTHROPIC_.*_URL$/)),
    'Explicit': specs.filter(s => 
        !s.insideName.startsWith('LLM_MODEL_') &&
        !s.insideName.startsWith('ACHILLES_') &&
        !s.insideName.match(/^OPENAI_.*_URL$/) &&
        !s.insideName.match(/^ANTHROPIC_.*_URL$/)
    )
};

for (const [pattern, vars] of Object.entries(groups)) {
    if (vars.length > 0) {
        console.log(`${pattern}: ${vars.length} variables`);
        vars.slice(0, 5).forEach(v => console.log(`  - ${v.insideName}`));
        if (vars.length > 5) {
            console.log(`  ... and ${vars.length - 5} more`);
        }
    }
}

console.log('\n' + '='.repeat(60));
console.log('Demo complete!');
console.log('='.repeat(60));
