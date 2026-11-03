'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const launch = require('../launch');

test('agy and grok keep their prompt flag and per-topic resume flags', () => {
    assert.deepEqual(launch.buildTurnArgs('agy', {
        prompt: 'fix the tests',
        model: 'gemini-3.8-flash-high',
        effort: 'high',
        sessionId: 'conv-1',
        mode: 'plan'
    }), [
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--conversation', 'conv-1',
        '--model', 'gemini-3.8-flash-high',
        '--effort', 'high',
        '--mode', 'plan',
        '-p', 'fix the tests'
    ]);

    assert.deepEqual(launch.buildTurnArgs('grok', {
        prompt: 'continue',
        model: 'grok-4.7',
        effort: 'xhigh',
        sessionId: 'ses-1'
    }), [
        '--always-approve',
        '--permission-mode', 'bypassPermissions',
        '--output-format', 'streaming-json',
        '--resume', 'ses-1',
        '-m', 'grok-4.7',
        '--effort', 'xhigh',
        '-p', 'continue'
    ]);
});

test('a new turn does not resume another topic that shares the workspace', () => {
    const args = launch.buildTurnArgs('opencode', {
        prompt: 'start fresh',
        isNew: true,
        sessionId: 'ses_old'
    });
    assert.equal(args.includes('--session'), false);
    assert.equal(args.includes('-c'), false);
    assert.equal(args.includes('--continue'), false);
});

test('opencode prompt is positional and -p is never the message', () => {
    const args = launch.buildTurnArgs('opencode', {
        prompt: 'explain this repo',
        model: 'opencode/big-pickle',
        effort: 'high',
        sessionId: 'ses_topic',
        mode: 'plan'
    });

    assert.deepEqual(args, [
        'run', '--format', 'json', '--auto',
        '--session', 'ses_topic',
        '-m', 'opencode/big-pickle',
        '--variant', 'high',
        '--agent', 'plan',
        'explain this repo'
    ]);
    assert.equal(args.includes('-p'), false);
    assert.equal(args.at(-1), 'explain this repo');
});

test('opencode omits model, variant, and agent when unset', () => {
    assert.deepEqual(launch.buildTurnArgs('opencode', { prompt: 'hi' }), [
        'run', '--format', 'json', '--auto', 'hi'
    ]);
});

test('unknown slash commands do not use opencode -p', () => {
    assert.deepEqual(launch.buildSlashArgs('opencode', '/compact'), ['run', '--auto', '/compact']);
    assert.deepEqual(launch.buildSlashArgs('agy', '/usage'), ['-p', '/usage']);
});

test('session ids stay on the engine that owns them', () => {
    const session = {
        agyConversationId: 'agy-1',
        grokSessionId: 'grok-1',
        opencodeSessionId: 'oc-1'
    };
    assert.equal(launch.sessionIdFor(session, 'agy'), 'agy-1');
    assert.equal(launch.sessionIdFor(session, 'grok'), 'grok-1');
    assert.equal(launch.sessionIdFor(session, 'opencode'), 'oc-1');
});
