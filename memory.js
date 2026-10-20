'use strict';

const fs = require('fs');
const path = require('path');

const MAX_TURNS = 8;
const MAX_FILES = 30;
const REQUEST_CLIP = 500;
const TURN_OUTCOME_CLIP = 700;
const LAST_OUTCOME_CLIP = 1200;

const PATH_KEYS = ['file_path', 'target_file', 'TargetFile', 'path', 'AbsolutePath', 'file', 'filePath'];

function clip(text, max) {
    let value = String(text || '').replace(/\r\n/g, '\n').trim();
    value = value.replace(/\n{3,}/g, '\n\n');
    if (value.length <= max) return value;
    return value.slice(0, max - 1) + '…';
}

function safeId(id) {
    return String(id || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function memoryJsonPath(memoryDir, sessionId) {
    return path.join(memoryDir, `${safeId(sessionId)}.json`);
}

function memoryMarkdownPath(memoryDir, sessionId) {
    return path.join(memoryDir, `${safeId(sessionId)}.md`);
}

function asParams(params) {
    if (!params) return {};
    if (typeof params === 'string') {
        try {
            const parsed = JSON.parse(params);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }
    return typeof params === 'object' ? params : {};
}

function isMutatingTool(name) {
    const normalised = String(name || '').toLowerCase();
    if (!normalised) return false;
    if (/read|view|grep|search|list|fetch|web/.test(normalised) && !/replace|write|edit|delete|patch/.test(normalised)) {
        return false;
    }
    return /replace|write|edit|delete|patch|strreplace/.test(normalised);
}

function pathsFromParams(params) {
    const found = [];
    const obj = asParams(params);
    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        for (const key of PATH_KEYS) {
            if (typeof node[key] === 'string' && node[key].trim()) {
                found.push(node[key].trim());
            }
        }
    };
    visit(obj);
    for (const value of Object.values(obj)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) visit(value);
    }
    return found;
}

function extractChangedFiles(toolCalls) {
    const files = [];
    for (const call of toolCalls || []) {
        if (!isMutatingTool(call.name)) continue;
        for (const filePath of pathsFromParams(call.params)) {
            files.push({ path: filePath, tool: call.name || 'edit' });
        }
    }
    return files;
}

function emptyMemory(session) {
    return {
        topicName: session.topicName || '',
        workspace: session.workspace || '',
        chatId: String(session.chatId || ''),
        threadId: session.threadId ?? null,
        agyConversationId: session.agyConversationId || null,
        grokSessionId: session.grokSessionId || null,
        updatedAt: null,
        latestRequest: '',
        filesTouched: [],
        lastOutcome: '',
        turns: []
    };
}

function loadMemory(memoryDir, sessionId) {
    try {
        const file = memoryJsonPath(memoryDir, sessionId);
        if (!fs.existsSync(file)) return null;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!data || typeof data !== 'object') return null;
        data.filesTouched = Array.isArray(data.filesTouched) ? data.filesTouched : [];
        data.turns = Array.isArray(data.turns) ? data.turns : [];
        return data;
    } catch {
        return null;
    }
}

function engineLabel(engine) {
    return engine === 'grok' ? 'Grok' : 'Antigravity';
}

function renderMarkdown(state) {
    const files = state.filesTouched.length
        ? state.filesTouched.map(file => `- \`${file.path}\` (${file.tool})`).join('\n')
        : '- None recorded.';
    const turns = state.turns.length
        ? state.turns.map(turn => [
            `### ${turn.at} — ${engineLabel(turn.engine)}`,
            '',
            `Request: ${turn.request || '(empty)'}`,
            '',
            `Outcome: ${turn.outcome || '(no reply)'}`
        ].join('\n')).join('\n\n')
        : 'No turns recorded.';

    return [
        '# Topic memory',
        '',
        `- Topic: ${state.topicName || 'Untitled'}`,
        `- Workspace: \`${state.workspace || ''}\``,
        `- Gemini conversation: \`${state.agyConversationId || 'none'}\``,
        `- Grok session: \`${state.grokSessionId || 'none'}\``,
        `- Updated: ${state.updatedAt || 'never'}`,
        '',
        '## Latest request',
        '',
        state.latestRequest || '(none)',
        '',
        '## Files touched',
        '',
        files,
        '',
        '## Last outcome',
        '',
        state.lastOutcome || '(none)',
        '',
        '## Recent turns',
        '',
        turns,
        ''
    ].join('\n');
}

