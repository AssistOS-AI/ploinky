import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isWildcardPattern,
    wildcardToRegex,
    isApiKeyVariable,
    isSensitiveEnvVariableName,
    expandEnvWildcard,
    getManifestEnvSpecs,
    validateManifestEnvProfileCompleteness
} from '../../cli/utils/security/secretVars.js';

// ================================
// isWildcardPattern tests
// ================================

test('isWildcardPattern: should detect asterisk wildcard', () => {
    assert.strictEqual(isWildcardPattern('LLM_MODEL_*'), true);
    assert.strictEqual(isWildcardPattern('*'), true);
    assert.strictEqual(isWildcardPattern('PREFIX_*_SUFFIX'), true);
});

test('isWildcardPattern: should return false for non-wildcards', () => {
    assert.strictEqual(isWildcardPattern('LLM_MODEL_01'), false);
    assert.strictEqual(isWildcardPattern('SIMPLE_VAR'), false);
    assert.strictEqual(isWildcardPattern(''), false);
});

test('isWildcardPattern: should handle non-strings', () => {
    assert.strictEqual(isWildcardPattern(null), false);
    assert.strictEqual(isWildcardPattern(undefined), false);
    assert.strictEqual(isWildcardPattern(123), false);
});

// ================================
// wildcardToRegex tests
// ================================

test('wildcardToRegex: should match prefix wildcard pattern', () => {
    const regex = wildcardToRegex('LLM_MODEL_*');
    assert.strictEqual(regex.test('LLM_MODEL_01'), true);
    assert.strictEqual(regex.test('LLM_MODEL_'), true);
    assert.strictEqual(regex.test('LLM_MODEL_FOO_BAR'), true);
    assert.strictEqual(regex.test('LLM_MODEL'), false);
    assert.strictEqual(regex.test('OTHER_VAR'), false);
});

test('wildcardToRegex: should match pattern without trailing underscore', () => {
    const regex = wildcardToRegex('LLM_MODEL*');
    assert.strictEqual(regex.test('LLM_MODEL_01'), true);
    assert.strictEqual(regex.test('LLM_MODEL'), true);
    assert.strictEqual(regex.test('LLM_MODELS'), true);
    assert.strictEqual(regex.test('OTHER_VAR'), false);
});

test('wildcardToRegex: should match all with asterisk only', () => {
    const regex = wildcardToRegex('*');
    assert.strictEqual(regex.test('ANY_VAR'), true);
    assert.strictEqual(regex.test(''), true);
    assert.strictEqual(regex.test('A'), true);
});

test('wildcardToRegex: should match pattern with wildcard in middle', () => {
    const regex = wildcardToRegex('PREFIX_*_SUFFIX');
    assert.strictEqual(regex.test('PREFIX_MIDDLE_SUFFIX'), true);
    assert.strictEqual(regex.test('PREFIX__SUFFIX'), true);
    assert.strictEqual(regex.test('PREFIX_A_B_C_SUFFIX'), true);
    assert.strictEqual(regex.test('PREFIX_SUFFIX'), false);
    assert.strictEqual(regex.test('PREFIX_NO'), false);
});

test('wildcardToRegex: should escape special regex characters', () => {
    const regex = wildcardToRegex('VAR.NAME*');
    assert.strictEqual(regex.test('VAR.NAME_01'), true);
    assert.strictEqual(regex.test('VARXNAME_01'), false);
});

// ================================
// isApiKeyVariable tests
// ================================

test('isApiKeyVariable: should detect API_KEY in variable name', () => {
    assert.strictEqual(isApiKeyVariable('OPENAI_API_KEY'), true);
    assert.strictEqual(isApiKeyVariable('MY_API_KEY_SECRET'), true);
    assert.strictEqual(isApiKeyVariable('api_key'), true);
    assert.strictEqual(isApiKeyVariable('Api_Key'), true);
});

