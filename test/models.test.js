'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const models = require('../models');

const AGY_OUTPUT =
    '\r⠋ Fetching available models...\r⠙ Fetching available models...\r' +
    'gemini-4-argon-medium\tGemini 4 Argon (Medium)\n' +
    'gemini-3.8-flash-high     Gemini 3.8 Flash (High)\n' +
    'claude-opus-5-5-high      Claude Opus 5.5 (High)\n' +
    '\n';

const GROK_OUTPUT =
    'You are logged in with grok.com.\n\n' +
    'Default model: grok-4.7\n\n' +
    'Available models:\n' +
    '  * grok-4.7 (default)\n' +
    '  - grok-4.7-build-fast\n' +
    '  - grok-4.6\n';

const silent = { log() {}, error() {} };

test('parseAgyModels handles tab and space separators and spinner frames', () => {
    assert.deepEqual(models.parseAgyModels(AGY_OUTPUT), [
        { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
        { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' }
    ]);
});

test('parseOpenCodeModels keeps provider/model ids and skips prose', () => {
    const output = [
        'Warning: ignored',
        'opencode/big-pickle',
        'opencode/big-pickle',
        'local-ai/google/gemma-4-31b',
        'not a model'
    ].join('\n');
    assert.deepEqual(models.parseOpenCodeModels(output), [
        { id: 'opencode/big-pickle', label: 'opencode/big-pickle' },
        { id: 'local-ai/google/gemma-4-31b', label: 'local-ai/google/gemma-4-31b' }
    ]);
});

test('parseGrokModels reads the bulleted list and flags the default', () => {
    assert.deepEqual(models.parseGrokModels(GROK_OUTPUT), [
        { id: 'grok-4.7', label: 'grok-4.7', isDefault: true },
        { id: 'grok-4.7-build-fast', label: 'grok-4.7-build-fast', isDefault: false },
        { id: 'grok-4.6', label: 'grok-4.6', isDefault: false }
    ]);
});

test('formatModelLabel adds icons and the grok default marker', () => {
    assert.equal(models.formatModelLabel('agy', { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' }), '💎 Gemini 4 Argon (High)');
    assert.equal(models.formatModelLabel('grok', { id: 'grok-4.7', label: 'grok-4.7', isDefault: true }), '⭐ grok-4.7 (default)');
});

test('catalogue caches results and refetches on force', async () => {
    let calls = 0;
    const catalogue = models.createModelCatalogue({
        bins: { agy: 'agy', grok: 'grok' },
        env: {},
        log: silent,
        runCommand: async (bin) => { calls++; return bin === 'grok' ? GROK_OUTPUT : AGY_OUTPUT; }
    });

    const first = await catalogue.getModels('agy');
    assert.equal(first.source, 'cli');
    assert.equal(first.models.length, 3);
    await catalogue.getModels('agy');
    assert.equal(calls, 1);
    await catalogue.getModels('agy', { force: true });
    assert.equal(calls, 2);
    assert.equal((await catalogue.getModels('grok')).models[0].id, 'grok-4.7');
});

test('catalogue deduplicates concurrent fetches', async () => {
    let calls = 0;
    const catalogue = models.createModelCatalogue({
        bins: { agy: 'agy' }, env: {}, log: silent,
        runCommand: async () => { calls++; await new Promise(r => setTimeout(r, 10)); return AGY_OUTPUT; }
    });
    await Promise.all([catalogue.getModels('agy'), catalogue.getModels('agy')]);
    assert.equal(calls, 1);
});

test('catalogue falls back to static list, then keeps last good list on failure', async () => {
    let fail = true;
    const catalogue = models.createModelCatalogue({
        bins: { agy: 'agy' }, env: {}, log: silent,
        runCommand: async () => { if (fail) throw new Error('boom'); return AGY_OUTPUT; }
    });

    const fallback = await catalogue.getModels('agy');
    assert.equal(fallback.source, 'fallback');
    assert.deepEqual(fallback.models, models.FALLBACK_MODELS.agy);

    fail = false;
    const live = await catalogue.getModels('agy');
    assert.equal(live.source, 'cli');

    fail = true;
    const stale = await catalogue.getModels('agy', { force: true });
    assert.equal(stale.source, 'cli');
    assert.equal(stale.models.length, 3);
});

test('opencode catalogue hides OpenCode hosted models', async () => {
    const catalogue = models.createModelCatalogue({
        bins: { opencode: 'opencode' }, env: {}, log: silent,
        runCommand: async () => 'opencode/big-pickle\nlocal-ai/qwen2.5-coder-7b\n'
    });
    const live = await catalogue.getModels('opencode');
    assert.deepEqual(live.models.map(model => model.id), ['local-ai/qwen2.5-coder-7b']);
});

test('modelMenuPage splits a long catalogue and clamps the page', () => {
    const list = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}` }));
    const first = models.modelMenuPage(list, 0);
    assert.equal(first.pages, 3);
    assert.equal(first.models.length, models.MODEL_MENU_PAGE_SIZE);
    assert.equal(first.models[0].id, 'm0');

    const last = models.modelMenuPage(list, 99);
    assert.equal(last.page, 2);
    assert.equal(last.models.length, 5);
    assert.equal(last.models[0].id, 'm40');

    const short = models.modelMenuPage(list.slice(0, 2), -1);
    assert.equal(short.pages, 1);
    assert.equal(short.page, 0);
    assert.equal(short.models.length, 2);
});

test('catalogue treats empty parse output as a failure', async () => {
    const catalogue = models.createModelCatalogue({
        bins: { grok: 'grok' }, env: {}, log: silent,
        runCommand: async () => 'Not logged in.\n'
    });
    assert.equal((await catalogue.getModels('grok')).source, 'fallback');
});
