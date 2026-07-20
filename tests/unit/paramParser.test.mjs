import test from 'node:test';
import assert from 'node:assert/strict';
import { parseParametersString } from '../../cli/utils/utils.js';

test('should parse a simple flag/value pair', () => {
    const input = '-name John';
    const expected = { name: 'John' };
    assert.deepStrictEqual(parseParametersString(input), expected);
});

test('should parse multiple flag/value pairs', () => {
    const input = '-name John -age 30';
    const expected = { name: 'John', age: 30 };
    assert.deepStrictEqual(parseParametersString(input), expected);
});

test('should handle nested dot-keys', () => {
    const input = '-user.name John -user.age 30';
    const expected = { user: { name: 'John', age: 30 } };
    assert.deepStrictEqual(parseParametersString(input), expected);
});

test('should handle bracket arrays', () => {
    const input = '-hobbies [coding reading hiking]';
    const expected = { hobbies: ['coding', 'reading', 'hiking'] };
    assert.deepStrictEqual(parseParametersString(input), expected);
});

test('should handle quoted values', () => {
    const input = '-message "Hello, world!"';
    const expected = { message: 'Hello, world!' };
    assert.deepStrictEqual(parseParametersString(input), expected);
});

test('should handle quoted tokens in arrays', () => {
    const input = '-tags ["one tag" two]';
    const expected = { tags: ['one tag', 'two'] };
    assert.deepStrictEqual(parseParametersString(input), expected);
});

test('should handle a mix of everything', () => {
    const input = '-name John -user.age 30 -user.location "New York" -hobbies [coding reading]';
    const expected = {
        name: 'John',
        user: {
            age: 30,
            location: 'New York'
        },
        hobbies: ['coding', 'reading']
    };
    assert.deepStrictEqual(parseParametersString(input), expected);
});

test('should handle empty string', () => {
    const input = '';
    const expected = {};
    assert.deepStrictEqual(parseParametersString(input), expected);
});

test('should allow missing value (empty string)', () => {
    const input = '-flag';
    const expected = { flag: '' };
    assert.deepStrictEqual(parseParametersString(input), expected);
});