test('isApiKeyVariable: should detect APIKEY (no underscore)', () => {
    assert.strictEqual(isApiKeyVariable('OPENAI_APIKEY'), true);
    assert.strictEqual(isApiKeyVariable('myapikey'), true);
    assert.strictEqual(isApiKeyVariable('ApiKey'), true);
});

test('isApiKeyVariable: should return false for non-API-key variables', () => {
    assert.strictEqual(isApiKeyVariable('LLM_MODEL_01'), false);
    assert.strictEqual(isApiKeyVariable('DATABASE_URL'), false);
    assert.strictEqual(isApiKeyVariable('PORT'), false);
    assert.strictEqual(isApiKeyVariable('API_VERSION'), false);
});

test('isApiKeyVariable: should handle edge cases', () => {
    assert.strictEqual(isApiKeyVariable(''), false);
    assert.strictEqual(isApiKeyVariable(null), false);
    assert.strictEqual(isApiKeyVariable(undefined), false);
});

// ================================
// expandEnvWildcard tests
// ================================

test('expandEnvWildcard: should expand pattern matching process.env', () => {
    // Set up test environment
    const originalEnv = { ...process.env };
    process.env.TEST_PREFIX_A = 'a';
    process.env.TEST_PREFIX_B = 'b';
    process.env.TEST_PREFIX_C = 'c';
    process.env.TEST_OTHER = 'other';

    try {
        const result = expandEnvWildcard('TEST_PREFIX_*');
        assert.ok(result.includes('TEST_PREFIX_A'));
        assert.ok(result.includes('TEST_PREFIX_B'));
        assert.ok(result.includes('TEST_PREFIX_C'));
        assert.ok(!result.includes('TEST_OTHER'));
    } finally {
        // Restore
        delete process.env.TEST_PREFIX_A;
        delete process.env.TEST_PREFIX_B;
        delete process.env.TEST_PREFIX_C;
        delete process.env.TEST_OTHER;
        Object.assign(process.env, originalEnv);
    }
});

test('expandEnvWildcard: asterisk wildcard should exclude API_KEY variables', () => {
    const originalEnv = { ...process.env };
    process.env.TEST_WILDCARD_VAR = 'value';
    process.env.TEST_WILDCARD_API_KEY = 'secret';
    process.env.TEST_WILDCARD_APIKEY = 'secret2';

    try {
        const result = expandEnvWildcard('*');
        assert.ok(result.includes('TEST_WILDCARD_VAR'), 'Should include regular var');
        assert.ok(!result.includes('TEST_WILDCARD_API_KEY'), 'Should exclude API_KEY');
        assert.ok(!result.includes('TEST_WILDCARD_APIKEY'), 'Should exclude APIKEY');
    } finally {
        delete process.env.TEST_WILDCARD_VAR;
        delete process.env.TEST_WILDCARD_API_KEY;
        delete process.env.TEST_WILDCARD_APIKEY;
        Object.assign(process.env, originalEnv);
    }
});

test('expandEnvWildcard: non-wildcard should return as-is', () => {
    const result = expandEnvWildcard('SIMPLE_VAR');
    assert.deepStrictEqual(result, ['SIMPLE_VAR']);
});

test('expandEnvWildcard: results should be sorted', () => {
    process.env.SORTED_TEST_C = 'c';
    process.env.SORTED_TEST_A = 'a';
    process.env.SORTED_TEST_B = 'b';

    try {
        const result = expandEnvWildcard('SORTED_TEST_*');
        const sortedNames = result.filter(n => n.startsWith('SORTED_TEST_'));
        assert.deepStrictEqual(sortedNames, ['SORTED_TEST_A', 'SORTED_TEST_B', 'SORTED_TEST_C']);
    } finally {
        delete process.env.SORTED_TEST_C;
        delete process.env.SORTED_TEST_A;
        delete process.env.SORTED_TEST_B;
    }
});

// ================================
// getManifestEnvSpecs wildcard tests
// ================================

