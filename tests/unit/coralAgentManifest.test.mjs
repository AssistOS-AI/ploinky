/**
 * Test that coral-agent manifest correctly uses wildcard env expansion.
 * This test simulates the environment from ~/work/.env
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getManifestEnvSpecs } from '../../cli/utils/security/secretVars.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to test fixture manifest with wildcard env declarations
const CORAL_MANIFEST_PATH = path.resolve(__dirname, '../fixtures/coral-agent/manifest.json');

// Simulate environment variables from ~/work/.env
function setupTestEnv() {
    // LLM Model definitions
    process.env.LLM_MODEL_01 = 'axiologic_kiro/auto-kiro|deep|3|15|200k';
    process.env.LLM_MODEL_02 = 'axiologic_kiro/claude-sonnet-4.5|deep|3|15|200k';
    process.env.LLM_MODEL_03 = 'axiologic_kiro/claude-sonnet-4|deep|3|15|200k';
    process.env.LLM_MODEL_04 = 'axiologic_kiro/claude-3.7-sonnet|deep|3|15|200k';
    process.env.LLM_MODEL_05 = 'axiologic_kiro/claude-haiku-4.5|fast|1|5|200k';
    process.env.LLM_MODEL_06 = 'axiologic_antigravity/gemini-2.5-pro|deep|0|0|1mill';
    process.env.LLM_MODEL_07 = 'axiologic_antigravity/gemini-2.5-flash|fast|0|0|1mill';
    process.env.LLM_MODEL_08 = 'axiologic_antigravity/gemini-2.5-flash-lite|fast|0|0|1mill';
    process.env.LLM_MODEL_09 = 'axiologic_antigravity/gemini-2.5-flash-thinking|deep|0|0|1mill';
    process.env.LLM_MODEL_10 = 'axiologic_antigravity/gemini-3-flash|fast|0|0|1mill';
    
    // Achilles configuration
    process.env.ACHILLES_ORCHESTRATOR_MODE = 'deep';
    process.env.ACHILLES_DEFAULT_FAST_MODEL = 'axiologic_antigravity/gemini-2.5-flash-lite';
    process.env.ACHILLES_DEFAULT_DEEP_MODEL = 'axiologic_antigravity/claude-opus-4-5-thinking';
    process.env.ACHILLES_ENABLED_FAST_MODELS = 'model1,model2,model3';
    process.env.ACHILLES_ENABLED_DEEP_MODELS = 'model4,model5';
    process.env.ACHILLES_DEBUG = 'true';
    
    // Provider URLs
    process.env.OPENAI_AXIOLOGIC_KIRO_URL = 'https://kiro.axiologic.dev/v1/chat/completions';
    process.env.OPENAI_AXIOLOGIC_KIRO_KEY_ENV = 'AXIOLOGIC_API_KEY';
    process.env.OPENAI_OPENCODE_URL = 'https://opencode.ai/zen/v1/chat/completions';
    process.env.ANTHROPIC_AXIOLOGIC_ANTIGRAVITY_URL = 'https://antigravity.axiologic.dev/v1/messages';
    process.env.ANTHROPIC_AXIOLOGIC_ANTIGRAVITY_KEY_ENV = 'AXIOLOGIC_API_KEY';
    
    // API Keys
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic';
    process.env.GEMINI_API_KEY = 'sk-test-gemini';
    process.env.AXIOLOGIC_API_KEY = 'sk-test-axiologic';
    process.env.OPENROUTER_API_KEY = 'sk-test-openrouter';
    
    // Coral-specific
    process.env.PERSISTO_URL = 'http://localhost:3000';
    process.env.PERSISTO_HOST = 'localhost';
    process.env.PERSISTO_PORT = '3000';
    process.env.WORKSPACE_PATH = '/workspace';
    process.env.CORAL_AGENT_LOG_DIR = '/logs';
    process.env.FILE_PARSER_AGENT_NAME = 'file-parser-agent';
    process.env.FILE_PARSER_TOOL_NAME = 'process_documents';
    process.env.FILE_PARSER_MCP_URL = 'http://localhost:8080/mcp';
    process.env.PLOINKY_ROUTER_URL = 'http://localhost:8080';
    process.env.PLOINKY_ROUTER_PORT = '8080';
}

function cleanupTestEnv() {
    const envVars = [
        'LLM_MODEL_01', 'LLM_MODEL_02', 'LLM_MODEL_03', 'LLM_MODEL_04', 'LLM_MODEL_05',
        'LLM_MODEL_06', 'LLM_MODEL_07', 'LLM_MODEL_08', 'LLM_MODEL_09', 'LLM_MODEL_10',
        'ACHILLES_ORCHESTRATOR_MODE', 'ACHILLES_DEFAULT_FAST_MODEL', 'ACHILLES_DEFAULT_DEEP_MODEL',
        'ACHILLES_ENABLED_FAST_MODELS', 'ACHILLES_ENABLED_DEEP_MODELS', 'ACHILLES_DEBUG',
        'OPENAI_AXIOLOGIC_KIRO_URL', 'OPENAI_AXIOLOGIC_KIRO_KEY_ENV', 'OPENAI_OPENCODE_URL',
        'ANTHROPIC_AXIOLOGIC_ANTIGRAVITY_URL', 'ANTHROPIC_AXIOLOGIC_ANTIGRAVITY_KEY_ENV',
        'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'AXIOLOGIC_API_KEY', 'OPENROUTER_API_KEY',
        'PERSISTO_URL', 'PERSISTO_HOST', 'PERSISTO_PORT', 'WORKSPACE_PATH', 'CORAL_AGENT_LOG_DIR',
        'FILE_PARSER_AGENT_NAME', 'FILE_PARSER_TOOL_NAME', 'FILE_PARSER_MCP_URL',
        'PLOINKY_ROUTER_URL', 'PLOINKY_ROUTER_PORT'
    ];
    envVars.forEach(v => delete process.env[v]);
}

test('coral-agent manifest: should load and parse', () => {
    assert.ok(fs.existsSync(CORAL_MANIFEST_PATH), 'Coral manifest should exist');
    const content = fs.readFileSync(CORAL_MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(content);
    assert.ok(manifest.profiles?.default?.env, 'Should have default profile env');
    console.log('  ✓ Coral manifest loads and parses correctly');
});

test('coral-agent manifest: should expand LLM_MODEL_* wildcard', () => {
    setupTestEnv();
    try {
        const manifest = JSON.parse(fs.readFileSync(CORAL_MANIFEST_PATH, 'utf8'));
        const profileConfig = manifest.profiles.default;
        const specs = getManifestEnvSpecs(manifest, profileConfig);
        const names = specs.map(s => s.insideName);
        
        // Check LLM models are expanded
        assert.ok(names.includes('LLM_MODEL_01'), 'Should include LLM_MODEL_01');
        assert.ok(names.includes('LLM_MODEL_05'), 'Should include LLM_MODEL_05');
        assert.ok(names.includes('LLM_MODEL_10'), 'Should include LLM_MODEL_10');
        
        const llmModels = names.filter(n => n.startsWith('LLM_MODEL_'));
        console.log(`  ✓ LLM_MODEL_* expanded to ${llmModels.length} variables`);
    } finally {
        cleanupTestEnv();
    }
});

test('coral-agent manifest: should expand ACHILLES_* wildcard', () => {
    setupTestEnv();
    try {
        const manifest = JSON.parse(fs.readFileSync(CORAL_MANIFEST_PATH, 'utf8'));
        const profileConfig = manifest.profiles.default;
        const specs = getManifestEnvSpecs(manifest, profileConfig);
        const names = specs.map(s => s.insideName);
        
        assert.ok(names.includes('ACHILLES_ORCHESTRATOR_MODE'), 'Should include ACHILLES_ORCHESTRATOR_MODE');
        assert.ok(names.includes('ACHILLES_DEFAULT_FAST_MODEL'), 'Should include ACHILLES_DEFAULT_FAST_MODEL');
        assert.ok(names.includes('ACHILLES_DEFAULT_DEEP_MODEL'), 'Should include ACHILLES_DEFAULT_DEEP_MODEL');
        assert.ok(names.includes('ACHILLES_ENABLED_FAST_MODELS'), 'Should include ACHILLES_ENABLED_FAST_MODELS');
        assert.ok(names.includes('ACHILLES_DEBUG'), 'Should include ACHILLES_DEBUG');
        
        const achillesVars = names.filter(n => n.startsWith('ACHILLES_'));
        console.log(`  ✓ ACHILLES_* expanded to ${achillesVars.length} variables`);
    } finally {
        cleanupTestEnv();
    }
});

test('coral-agent manifest: should expand OPENAI_*_URL wildcard', () => {
    setupTestEnv();
    try {
        const manifest = JSON.parse(fs.readFileSync(CORAL_MANIFEST_PATH, 'utf8'));
        const profileConfig = manifest.profiles.default;
        const specs = getManifestEnvSpecs(manifest, profileConfig);
        const names = specs.map(s => s.insideName);
        
        assert.ok(names.includes('OPENAI_AXIOLOGIC_KIRO_URL'), 'Should include OPENAI_AXIOLOGIC_KIRO_URL');
        assert.ok(names.includes('OPENAI_OPENCODE_URL'), 'Should include OPENAI_OPENCODE_URL');
        
        const providerUrls = names.filter(n => n.match(/^OPENAI_.*_URL$/));
        console.log(`  ✓ OPENAI_*_URL expanded to ${providerUrls.length} variables`);
    } finally {
        cleanupTestEnv();
    }
});

test('coral-agent manifest: should include explicit API keys', () => {
    setupTestEnv();
    try {
        const manifest = JSON.parse(fs.readFileSync(CORAL_MANIFEST_PATH, 'utf8'));
        const profileConfig = manifest.profiles.default;
        const specs = getManifestEnvSpecs(manifest, profileConfig);
        const names = specs.map(s => s.insideName);
        
        // Explicit API keys should be included
        assert.ok(names.includes('OPENAI_API_KEY'), 'Should include OPENAI_API_KEY');
        assert.ok(names.includes('ANTHROPIC_API_KEY'), 'Should include ANTHROPIC_API_KEY');
        assert.ok(names.includes('GEMINI_API_KEY'), 'Should include GEMINI_API_KEY');
        assert.ok(names.includes('AXIOLOGIC_API_KEY'), 'Should include AXIOLOGIC_API_KEY');
        assert.ok(names.includes('OPENROUTER_API_KEY'), 'Should include OPENROUTER_API_KEY');
        
        console.log('  ✓ All explicit API keys are included');
    } finally {
        cleanupTestEnv();
    }
});

test('coral-agent manifest: should include Coral-specific variables', () => {
    setupTestEnv();
    try {
        const manifest = JSON.parse(fs.readFileSync(CORAL_MANIFEST_PATH, 'utf8'));
        const profileConfig = manifest.profiles.default;
        const specs = getManifestEnvSpecs(manifest, profileConfig);
        const names = specs.map(s => s.insideName);
        
        // Coral-specific variables
        assert.ok(names.includes('PERSISTO_URL'), 'Should include PERSISTO_URL');
        assert.ok(names.includes('PERSISTO_HOST'), 'Should include PERSISTO_HOST');
        assert.ok(names.includes('PERSISTO_PORT'), 'Should include PERSISTO_PORT');
        assert.ok(names.includes('WORKSPACE_PATH'), 'Should include WORKSPACE_PATH');
        assert.ok(names.includes('CORAL_AGENT_LOG_DIR'), 'Should include CORAL_AGENT_LOG_DIR');
        assert.ok(names.includes('FILE_PARSER_AGENT_NAME'), 'Should include FILE_PARSER_AGENT_NAME');
        assert.ok(names.includes('FILE_PARSER_TOOL_NAME'), 'Should include FILE_PARSER_TOOL_NAME');
        assert.ok(names.includes('FILE_PARSER_MCP_URL'), 'Should include FILE_PARSER_MCP_URL');
        assert.ok(names.includes('PLOINKY_ROUTER_URL'), 'Should include PLOINKY_ROUTER_URL');
        assert.ok(names.includes('PLOINKY_ROUTER_PORT'), 'Should include PLOINKY_ROUTER_PORT');
        
        console.log('  ✓ All Coral-specific variables are included');
    } finally {
        cleanupTestEnv();
    }
});

test('coral-agent manifest: total variable count summary', () => {
    setupTestEnv();
    try {
        const manifest = JSON.parse(fs.readFileSync(CORAL_MANIFEST_PATH, 'utf8'));
        const profileConfig = manifest.profiles.default;
        const specs = getManifestEnvSpecs(manifest, profileConfig);
        const names = specs.map(s => s.insideName);
        
        const summary = {
            'LLM_MODEL_*': names.filter(n => n.startsWith('LLM_MODEL_')).length,
            'ACHILLES_*': names.filter(n => n.startsWith('ACHILLES_')).length,
            'OPENAI_*_URL': names.filter(n => n.match(/^OPENAI_.*_URL$/)).length,
            'OPENAI_*_KEY_ENV': names.filter(n => n.match(/^OPENAI_.*_KEY_ENV$/)).length,
            'ANTHROPIC_*_URL': names.filter(n => n.match(/^ANTHROPIC_.*_URL$/)).length,
            'API Keys': names.filter(n => n.includes('API_KEY')).length,
            'Coral-specific': names.filter(n => 
                n.startsWith('PERSISTO_') || n.startsWith('CORAL_') || 
                n.startsWith('FILE_PARSER_') || n.startsWith('PLOINKY_') ||
                n === 'WORKSPACE_PATH'
            ).length,
            'Total': names.length
        };
        
        console.log('\n  Environment variable summary:');
        for (const [category, count] of Object.entries(summary)) {
            console.log(`    ${category}: ${count}`);
        }
        
        assert.ok(summary.Total > 20, 'Should have more than 20 total variables');
        console.log(`\n  ✓ Total: ${summary.Total} environment variables will be injected`);
    } finally {
        cleanupTestEnv();
    }
});
