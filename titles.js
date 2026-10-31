'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_AGY_DB_PATH = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversation_summaries.db');
const DEFAULT_GROK_SESSIONS_DIR = path.join(os.homedir(), '.grok', 'sessions');
const DEFAULT_MEMORY_DIR = path.join(__dirname, 'memory');
const MAX_TOPIC_TITLE_LEN = 64;

const GENERIC_EXACT_TITLES = new Set([
    'new chat',
    'new session',
    'new chat session',
    'untitled',
    'main chat',
    'general greeting',
    'current time inquiry',
    'ai model identity inquiry',
    'incomplete request continuation',
    'hi',
    'hi there',
    'hello',
    'hello there',
    'hey',
    'hey there',
    'yo',
    'test',
    'ping',
    'could we',
    'can we',
    'help',
    'i need some advice',
    'i need advice',
    'need advice',
    'need help',
    'quick question',
    'question'
]);

const ADVICE_PATTERN = /^(?:(?:hi|hello|hey)(?:\s+there)?[,!.\s]+)?(?:i\s+(?:need|want|would\s+like)|can\s+i\s+get|give\s+me|looking\s+for|i'?m\s+looking\s+for)\s+(?:some\s+)?(advice|help|guidance|info|information|suggestions|tips|recommendations|thoughts)\s+(?:on|about|with|for|regarding)\s+(.+)$/i;

const FILLER_PREFIXES = [
    /^(?:hi|hello|hey)(?:\s+there)?[,!.\s]+/i,
    /^(?:i\s+wanted\s+to\s+(?:ask|know|check|see)\s+(?:about\s+)?)/i,
    /^(?:i\s+need\s+to\s+(?:ask|check|know|see|find)\s+(?:about\s+)?)/i,
    /^(?:i\s+(?:need|want|would\s+like)\s+(?:some\s+)?(?:advice|help|guidance|info|information|suggestions|tips)\s+(?:on|about|with|for)\s+)/i,
    /^(?:(?:could|can|would|will)\s+you\s+(?:please\s+)?(?:help\s+me\s+(?:with\s+|to\s+)?|find\s+(?:me\s+)?|check\s+|tell\s+me\s+(?:about\s+|the\s+)?|look\s+into\s+|explain\s+)?)/i,
    /^(?:do\s+you\s+know\s+(?:what'?s\s+up\s+with\s+|about\s+)?)/i,
    /^(?:what(?:'s|\s+is|\s+are)\s+(?:the\s+)?(?:up\s+with\s+)?)/i,
    /^(?:please\s+)/i,
    /^(?:let'?s\s+(?:do|look\s+at|check|talk\s+about)\s+)/i,
    /^(?:you\s+know\s+(?:my|the)\s+)/i,
    /^(?:my|the|a|an)\s+(?=\S+\s+\S+)/i
];

const LOWERCASE_TITLE_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'for', 'nor', 'on', 'at', 'to', 'from', 'by', 'in', 'of', 'with', 'about', 'into', 'onto', 'per', 'via'
]);

function sanitizeTopicTitle(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let cleaned = raw
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[*_`~]+/g, '')
        .replace(/^#+\s*/, '')
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleaned) return '';

    if (cleaned.length > MAX_TOPIC_TITLE_LEN) {
        const sliced = cleaned.slice(0, MAX_TOPIC_TITLE_LEN);
        const lastSpace = sliced.lastIndexOf(' ');
        cleaned = (lastSpace > 24 ? sliced.slice(0, lastSpace) : sliced).trim();
    }

    return cleaned;
}

function normalizeForComparison(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isPromptEchoTitle(candidate, prompt) {
    if (!candidate || !prompt) return false;
    const firstLine = String(prompt)
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(l => l && !l.startsWith('/'));
    if (!firstLine) return false;

    const candNorm = normalizeForComparison(candidate);
    const promptNorm = normalizeForComparison(firstLine);
    if (!candNorm || !promptNorm) return false;

    return candNorm === promptNorm;
}

function isGenericTopicTitle(title) {
    const cleaned = sanitizeTopicTitle(title);
    if (!cleaned) return true;
    if (cleaned.startsWith('/')) return true;
    if (/^topic\s*#\d+$/i.test(cleaned)) return true;
    if (cleaned.endsWith('...') || cleaned.endsWith('…')) return true;
    if (String(title).trim().endsWith('...') || String(title).trim().endsWith('…')) return true;

    const lower = cleaned.toLowerCase().replace(/[.!?]+$/g, '').trim();
    if (GENERIC_EXACT_TITLES.has(lower)) return true;
    if (lower.length <= 3) return true;

    return false;
}

function toSmartTitleCase(text) {
    const words = text.split(/\s+/).filter(Boolean);
    return words.map((word, idx) => {
        // Preserve words that already contain uppercase letters after index 0 (e.g. AI, PBS, VRChat, Proxmox)
        if (/[A-Z]/.test(word.slice(1)) || (/^[A-Z]{2,}$/.test(word))) {
            return word;
        }
        const lower = word.toLowerCase();
        if (idx > 0 && idx < words.length - 1 && LOWERCASE_TITLE_WORDS.has(lower)) {
            return lower;
        }
        return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join(' ');
}

function deriveFallbackTitle(prompt) {
    if (!prompt || typeof prompt !== 'string') return '';
    const firstLine = prompt
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(l => l && !l.startsWith('/'));

    if (!firstLine) return '';

    let text = firstLine
        .replace(/https?:\/\/\S+/g, match => {
            try {
                const u = new URL(match);
                return u.host;
            } catch {
                return '';
            }
        })
        .replace(/[*_`~#]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    // Take first sentence/clause if reasonable
    const clause = text.split(/[?!.;]+/)[0].trim();
    if (clause.length >= 6) {
        text = clause;
    }

    if (isGenericTopicTitle(text)) return '';

    // Special handling for "i need advice about <X>" -> "<X> Advice"
    const adviceMatch = text.match(ADVICE_PATTERN);
    if (adviceMatch) {
        const noun = adviceMatch[1].toLowerCase();
        let subject = adviceMatch[2].replace(/[,:;]+$/, '').trim();
        for (const re of FILLER_PREFIXES) {
            subject = subject.replace(re, '').trim();
        }
        const subjectWords = subject.split(/\s+/).filter(Boolean).slice(0, 6);
        if (subjectWords.length > 0) {
            const combined = [...subjectWords, noun].join(' ');
            return sanitizeTopicTitle(toSmartTitleCase(combined));
        }
    }

    for (const re of FILLER_PREFIXES) {
        text = text.replace(re, '').trim();
    }

    if (isGenericTopicTitle(text)) return '';

    // Limit to first ~7 words and MAX_TOPIC_TITLE_LEN chars without mid-word ellipsis
    const words = text.split(/\s+/).filter(Boolean).slice(0, 7);
    let candidate = words.join(' ').replace(/[,:;]+$/, '').trim();
    if (!candidate) return '';

    candidate = candidate.charAt(0).toUpperCase() + candidate.slice(1);
    return sanitizeTopicTitle(candidate);
}

function readAgyConversationTitle(conversationId, { dbPath = DEFAULT_AGY_DB_PATH } = {}) {
    return new Promise((resolve) => {
        if (!conversationId || !fs.existsSync(dbPath)) {
            resolve('');
            return;
        }

        const script = [
            'import sqlite3, sys',
            'conn = sqlite3.connect(sys.argv[1])',
            'row = conn.execute("SELECT title FROM conversation_summaries WHERE conversation_id = ?", (sys.argv[2],)).fetchone()',
            'print(row[0] if row and row[0] else "")'
        ].join('; ');

        execFile('python3', ['-c', script, dbPath, conversationId], { timeout: 4000 }, (err, stdout) => {
            if (err) {
                resolve('');
                return;
            }
            resolve(sanitizeTopicTitle(stdout));
        });
    });
}

function readGrokSessionTitle(workspace, sessionId, { grokSessionsDir = DEFAULT_GROK_SESSIONS_DIR } = {}) {
    return new Promise((resolve) => {
        if (!sessionId || !fs.existsSync(grokSessionsDir)) {
            resolve('');
            return;
        }

        const candidates = [];
        if (workspace) {
            candidates.push(path.join(grokSessionsDir, encodeURIComponent(workspace), sessionId, 'summary.json'));
        }

        try {
            for (const entry of fs.readdirSync(grokSessionsDir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    const p = path.join(grokSessionsDir, entry.name, sessionId, 'summary.json');
                    if (!candidates.includes(p)) candidates.push(p);
                }
            }
        } catch {}

        for (const summaryPath of candidates) {
            try {
                if (!fs.existsSync(summaryPath)) continue;
                const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
                const title = sanitizeTopicTitle(data?.session_summary || data?.generated_title || '');
                if (title) {
                    resolve(title);
                    return;
                }
            } catch {}
        }

        resolve('');
    });
}

function readFirstPromptFromMemory(sessionId, { memoryDir = DEFAULT_MEMORY_DIR } = {}) {
    if (!sessionId || !memoryDir) return '';
    try {
        const filePath = path.join(memoryDir, `${sessionId}.json`);
        if (!fs.existsSync(filePath)) return '';
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(data?.turns) && data.turns.length > 0 && data.turns[0]?.request) {
            return String(data.turns[0].request);
        }
        return String(data?.latestRequest || '');
    } catch {
        return '';
    }
}

async function resolveSessionTitle(session, prompt, options = {}) {
    if (!session) return { title: '', source: 'none' };

    const effectivePrompt = prompt || readFirstPromptFromMemory(session.id, options);
    const readAgy = options.readAgyTitle || ((id) => readAgyConversationTitle(id, options));
    const readGrok = options.readGrokTitle || ((ws, id) => readGrokSessionTitle(ws, id, options));

    const preferGrok = session.engine === 'grok';
    const readers = preferGrok
        ? [
            async () => (session.grokSessionId ? readGrok(session.workspace, session.grokSessionId) : ''),
            async () => (session.agyConversationId ? readAgy(session.agyConversationId) : '')
        ]
        : [
            async () => (session.agyConversationId ? readAgy(session.agyConversationId) : ''),
            async () => (session.grokSessionId ? readGrok(session.workspace, session.grokSessionId) : '')
        ];

    for (const reader of readers) {
        const aiTitle = sanitizeTopicTitle(await reader());
        if (aiTitle && !isGenericTopicTitle(aiTitle) && !isPromptEchoTitle(aiTitle, effectivePrompt)) {
            return { title: aiTitle, source: 'ai' };
        }
    }

    const fallback = deriveFallbackTitle(effectivePrompt);
    if (fallback && !isGenericTopicTitle(fallback)) {
        return { title: fallback, source: 'fallback' };
    }

    return { title: '', source: 'none' };
}

async function renameForumTopicOnTelegram(telegram, chatId, threadId, name) {
    if (!telegram || !chatId || !threadId || !name) return false;
    const cleanName = sanitizeTopicTitle(name);
    if (!cleanName) return false;

    const targetChatId = /^-?\d+$/.test(String(chatId)) ? Number(chatId) : chatId;
    const targetThreadId = Number(threadId);

    try {
        if (typeof telegram.editForumTopic === 'function') {
            await telegram.editForumTopic(targetChatId, targetThreadId, { name: cleanName });
            return true;
        }
        if (typeof telegram.callApi === 'function') {
            await telegram.callApi('editForumTopic', {
                chat_id: targetChatId,
                message_thread_id: targetThreadId,
                name: cleanName
            });
            return true;
        }
    } catch (err) {
        const msg = String(err?.description || err?.message || '');
        if (msg.includes('TOPIC_NOT_MODIFIED')) {
            return true;
        }
        if (msg.includes('TOPIC_ID_INVALID')) {
            return false;
        }
        throw err;
    }
    return false;
}

module.exports = {
    MAX_TOPIC_TITLE_LEN,
    sanitizeTopicTitle,
    isGenericTopicTitle,
    isPromptEchoTitle,
    deriveFallbackTitle,
    readFirstPromptFromMemory,
    readAgyConversationTitle,
    readGrokSessionTitle,
    resolveSessionTitle,
    renameForumTopicOnTelegram
};