test('getManifestEnvSpecs: should expand wildcard in array format', () => {
    process.env.MANIFEST_TEST_01 = 'val1';
    process.env.MANIFEST_TEST_02 = 'val2';
    process.env.MANIFEST_OTHER = 'other';

    try {
        const manifest = {
            env: ['MANIFEST_TEST_*']
        };
        const specs = getManifestEnvSpecs(manifest);
        const names = specs.map(s => s.insideName);
        assert.ok(names.includes('MANIFEST_TEST_01'));
        assert.ok(names.includes('MANIFEST_TEST_02'));
        assert.ok(!names.includes('MANIFEST_OTHER'));
    } finally {
        delete process.env.MANIFEST_TEST_01;
        delete process.env.MANIFEST_TEST_02;
        delete process.env.MANIFEST_OTHER;
    }
});

test('getManifestEnvSpecs: should expand wildcard in object format', () => {
    process.env.OBJ_WILD_A = 'a';
    process.env.OBJ_WILD_B = 'b';

    try {
        const manifest = {
            env: {
                'OBJ_WILD_*': {}
            }
        };
        const specs = getManifestEnvSpecs(manifest);
        const names = specs.map(s => s.insideName);
        assert.ok(names.includes('OBJ_WILD_A'));
        assert.ok(names.includes('OBJ_WILD_B'));
    } finally {
        delete process.env.OBJ_WILD_A;
        delete process.env.OBJ_WILD_B;
    }
});

test('getManifestEnvSpecs: wildcard with explicit override should not duplicate', () => {
    process.env.DUP_TEST_01 = 'val1';
    process.env.DUP_TEST_02 = 'val2';

    try {
        const manifest = {
            env: [
                'DUP_TEST_01=explicit_default',  // Explicit first
                'DUP_TEST_*'                      // Wildcard second
            ]
        };
        const specs = getManifestEnvSpecs(manifest);
        const names = specs.map(s => s.insideName);

        // Should have both, but DUP_TEST_01 only once
        const count01 = names.filter(n => n === 'DUP_TEST_01').length;
        assert.strictEqual(count01, 1, 'DUP_TEST_01 should appear exactly once');
        assert.ok(names.includes('DUP_TEST_02'));

        // The explicit one should have its default value preserved
        const spec01 = specs.find(s => s.insideName === 'DUP_TEST_01');
        assert.strictEqual(spec01.defaultValue, 'explicit_default');
    } finally {
        delete process.env.DUP_TEST_01;
        delete process.env.DUP_TEST_02;
    }
});

test('getManifestEnvSpecs: asterisk wildcard should exclude API_KEY but allow explicit', () => {
    process.env.ALL_TEST_VAR = 'var';
    process.env.ALL_TEST_API_KEY = 'secret';

    try {
        // First, test that * excludes API_KEY
        const manifestWithStar = {
            env: ['*']
        };
        const specsWithStar = getManifestEnvSpecs(manifestWithStar);
        const namesWithStar = specsWithStar.map(s => s.insideName);
        assert.ok(namesWithStar.includes('ALL_TEST_VAR'));
        assert.ok(!namesWithStar.includes('ALL_TEST_API_KEY'));

        // Test that explicit API_KEY works
        const manifestWithExplicit = {
            env: ['ALL_TEST_API_KEY', '*']
        };
        const specsWithExplicit = getManifestEnvSpecs(manifestWithExplicit);
        const namesWithExplicit = specsWithExplicit.map(s => s.insideName);
        assert.ok(namesWithExplicit.includes('ALL_TEST_VAR'));
        assert.ok(namesWithExplicit.includes('ALL_TEST_API_KEY'));
    } finally {
        delete process.env.ALL_TEST_VAR;
        delete process.env.ALL_TEST_API_KEY;
    }
});

