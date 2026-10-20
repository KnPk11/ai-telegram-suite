'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const memory = require('../memory');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'topic-memory-'));
}

function session(overrides = {}) {
    return {
        id: 'chat_topic',
        chatId: 'chat',
        threadId: 7,
        topicName: 'Wrapper',
        workspace: '/root',
        agyConversationId: 'agy-1',
        grokSessionId: null,
        engine: 'agy',
        isNew: false,
        pendingHandoff: false,
        ...overrides
    };
}

test('records a short brief and ignores read-only tools', () => {
    const dir = tempDir();
    const current = session();
    memory.recordTopicTurn(dir, current, {
        engine: 'agy',
        request: 'Add topic support',
        outcome: 'Updated bot.js and the docs.',
        toolCalls: [
            { name: 'read_file', params: { file_path: '/root/telegram-terminal/bot.js' } },
            { name: 'search_replace', params: { file_path: '/root/telegram-terminal/bot.js' } },
            { name: 'write_to_file', params: '{"TargetFile":"/root/telegram-terminal/README.md"}' }
        ]
    });

    const saved = memory.loadMemory(dir, current.id);
    assert.equal(saved.latestRequest, 'Add topic support');
    assert.equal(saved.agyConversationId, 'agy-1');
    assert.deepEqual(saved.filesTouched.map(file => file.path), [
        '/root/telegram-terminal/bot.js',
        '/root/telegram-terminal/README.md'
    ]);

    const markdown = memory.readMemoryMarkdown(dir, current.id);
    assert.match(markdown, /# Topic memory/);
    assert.match(markdown, /Add topic support/);
    assert.doesNotMatch(markdown, /read_file/);
});

test('keeps the newest turns and the newest tool for a repeated path', () => {
    const dir = tempDir();
    const current = session();
    for (let i = 0; i < memory.MAX_TURNS + 2; i += 1) {
        memory.recordTopicTurn(dir, current, {
            engine: i % 2 === 0 ? 'agy' : 'grok',
            request: `request ${i}`,
            outcome: `outcome ${i}`,
            toolCalls: [{ name: 'search_replace', params: { path: '/tmp/bot.js' } }]
        });
    }

    const saved = memory.loadMemory(dir, current.id);
    assert.equal(saved.turns.length, memory.MAX_TURNS);
    assert.equal(saved.turns[0].request, 'request 2');
    assert.equal(saved.turns.at(-1).request, `request ${memory.MAX_TURNS + 1}`);
    assert.equal(saved.filesTouched.length, 1);
    assert.equal(saved.filesTouched[0].tool, 'search_replace');
});

test('engine switch keeps both ids and hands off only a missing destination session', () => {
    const current = session({ agyConversationId: 'agy-1', grokSessionId: 'grok-1' });
    const backToGrok = memory.switchEngine(current, 'grok');
    assert.equal(backToGrok.resumed, true);
    assert.equal(current.pendingHandoff, false);
    assert.equal(current.isNew, false);
    assert.equal(current.agyConversationId, 'agy-1');
    assert.equal(current.grokSessionId, 'grok-1');

    const freshGrok = session({ grokSessionId: null });
    const handoff = memory.switchEngine(freshGrok, 'grok');
    assert.equal(handoff.resumed, false);
    assert.equal(freshGrok.pendingHandoff, true);
    assert.equal(freshGrok.isNew, true);
    assert.equal(freshGrok.agyConversationId, 'agy-1');
});

test('handoff is attached once, then later turns stay on the native session', () => {
    const dir = tempDir();
    const current = session({ pendingHandoff: true, grokSessionId: null, engine: 'grok' });
    memory.recordTopicTurn(dir, current, {
        engine: 'agy',
        request: 'Build topics',
        outcome: 'Topics now have separate sessions.',
        toolCalls: []
    });

    const first = memory.takeHandoffPrompt(current, 'What was done?', dir);
    assert.equal(first.consumed, true);
    assert.equal(current.pendingHandoff, false);
    assert.match(first.prompt, /Handoff from earlier turns/);
    assert.match(first.prompt, /Build topics/);
    assert.match(first.prompt, /Latest request:\nWhat was done\?$/);

    const second = memory.takeHandoffPrompt(current, 'Continue', dir);
    assert.equal(second.consumed, false);
    assert.equal(second.prompt, 'Continue');
});

test('/new archives the brief and leaves the topic without an active memory file', () => {
    const dir = tempDir();
    const current = session();
    memory.recordTopicTurn(dir, current, {
        engine: 'grok',
        request: 'Remember this',
        outcome: 'Noted.',
        toolCalls: []
    });

    const archived = memory.archiveTopicMemory(dir, current.id);
    assert.ok(archived);
    assert.equal(fs.existsSync(`${archived}.md`), true);
    assert.equal(memory.memoryExists(dir, current.id), false);
    assert.equal(memory.archiveTopicMemory(dir, current.id), null);
});
