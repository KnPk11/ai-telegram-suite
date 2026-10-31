'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const titles = require('../titles');

test('isGenericTopicTitle detects slash commands, greetings, and truncated snippets', () => {
    assert.equal(titles.isGenericTopicTitle(''), true);
    assert.equal(titles.isGenericTopicTitle('/engine'), true);
    assert.equal(titles.isGenericTopicTitle('/sessions'), true);
    assert.equal(titles.isGenericTopicTitle('New Chat'), true);
    assert.equal(titles.isGenericTopicTitle('New chat'), true);
    assert.equal(titles.isGenericTopicTitle('New session'), true);
    assert.equal(titles.isGenericTopicTitle('Hi there'), true);
    assert.equal(titles.isGenericTopicTitle('Topic #71390'), true);
    assert.equal(titles.isGenericTopicTitle('How is my system...'), true);
    assert.equal(titles.isGenericTopicTitle('Could we'), true);
    assert.equal(titles.isGenericTopicTitle('i need some advice'), true);

    assert.equal(titles.isGenericTopicTitle('PBS Datastore Folders Files Size Stats'), false);
    assert.equal(titles.isGenericTopicTitle('Troubleshooting Retro Tank Game Deployment'), false);
    assert.equal(titles.isGenericTopicTitle('AI Voice Agents Advice'), false);
});

test('deriveFallbackTitle strips conversational filler and transforms advice requests into concise titles', () => {
    assert.equal(
        titles.deriveFallbackTitle('i need advice about AI voice agents'),
        'AI Voice Agents Advice'
    );
    assert.equal(
        titles.deriveFallbackTitle('i need some advice on homelab backups'),
        'Homelab Backups Advice'
    );
    assert.equal(
        titles.deriveFallbackTitle('I wanted to ask about my Paperclip service that is developing the retro tank game.'),
        'Paperclip service that is developing the retro'
    );
    assert.equal(
        titles.deriveFallbackTitle('Could you find me the latest backup logs on proxmox?'),
        'Latest backup logs on proxmox'
    );
    assert.equal(titles.deriveFallbackTitle('/engine'), '');
    assert.equal(titles.deriveFallbackTitle('Hi there!'), '');
});

test('resolveSessionTitle prefers AI title over fallback and skips generic or verbatim-echo AI titles', async () => {
    const session = {
        engine: 'agy',
        workspace: '/root',
        agyConversationId: 'conv-123',
        grokSessionId: 'grok-456'
    };

    const resAi = await titles.resolveSessionTitle(session, 'Check my tank game', {
        readAgyTitle: async () => 'Troubleshooting Retro Tank Game Deployment',
        readGrokTitle: async () => ''
    });
    assert.deepEqual(resAi, {
        title: 'Troubleshooting Retro Tank Game Deployment',
        source: 'ai'
    });

    const resGenericAi = await titles.resolveSessionTitle(session, 'Fix the nginx reverse proxy config', {
        readAgyTitle: async () => 'General Greeting',
        readGrokTitle: async () => ''
    });
    assert.deepEqual(resGenericAi, {
        title: 'Fix the nginx reverse proxy config',
        source: 'fallback'
    });

    const grokSession = {
        engine: 'grok',
        workspace: '/root',
        grokSessionId: 'grok-789'
    };
    const resEchoGrok = await titles.resolveSessionTitle(grokSession, 'i need advice about AI voice agents', {
        readAgyTitle: async () => '',
        readGrokTitle: async () => 'i need advice about AI voice agents'
    });
    assert.deepEqual(resEchoGrok, {
        title: 'AI Voice Agents Advice',
        source: 'fallback'
    });
});

test('resolveSessionTitle falls back to stored topic memory when prompt and AI summary are empty', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-titles-test-'));
    try {
        fs.writeFileSync(
            path.join(tmpDir, '522963646_999.json'),
            JSON.stringify({
                turns: [{ request: 'i need some advice on homelab backups' }]
            }),
            'utf8'
        );
        const session = {
            id: '522963646_999',
            engine: 'grok',
            workspace: '/root',
            grokSessionId: 'grok-empty-summary'
        };
        const res = await titles.resolveSessionTitle(session, '', {
            memoryDir: tmpDir,
            readAgyTitle: async () => '',
            readGrokTitle: async () => ''
        });
        assert.deepEqual(res, {
            title: 'Homelab Backups Advice',
            source: 'fallback'
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('renameForumTopicOnTelegram converts numeric chatId and treats TOPIC_NOT_MODIFIED as success', async () => {
    const calls = [];
    const mockTelegram = {
        async editForumTopic(chatId, threadId, extra) {
            calls.push({ chatId, threadId, extra });
        }
    };

    const ok = await titles.renameForumTopicOnTelegram(mockTelegram, '522963646', 71373, '  *Tank Game Fix*  ');
    assert.equal(ok, true);
    assert.deepEqual(calls, [
        { chatId: 522963646, threadId: 71373, extra: { name: 'Tank Game Fix' } }
    ]);

    const notModifiedTelegram = {
        async editForumTopic() {
            throw new Error('400: Bad Request: TOPIC_NOT_MODIFIED');
        }
    };
    assert.equal(
        await titles.renameForumTopicOnTelegram(notModifiedTelegram, '522963646', 71373, 'Tank Game Fix'),
        true
    );
});