test('getManifestEnvSpecs: profile env should take precedence', () => {
    process.env.PROFILE_WILD_A = 'a';
    process.env.PROFILE_WILD_B = 'b';
    process.env.PROFILE_OTHER = 'other';

    try {
        const manifest = {
            env: ['SOME_OTHER_VAR']
        };
        const profileConfig = {
            env: ['PROFILE_WILD_*']
        };
        const specs = getManifestEnvSpecs(manifest, profileConfig);
        const names = specs.map(s => s.insideName);

        // Profile env should be used, not manifest env
        assert.ok(names.includes('PROFILE_WILD_A'));
        assert.ok(names.includes('PROFILE_WILD_B'));
        assert.ok(!names.includes('SOME_OTHER_VAR'));
        assert.ok(!names.includes('PROFILE_OTHER'));
    } finally {
        delete process.env.PROFILE_WILD_A;
        delete process.env.PROFILE_WILD_B;
        delete process.env.PROFILE_OTHER;
    }
});

test('getManifestEnvSpecs: mixed wildcards and explicit variables', () => {
    process.env.MIX_LLM_MODEL_01 = 'model1';
    process.env.MIX_LLM_MODEL_02 = 'model2';
    process.env.MIX_DATABASE_URL = 'postgres://...';

    try {
        const manifest = {
            env: [
                'MIX_DATABASE_URL',
                'MIX_LLM_MODEL_*',
                'CUSTOM_VAR=default_value'
            ]
        };
        const specs = getManifestEnvSpecs(manifest);
        const names = specs.map(s => s.insideName);

        assert.ok(names.includes('MIX_DATABASE_URL'));
        assert.ok(names.includes('MIX_LLM_MODEL_01'));
        assert.ok(names.includes('MIX_LLM_MODEL_02'));
        assert.ok(names.includes('CUSTOM_VAR'));

        // Check custom var has default
        const customSpec = specs.find(s => s.insideName === 'CUSTOM_VAR');
        assert.strictEqual(customSpec.defaultValue, 'default_value');
    } finally {
        delete process.env.MIX_LLM_MODEL_01;
        delete process.env.MIX_LLM_MODEL_02;
        delete process.env.MIX_DATABASE_URL;
    }
});

test('validateManifestEnvProfileCompleteness rejects required non-sensitive env without defaults', () => {
    const manifest = {
        profiles: {
            prod: {
                env: [
                    {
                        name: 'PUBLIC_SERVICE_URL',
                        required: true
                    }
                ]
            }
        }
    };

    const result = validateManifestEnvProfileCompleteness(manifest, manifest.profiles.prod, {
        agentName: 'exampleAgent',
        profileName: 'prod'
    });

    assert.strictEqual(result.valid, false);
    assert.match(result.issues[0], /PUBLIC_SERVICE_URL/);
});

test('validateManifestEnvProfileCompleteness allows derived and sensitive required env without defaults', () => {
    const manifest = {
        profiles: {
            prod: {
                env: [
                    {
                        name: 'PUBLIC_SERVICE_URL',
                        required: true,
                        default: 'https://example.test'
                    },
                    {
                        name: 'SERVICE_API_KEY',
                        required: true
                    },
                    {
                        name: 'SERVICE_PASSWORD',
                        required: true
                    },
                    {
                        name: 'SERVICE_MASTER_KEY',
                        required: true
                    },
                    {
                        name: 'GENERATED_SECRET',
                        required: true,
                        generatedSecret: true
                    }
                ]
            }
        }
    };

    const result = validateManifestEnvProfileCompleteness(manifest, manifest.profiles.prod, {
        profileName: 'prod'
    });

    assert.strictEqual(result.valid, true);
    assert.ok(isSensitiveEnvVariableName('SERVICE_API_KEY'));
    assert.ok(isSensitiveEnvVariableName('SERVICE_PASSWORD'));
    assert.ok(isSensitiveEnvVariableName('SERVICE_MASTER_KEY'));
    assert.ok(!isSensitiveEnvVariableName('KEYCLOAK_URL'));
});
