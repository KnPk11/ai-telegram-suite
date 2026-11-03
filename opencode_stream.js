'use strict';

// `opencode run --format json` writes one JSON object per line.
// Text parts arrive complete (not as deltas). The same part id can be
// repeated, so each id is stored once and the visible text is rejoined.

function createOpenCodeState() {
    return {
        sessionId: null,
        textParts: new Map(),
        textOrder: [],
        accumulatedText: '',
        toolCalls: [],
        errorText: ''
    };
}

function rememberText(state, partId, text) {
    const id = partId || `part-${state.textOrder.length}`;
    if (!state.textParts.has(id)) state.textOrder.push(id);
    state.textParts.set(id, text);
    state.accumulatedText = state.textOrder.map(key => state.textParts.get(key)).join('');
}

function toolDone(status) {
    return status === 'completed' || status === 'error' || status === 'failed';
}

function applyOpenCodeEvent(state, data) {
    if (!data || typeof data !== 'object') return state;
    if (typeof data.sessionID === 'string' && data.sessionID) {
        state.sessionId = data.sessionID;
    }

    if (data.type === 'text') {
        const part = data.part && typeof data.part === 'object' ? data.part : {};
        const text = typeof part.text === 'string'
            ? part.text
            : (typeof data.text === 'string' ? data.text : '');
        rememberText(state, part.id, text);
        return state;
    }

    if (data.type === 'tool_use' || data.type === 'tool') {
        const part = data.part && typeof data.part === 'object' ? data.part : {};
        const id = part.callID || part.id || '';
        const name = part.tool || 'tool';
        const status = part.state && part.state.status ? part.state.status : '';
        const params = part.state && part.state.input && typeof part.state.input === 'object'
            ? part.state.input
            : {};
        const next = {
            id,
            name,
            params,
            state: toolDone(status) ? 'DONE' : 'ACTIVE'
        };
        const existing = id
            ? state.toolCalls.find(call => call.id === id)
            : null;
        if (existing) {
            existing.name = next.name;
            existing.params = next.params;
            existing.state = next.state;
        } else {
            state.toolCalls.push(next);
        }
        return state;
    }

    if (data.type === 'error') {
        const error = data.error && typeof data.error === 'object' ? data.error : {};
        const nested = error.data && typeof error.data === 'object' ? error.data : {};
        state.errorText = nested.message || error.message || 'OpenCode reported an error';
    }

    return state;
}

module.exports = {
    createOpenCodeState,
    applyOpenCodeEvent
};
