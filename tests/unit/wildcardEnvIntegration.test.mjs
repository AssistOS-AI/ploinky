/**
 * Integration tests for wildcard environment variable expansion.
 * These tests simulate real-world usage with .env files and manifests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    getManifestEnvSpecs,
    buildEnvFlags,
    expandEnvWildcard,
    isApiKeyVariable,
    getAllAvailableEnvNames
} from '../../cli/utils/security/secretVars.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================================
// Test with real .env file content
// ================================

test('Integration: expandEnvWildcard with LLM_MODEL_* pattern from real env', () => {
    // Simulate variables from ~/work/.env
    const originalEnv = { ...process.env };
    
    // Set up LLM model variables like in the real .env
    process.env.LLM_MODEL_01 = 'axiologic_kiro/auto-kiro|deep|3|15|200k';
    process.env.LLM_MODEL_02 = 'axiologic_kiro/claude-sonnet-4.5|deep|3|15|200k';
    process.env.LLM_MODEL_03 = 'axiologic_kiro/claude-sonnet-4|deep|3|15|200k';
    process.env.LLM_MODEL_04 = 'axiologic_kiro/claude-3.7-sonnet|deep|3|15|200k';
    process.env.LLM_MODEL_05 = 'axiologic_kiro/claude-haiku-4.5|fast|1|5|200k';
    process.env.LLM_MODEL_10 = 'axiologic_antigravity/gemini-3-flash|fast|0|0|1mill';
    
    try {
        const matches = expandEnvWildcard('LLM_MODEL_*');
        
        // Should find all LLM_MODEL_* variables
        assert.ok(matches.includes('LLM_MODEL_01'), 'Should include LLM_MODEL_01');
        assert.ok(matches.includes('LLM_MODEL_02'), 'Should include LLM_MODEL_02');
        assert.ok(matches.includes('LLM_MODEL_03'), 'Should include LLM_MODEL_03');
        assert.ok(matches.includes('LLM_MODEL_04'), 'Should include LLM_MODEL_04');
        assert.ok(matches.includes('LLM_MODEL_05'), 'Should include LLM_MODEL_05');
        assert.ok(matches.includes('LLM_MODEL_10'), 'Should include LLM_MODEL_10');
        
        // Should be sorted
        const llmModels = matches.filter(m => m.startsWith('LLM_MODEL_'));
        assert.deepStrictEqual(
            llmModels,
            [...llmModels].sort(),
            'Results should be sorted'
        );
        
        console.log(`  ✓ Found ${llmModels.length} LLM_MODEL_* variables`);
    } finally {
        // Cleanup
        delete process.env.LLM_MODEL_01;
        delete process.env.LLM_MODEL_02;
        delete process.env.LLM_MODEL_03;
        delete process.env.LLM_MODEL_04;
        delete process.env.LLM_MODEL_05;
        delete process.env.LLM_MODEL_10;
    }
});

test('Integration: expandEnvWildcard with ACHILLES_* pattern', () => {
    // Set up Achilles variables like in the real .env
    process.env.ACHILLES_ORCHESTRATOR_MODE = 'deep';
    process.env.ACHILLES_DEFAULT_FAST_MODEL = 'axiologic_antigravity/gemini-2.5-flash-lite';
    process.env.ACHILLES_DEFAULT_DEEP_MODEL = 'axiologic_antigravity/claude-opus-4-5-thinking';
    process.env.ACHILLES_ENABLED_FAST_MODELS = 'model1,model2,model3';
    process.env.ACHILLES_ENABLED_DEEP_MODELS = 'model4,model5';
    
    try {
        const matches = expandEnvWildcard('ACHILLES_*');
        
        assert.ok(matches.includes('ACHILLES_ORCHESTRATOR_MODE'));
        assert.ok(matches.includes('ACHILLES_DEFAULT_FAST_MODEL'));
        assert.ok(matches.includes('ACHILLES_DEFAULT_DEEP_MODEL'));
        assert.ok(matches.includes('ACHILLES_ENABLED_FAST_MODELS'));
        assert.ok(matches.includes('ACHILLES_ENABLED_DEEP_MODELS'));
        
        console.log(`  ✓ Found ${matches.filter(m => m.startsWith('ACHILLES_')).length} ACHILLES_* variables`);
    } finally {
        delete process.env.ACHILLES_ORCHESTRATOR_MODE;
        delete process.env.ACHILLES_DEFAULT_FAST_MODEL;
        delete process.env.ACHILLES_DEFAULT_DEEP_MODEL;
        delete process.env.ACHILLES_ENABLED_FAST_MODELS;
        delete process.env.ACHILLES_ENABLED_DEEP_MODELS;
    }
});

test('Integration: expandEnvWildcard with OPENAI_*_URL pattern', () => {
    // Set up provider URL variables
    process.env.OPENAI_AXIOLOGIC_KIRO_URL = 'https://kiro.axiologic.dev/v1/chat/completions';
    process.env.OPENAI_OPENCODE_URL = 'https://opencode.ai/zen/v1/chat/completions';
    process.env.OPENAI_CUSTOM_URL = 'https://custom.example.com/v1';
    process.env.OPENAI_API_KEY = 'sk-test-key'; // Should NOT match *_URL pattern
    
    try {
        const matches = expandEnvWildcard('OPENAI_*_URL');
        
        assert.ok(matches.includes('OPENAI_AXIOLOGIC_KIRO_URL'));
        assert.ok(matches.includes('OPENAI_OPENCODE_URL'));
        assert.ok(matches.includes('OPENAI_CUSTOM_URL'));
        assert.ok(!matches.includes('OPENAI_API_KEY'), 'Should not match OPENAI_API_KEY');
        
        console.log(`  ✓ Found ${matches.length} OPENAI_*_URL variables`);
    } finally {
        delete process.env.OPENAI_AXIOLOGIC_KIRO_URL;
        delete process.env.OPENAI_OPENCODE_URL;
        delete process.env.OPENAI_CUSTOM_URL;
        delete process.env.OPENAI_API_KEY;
    }
});

test('Integration: API_KEY exclusion with * wildcard', () => {
    // Set up mix of regular and API key variables
    process.env.INT_TEST_DATABASE_URL = 'postgres://localhost/test';
    process.env.INT_TEST_LOG_LEVEL = 'debug';
    process.env.INT_TEST_PORT = '3000';
    process.env.INT_TEST_API_KEY = 'secret-api-key';
    process.env.INT_TEST_OPENAI_API_KEY = 'sk-openai-key';
    process.env.INT_TEST_ANTHROPIC_APIKEY = 'anthropic-key';
    process.env.INT_TEST_CUSTOM_APIKEY_VALUE = 'custom-key';
    
    try {
        const allMatches = expandEnvWildcard('*');
        
        // Regular variables should be included
        assert.ok(allMatches.includes('INT_TEST_DATABASE_URL'), 'Should include DATABASE_URL');
        assert.ok(allMatches.includes('INT_TEST_LOG_LEVEL'), 'Should include LOG_LEVEL');
        assert.ok(allMatches.includes('INT_TEST_PORT'), 'Should include PORT');
        
        // API key variables should be excluded
        assert.ok(!allMatches.includes('INT_TEST_API_KEY'), 'Should exclude API_KEY');
        assert.ok(!allMatches.includes('INT_TEST_OPENAI_API_KEY'), 'Should exclude OPENAI_API_KEY');
        assert.ok(!allMatches.includes('INT_TEST_ANTHROPIC_APIKEY'), 'Should exclude ANTHROPIC_APIKEY');
        assert.ok(!allMatches.includes('INT_TEST_CUSTOM_APIKEY_VALUE'), 'Should exclude CUSTOM_APIKEY_VALUE');
        
        console.log('  ✓ API_KEY variables correctly excluded from * wildcard');
    } finally {
        delete process.env.INT_TEST_DATABASE_URL;
        delete process.env.INT_TEST_LOG_LEVEL;
        delete process.env.INT_TEST_PORT;
        delete process.env.INT_TEST_API_KEY;
        delete process.env.INT_TEST_OPENAI_API_KEY;
        delete process.env.INT_TEST_ANTHROPIC_APIKEY;
        delete process.env.INT_TEST_CUSTOM_APIKEY_VALUE;
    }
});

// ================================
// Test with realistic manifests
// ================================

test('Integration: Manifest with LLM wildcard injection', () => {
    // Set up environment like real .env
    process.env.LLM_MODEL_01 = 'model1|deep|3|15|200k';
    process.env.LLM_MODEL_02 = 'model2|fast|1|5|200k';
    process.env.LLM_MODEL_03 = 'model3|deep|3|15|200k';
    process.env.ACHILLES_DEFAULT_MODEL = 'model1';
    process.env.DATABASE_URL = 'postgres://localhost/mydb';
    
    try {
        const manifest = {
            container: 'node:20-bullseye',
            env: [
                'LLM_MODEL_*',      // Wildcard for all LLM models
                'ACHILLES_*',       // Wildcard for Achilles config
                'DATABASE_URL'      // Explicit variable
            ]
        };
        
        const specs = getManifestEnvSpecs(manifest);
        const names = specs.map(s => s.insideName);
        
        // Check LLM models are included
        assert.ok(names.includes('LLM_MODEL_01'));
        assert.ok(names.includes('LLM_MODEL_02'));
        assert.ok(names.includes('LLM_MODEL_03'));
        
        // Check Achilles config is included
        assert.ok(names.includes('ACHILLES_DEFAULT_MODEL'));
        
        // Check explicit variable is included
        assert.ok(names.includes('DATABASE_URL'));
        
        console.log(`  ✓ Manifest resolved ${names.length} environment variables`);
        console.log(`    LLM models: ${names.filter(n => n.startsWith('LLM_MODEL_')).length}`);
        console.log(`    Achilles vars: ${names.filter(n => n.startsWith('ACHILLES_')).length}`);
    } finally {
        delete process.env.LLM_MODEL_01;
        delete process.env.LLM_MODEL_02;
        delete process.env.LLM_MODEL_03;
        delete process.env.ACHILLES_DEFAULT_MODEL;
        delete process.env.DATABASE_URL;
    }
});

test('Integration: Manifest with * wildcard and explicit API key', () => {
    process.env.WILDCARD_TEST_VAR1 = 'value1';
    process.env.WILDCARD_TEST_VAR2 = 'value2';
    process.env.WILDCARD_TEST_API_KEY = 'secret-key';
    process.env.OPENAI_API_KEY = 'sk-openai';
    
    try {
        // Manifest that wants all vars plus explicit API key
        const manifest = {
            container: 'node:20-bullseye',
            env: [
                'OPENAI_API_KEY',   // Explicit API key (must come first to override * exclusion)
                '*'                  // All other variables except API keys
            ]
        };
        
        const specs = getManifestEnvSpecs(manifest);
        const names = specs.map(s => s.insideName);
        
        // Regular variables should be included
        assert.ok(names.includes('WILDCARD_TEST_VAR1'));
        assert.ok(names.includes('WILDCARD_TEST_VAR2'));
        
        // Explicit API key should be included
        assert.ok(names.includes('OPENAI_API_KEY'), 'Explicit OPENAI_API_KEY should be included');
        
        // Other API key variables should be excluded by * wildcard
        assert.ok(!names.includes('WILDCARD_TEST_API_KEY'), 'WILDCARD_TEST_API_KEY should be excluded');
        
        console.log('  ✓ * wildcard works with explicit API key override');
    } finally {
        delete process.env.WILDCARD_TEST_VAR1;
        delete process.env.WILDCARD_TEST_VAR2;
        delete process.env.WILDCARD_TEST_API_KEY;
        delete process.env.OPENAI_API_KEY;
    }
});

test('Integration: Profile-based wildcard env', () => {
    process.env.PROFILE_LLM_01 = 'model1';
    process.env.PROFILE_LLM_02 = 'model2';
    process.env.PROFILE_DEBUG = 'true';
    
    try {
        const manifest = {
            container: 'node:20-bullseye',
            env: ['SOME_OTHER_VAR'],  // Top-level env (should be ignored)
            profiles: {
                default: {
                    env: ['PROFILE_LLM_*', 'PROFILE_DEBUG']  // Profile env with wildcard
                }
            }
        };
        
        // Profile config takes precedence
        const profileConfig = manifest.profiles.default;
        const specs = getManifestEnvSpecs(manifest, profileConfig);
        const names = specs.map(s => s.insideName);
        
        // Profile wildcard should be expanded
        assert.ok(names.includes('PROFILE_LLM_01'));
        assert.ok(names.includes('PROFILE_LLM_02'));
        assert.ok(names.includes('PROFILE_DEBUG'));
        
        // Top-level env should be ignored when profile env is present
        assert.ok(!names.includes('SOME_OTHER_VAR'));
        
        console.log('  ✓ Profile-based wildcard env works correctly');
    } finally {
        delete process.env.PROFILE_LLM_01;
        delete process.env.PROFILE_LLM_02;
        delete process.env.PROFILE_DEBUG;
    }
});

test('Integration: Object-format env with wildcards', () => {
    process.env.OBJ_WILD_CONFIG_A = 'value-a';
    process.env.OBJ_WILD_CONFIG_B = 'value-b';
    
    try {
        const manifest = {
            container: 'node:20-bullseye',
            env: {
                'OBJ_WILD_CONFIG_*': {},  // Wildcard in object key
                'EXPLICIT_VAR': { default: 'default-value' }
            }
        };
        
        const specs = getManifestEnvSpecs(manifest);
        const names = specs.map(s => s.insideName);
        
        assert.ok(names.includes('OBJ_WILD_CONFIG_A'));
        assert.ok(names.includes('OBJ_WILD_CONFIG_B'));
        assert.ok(names.includes('EXPLICIT_VAR'));
        
        // Check explicit var has default
        const explicitSpec = specs.find(s => s.insideName === 'EXPLICIT_VAR');
        assert.strictEqual(explicitSpec.defaultValue, 'default-value');
        
        console.log('  ✓ Object-format env with wildcards works correctly');
    } finally {
        delete process.env.OBJ_WILD_CONFIG_A;
        delete process.env.OBJ_WILD_CONFIG_B;
    }
});

test('Integration: No duplicate entries when wildcard overlaps explicit', () => {
    process.env.OVERLAP_VAR_01 = 'first';
    process.env.OVERLAP_VAR_02 = 'second';
    
    try {
        const manifest = {
            container: 'node:20-bullseye',
            env: [
                'OVERLAP_VAR_01=explicit-default',  // Explicit with default
                'OVERLAP_VAR_*'                      // Wildcard that would match OVERLAP_VAR_01
            ]
        };
        
        const specs = getManifestEnvSpecs(manifest);
        const names = specs.map(s => s.insideName);
        
        // Count occurrences
        const count01 = names.filter(n => n === 'OVERLAP_VAR_01').length;
        const count02 = names.filter(n => n === 'OVERLAP_VAR_02').length;
        
        assert.strictEqual(count01, 1, 'OVERLAP_VAR_01 should appear exactly once');
        assert.strictEqual(count02, 1, 'OVERLAP_VAR_02 should appear exactly once');
        
        // Explicit entry should preserve its default value
        const spec01 = specs.find(s => s.insideName === 'OVERLAP_VAR_01');
        assert.strictEqual(spec01.defaultValue, 'explicit-default');
        
        console.log('  ✓ No duplicates when wildcard overlaps explicit entries');
    } finally {
        delete process.env.OVERLAP_VAR_01;
        delete process.env.OVERLAP_VAR_02;
    }
});

// ================================
// Edge cases
// ================================

test('Integration: Empty wildcard expansion', () => {
    // Pattern that matches nothing
    const matches = expandEnvWildcard('NONEXISTENT_PREFIX_*');
    assert.deepStrictEqual(matches, [], 'Should return empty array for no matches');
    console.log('  ✓ Empty wildcard expansion returns empty array');
});

test('Integration: Multiple wildcards in single manifest', () => {
    process.env.MULTI_A_01 = 'a1';
    process.env.MULTI_A_02 = 'a2';
    process.env.MULTI_B_01 = 'b1';
    process.env.MULTI_B_02 = 'b2';
    process.env.MULTI_C_SINGLE = 'c';
    
    try {
        const manifest = {
            container: 'node:20-bullseye',
            env: [
                'MULTI_A_*',
                'MULTI_B_*',
                'MULTI_C_*'
            ]
        };
        
        const specs = getManifestEnvSpecs(manifest);
        const names = specs.map(s => s.insideName);
        
        assert.ok(names.includes('MULTI_A_01'));
        assert.ok(names.includes('MULTI_A_02'));
        assert.ok(names.includes('MULTI_B_01'));
        assert.ok(names.includes('MULTI_B_02'));
        assert.ok(names.includes('MULTI_C_SINGLE'));
        
        console.log(`  ✓ Multiple wildcards resolved ${names.length} variables total`);
    } finally {
        delete process.env.MULTI_A_01;
        delete process.env.MULTI_A_02;
        delete process.env.MULTI_B_01;
        delete process.env.MULTI_B_02;
        delete process.env.MULTI_C_SINGLE;
    }
});

test('Integration: isApiKeyVariable comprehensive check', () => {
    // Should detect as API key
    assert.ok(isApiKeyVariable('API_KEY'));
    assert.ok(isApiKeyVariable('MY_API_KEY'));
    assert.ok(isApiKeyVariable('OPENAI_API_KEY'));
    assert.ok(isApiKeyVariable('api_key'));
    assert.ok(isApiKeyVariable('OpenAI_Api_Key'));
    assert.ok(isApiKeyVariable('APIKEY'));
    assert.ok(isApiKeyVariable('myapikey'));
    assert.ok(isApiKeyVariable('SOME_APIKEY_VAR'));
    
    // Should NOT detect as API key
    assert.ok(!isApiKeyVariable('API_VERSION'));
    assert.ok(!isApiKeyVariable('KEY_COUNT'));
    assert.ok(!isApiKeyVariable('PUBLIC_KEY'));
    assert.ok(!isApiKeyVariable('KEY'));
    assert.ok(!isApiKeyVariable('API'));
    assert.ok(!isApiKeyVariable('DATABASE_URL'));
    
    console.log('  ✓ isApiKeyVariable correctly identifies API key patterns');
});