function writeMemory(memoryDir, sessionId, state) {
    fs.mkdirSync(memoryDir, { recursive: true });
    const jsonPath = memoryJsonPath(memoryDir, sessionId);
    const mdPath = memoryMarkdownPath(memoryDir, sessionId);
    const jsonTmp = `${jsonPath}.${process.pid}.tmp`;
    const mdTmp = `${mdPath}.${process.pid}.tmp`;
    fs.writeFileSync(jsonTmp, JSON.stringify(state, null, 2), 'utf8');
    fs.writeFileSync(mdTmp, renderMarkdown(state), 'utf8');
    fs.renameSync(jsonTmp, jsonPath);
    fs.renameSync(mdTmp, mdPath);
    return mdPath;
}

function recordTopicTurn(memoryDir, session, turn) {
    const state = loadMemory(memoryDir, session.id) || emptyMemory(session);
    const at = new Date().toISOString();
    const request = clip(turn.request, REQUEST_CLIP);
    const outcome = clip(turn.outcome, LAST_OUTCOME_CLIP) || (turn.exitCode ? `(no reply, exit ${turn.exitCode})` : '');
    const files = extractChangedFiles(turn.toolCalls);

    state.topicName = session.topicName || state.topicName || '';
    state.workspace = session.workspace || state.workspace || '';
    state.chatId = String(session.chatId || state.chatId || '');
    state.threadId = session.threadId ?? state.threadId ?? null;
    state.agyConversationId = session.agyConversationId || null;
    state.grokSessionId = session.grokSessionId || null;
    state.updatedAt = at;
    state.latestRequest = request;
    state.lastOutcome = outcome;

    for (const file of files) {
        state.filesTouched = state.filesTouched.filter(existing => existing.path !== file.path);
        state.filesTouched.push({ path: file.path, tool: file.tool, at });
    }
    if (state.filesTouched.length > MAX_FILES) {
        state.filesTouched = state.filesTouched.slice(-MAX_FILES);
    }

    state.turns.push({
        at,
        engine: turn.engine === 'grok' ? 'grok' : 'agy',
        request,
        outcome: clip(turn.outcome, TURN_OUTCOME_CLIP) || outcome
    });
    if (state.turns.length > MAX_TURNS) {
        state.turns = state.turns.slice(-MAX_TURNS);
    }

    writeMemory(memoryDir, session.id, state);
    return state;
}

function readMemoryMarkdown(memoryDir, sessionId) {
    try {
        const mdPath = memoryMarkdownPath(memoryDir, sessionId);
        if (!fs.existsSync(mdPath)) return '';
        return fs.readFileSync(mdPath, 'utf8');
    } catch {
        return '';
    }
}

function memoryExists(memoryDir, sessionId) {
    return fs.existsSync(memoryMarkdownPath(memoryDir, sessionId));
}

function buildHandoffPrompt(memoryMarkdown, userPrompt) {
    const brief = String(memoryMarkdown || '').trim();
    if (!brief) return userPrompt;
    return [
        'Handoff from earlier turns in this Telegram topic. This engine has no native session here. Treat the brief as background, then do the latest request.',
        '',
        brief,
        '',
        'Latest request:',
        userPrompt
    ].join('\n');
}

function takeHandoffPrompt(session, prompt, memoryDir) {
    if (!session.pendingHandoff) {
        return { prompt, consumed: false };
    }
    session.pendingHandoff = false;
    const brief = readMemoryMarkdown(memoryDir, session.id);
    return { prompt: buildHandoffPrompt(brief, prompt), consumed: true };
}

function engineHasNativeSession(session, engine) {
    if (engine === 'grok') return Boolean(session.grokSessionId);
    return Boolean(session.agyConversationId);
}

function switchEngine(session, selected) {
    session.engine = selected;
    const resumed = engineHasNativeSession(session, selected);
    session.isNew = !resumed;
    session.pendingHandoff = !resumed;
    return { resumed };
}

function archiveTopicMemory(memoryDir, sessionId) {
    const jsonPath = memoryJsonPath(memoryDir, sessionId);
    const mdPath = memoryMarkdownPath(memoryDir, sessionId);
    const hasJson = fs.existsSync(jsonPath);
    const hasMd = fs.existsSync(mdPath);
    if (!hasJson && !hasMd) return null;

    const archiveDir = path.join(memoryDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${safeId(sessionId)}-${stamp}`;
    if (hasJson) fs.renameSync(jsonPath, path.join(archiveDir, `${base}.json`));
    if (hasMd) fs.renameSync(mdPath, path.join(archiveDir, `${base}.md`));
    return path.join(archiveDir, base);
}

module.exports = {
    MAX_TURNS,
    MAX_FILES,
    extractChangedFiles,
    recordTopicTurn,
    renderMarkdown,
    readMemoryMarkdown,
    memoryExists,
    buildHandoffPrompt,
    takeHandoffPrompt,
    engineHasNativeSession,
    switchEngine,
    archiveTopicMemory,
    loadMemory,
    memoryMarkdownPath
};
