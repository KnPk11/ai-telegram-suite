'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const stream = require('../opencode_stream');

test('text parts are joined once and a repeated part id replaces itself', () => {
    const state = stream.createOpenCodeState();
    stream.applyOpenCodeEvent(state, {
        type: 'step_start',
        sessionID: 'ses_topic',
        part: { type: 'step-start' }
    });
    stream.applyOpenCodeEvent(state, {
        type: 'text',
        sessionID: 'ses_topic',
        part: { id: 'prt_1', type: 'text', text: 'Hello' }
    });
    stream.applyOpenCodeEvent(state, {
        type: 'text',
        sessionID: 'ses_topic',
        part: { id: 'prt_1', type: 'text', text: 'Hello there' }
    });
    stream.applyOpenCodeEvent(state, {
        type: 'text',
        part: { id: 'prt_2', type: 'text', text: ' Done.' }
    });

    assert.equal(state.sessionId, 'ses_topic');
    assert.equal(state.accumulatedText, 'Hello there Done.');
});

test('tool events update the same call and errors keep a message', () => {
    const state = stream.createOpenCodeState();
    stream.applyOpenCodeEvent(state, {
        type: 'tool_use',
        sessionID: 'ses_1',
        part: {
            id: 'prt_tool',
            callID: 'call_1',
            type: 'tool',
            tool: 'bash',
            state: { status: 'running', input: { command: 'ls' } }
        }
    });
    stream.applyOpenCodeEvent(state, {
        type: 'tool_use',
        part: {
            callID: 'call_1',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'ls' } }
        }
    });
    stream.applyOpenCodeEvent(state, {
        type: 'error',
        error: { data: { message: 'permission denied' } }
    });

    assert.equal(state.toolCalls.length, 1);
    assert.equal(state.toolCalls[0].state, 'DONE');
    assert.equal(state.toolCalls[0].name, 'bash');
    assert.deepEqual(state.toolCalls[0].params, { command: 'ls' });
    assert.equal(state.errorText, 'permission denied');
});
