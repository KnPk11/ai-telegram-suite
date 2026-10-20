const { Telegraf, Markup } = require('telegraf');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
    recordTopicTurn,
    takeHandoffPrompt,
    switchEngine,
    archiveTopicMemory,
    memoryExists
} = require('./memory');
const {
    parseAllowedUserIds,
    createAuthMiddleware
} = require('./auth');
require('dotenv').config();

const ENV_PATH = path.join(__dirname, '.env');
const SESSIONS_PATH = path.join(__dirname, 'sessions.json');
const MEMORY_DIR = path.join(__dirname, 'memory');
const BOT_TOKEN = process.env.BOT_TOKEN;

const ALLOWED_CHAT_IDS = parseAllowedUserIds(process.env.ALLOWED_CHAT_IDS || process.env.ALLOWED_USER_IDS || '');

const SYSTEM_PATH = process.env.SYSTEM_PATH || `${path.join(os.homedir(), '.local', 'bin')}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const AGY_BIN = process.env.AGY_BIN || '/usr/local/bin/agy';
const GROK_BIN = process.env.GROK_BIN || '/usr/local/bin/grok';

const AGY_MODELS = [
    { id: 'gemini-3.8-flash-high', label: '⚡ Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-medium', label: '⚡ Gemini 3.8 Flash (Med)' },
    { id: 'gemini-3.1-pro-high', label: '🧠 Gemini 3.1 Pro (High)' },
    { id: 'claude-sonnet-4-6', label: '🎭 Claude Sonnet 4.6' },
    { id: 'claude-opus-4-6-thinking', label: '👑 Claude Opus 4.6' },
    { id: 'gpt-oss-120b-medium', label: '🌐 GPT-OSS 120B' }
];

const GROK_MODELS = [
    { id: 'grok-4.7', label: '⚡ Grok 4.7 (Default)' },
    { id: 'grok-4.7-build-fast', label: '🏎️ Grok 4.7 Fast' },
    { id: 'grok-4.6', label: '🧠 Grok 4.6' },
    { id: 'grok-4.5', label: '💡 Grok 4.5' }
];

const AGY_EFFORTS = [
    { id: '', label: 'Default' },
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'max', label: 'Max' }
];

const GROK_EFFORTS = [
    { id: '', label: 'Default' },
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra High' }
];

if (!BOT_TOKEN) {
    console.error('Error: BOT_TOKEN is missing in .env');
    process.exit(1);
}

// Handler timeout set to 24 hours to prevent Telegraf 90-second timeout crashes during agent runs
const bot = new Telegraf(BOT_TOKEN, {
    handlerTimeout: 86400000
});

bot.catch((err, ctx) => {
    console.error(`[Telegraf] Unhandled error on update ${ctx?.update?.update_id}:`, err);
});

// ---------------------------------------------------------------------
// Multi-Session State Management (Per Chat & Per Topic/Thread)
// ---------------------------------------------------------------------
let sessions = {};

function loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_PATH)) {
            const raw = fs.readFileSync(SESSIONS_PATH, 'utf8');
            sessions = JSON.parse(raw) || {};
            for (const key of Object.keys(sessions)) {
                sessions[key].activeProcess = null;
            }
            console.log(`[Sessions] Loaded ${Object.keys(sessions).length} topic sessions from storage.`);
        }
    } catch (err) {
        console.error('[Sessions] Error reading sessions file:', err);
        sessions = {};
    }
}

function saveSessions() {
    try {
        const serialisable = {};
        for (const [key, sess] of Object.entries(sessions)) {
            serialisable[key] = {
                id: sess.id,
                chatId: sess.chatId,
                threadId: sess.threadId,
                topicName: sess.topicName,
                engine: sess.engine,
                workspace: sess.workspace,
                agyModel: sess.agyModel,
                grokModel: sess.grokModel,
                agyEffort: sess.agyEffort,
                grokEffort: sess.grokEffort,
                agyConversationId: sess.agyConversationId,
                grokSessionId: sess.grokSessionId,
                isNew: sess.isNew,
                pendingHandoff: Boolean(sess.pendingHandoff),
                turnCount: sess.turnCount || 0,
                createdAt: sess.createdAt,
                lastActive: sess.lastActive
            };
        }
        fs.writeFileSync(SESSIONS_PATH, JSON.stringify(serialisable, null, 2), 'utf8');
    } catch (err) {
        console.error('[Sessions] Error persisting sessions file:', err);
    }
}

// Map to track newly created forum topics and route opening prompts typed into the 'All' tab
const recentCreatedTopics = new Map(); // chatId -> { threadId, topicName, timestamp, handledPrompt, timer }

function extractThreadId(ctx) {
    if (ctx?.state && ctx.state.threadId !== undefined) {
        return ctx.state.threadId;
    }

    const msg = ctx?.message ||
                ctx?.callbackQuery?.message ||
                ctx?.channelPost ||
                ctx?.editedMessage ||
                ctx?.msg;

    let threadId = msg?.message_thread_id || null;

    if (!threadId && msg?.forum_topic_created) {
        threadId = msg.message_id || null;
    }

    if (!threadId && msg?.reply_to_message?.message_thread_id) {
        threadId = msg.reply_to_message.message_thread_id;
    }

    if (!threadId && msg?.reply_to_message?.forum_topic_created) {
        threadId = msg.reply_to_message.message_id || null;
    }

    // Auto-routing for messages sent from the 'All' tab that triggered a new thread:
    // If a topic was created in this chat within the last 15 seconds, route the incoming prompt
    // to that newly created topic thread so replies and context stay inside the thread.
    const chatId = ctx?.chat?.id?.toString();
    if (!threadId && chatId && recentCreatedTopics.has(chatId)) {
        const recent = recentCreatedTopics.get(chatId);
        if (Date.now() - recent.timestamp < 15000) {
            threadId = recent.threadId;
            recent.handledPrompt = true;
            if (ctx?.state) {
                ctx.state.isInitialTopicTurn = true;
                ctx.state.topicName = recent.topicName;
            }
        } else {
            recentCreatedTopics.delete(chatId);
        }
    }

    if (ctx?.state) {
        ctx.state.threadId = threadId;
    }

    return threadId;
}

function getSessionKey(ctx) {
    const chatId = ctx.chat?.id?.toString() || 'default';
    const threadId = extractThreadId(ctx);
    return threadId ? `${chatId}_${threadId}` : `${chatId}_main`;
}

function getSession(ctx) {
    const key = getSessionKey(ctx);
    const chatId = ctx.chat?.id?.toString() || 'default';
    const threadId = extractThreadId(ctx);

    if (!sessions[key]) {
        let topicName = null;
        if (ctx.message?.forum_topic_created?.name) {
            topicName = ctx.message.forum_topic_created.name;
        }

        sessions[key] = {
            id: key,
            chatId,
            threadId,
            topicName,
            engine: process.env.DEFAULT_ENGINE || 'agy',
            workspace: process.env.DEFAULT_WORKSPACE || process.env.DEFAULT_CWD || os.homedir(),
            agyModel: process.env.DEFAULT_AGY_MODEL || 'gemini-3.8-flash-high',
            grokModel: process.env.DEFAULT_GROK_MODEL || 'grok-4.7',
            agyEffort: process.env.DEFAULT_AGY_EFFORT || '',
            grokEffort: process.env.DEFAULT_GROK_EFFORT || '',
            agyConversationId: null,
            grokSessionId: null,
            isNew: true,
            pendingHandoff: false,
            activeProcess: null,
            turnCount: 0,
            createdAt: Date.now(),
            lastActive: Date.now()
        };
        saveSessions();
    } else {
        if (ctx.message?.forum_topic_created?.name) {
            sessions[key].topicName = ctx.message.forum_topic_created.name;
        }
        sessions[key].lastActive = Date.now();
    }

    return sessions[key];
}

function getCurrentModel(session) {
    return session.engine === 'grok' ? session.grokModel : session.agyModel;
}

function getCurrentEffort(session) {
    return session.engine === 'grok' ? session.grokEffort : session.agyEffort;
}

function getEngineLabel(session) {
    return session.engine === 'grok' ? 'xAI Grok' : 'Google Antigravity';
}

function getTopicDisplayName(session) {
    if (session.topicName) return session.topicName;
    if (session.threadId) return `Topic #${session.threadId}`;
    return 'Main Chat';
}

function getLatestGrokSession(dir, preferredSessionId = null) {
    if (preferredSessionId) return preferredSessionId;
    const enc = encodeURIComponent(dir);
    const p = path.join(os.homedir(), '.grok', 'sessions', enc);
    if (!fs.existsSync(p)) return null;
    try {
        const entries = fs.readdirSync(p, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => ({
                id: d.name,
                mtime: fs.statSync(path.join(p, d.name)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime);
        return entries.length > 0 ? entries[0].id : null;
    } catch {
        return null;
    }
}


// ---------------------------------------------------------------------
// Middleware 1: Thread Routing Enforcer
// Guarantees all replies, documents, and chat actions are sent to the correct topic
// ---------------------------------------------------------------------
bot.use(async (ctx, next) => {
    const threadId = extractThreadId(ctx);
    if (threadId) {
        const origReply = ctx.reply.bind(ctx);
        ctx.reply = (text, extra = {}) => {
            const opts = { message_thread_id: threadId, ...extra };
            if (!opts.message_thread_id) opts.message_thread_id = threadId;
            return origReply(text, opts);
        };

        const origReplyWithDocument = ctx.replyWithDocument.bind(ctx);
        ctx.replyWithDocument = (doc, extra = {}) => {
            const opts = { message_thread_id: threadId, ...extra };
            if (!opts.message_thread_id) opts.message_thread_id = threadId;
            return origReplyWithDocument(doc, opts);
        };

        const origSendChatAction = ctx.sendChatAction.bind(ctx);
        ctx.sendChatAction = (action, extra = {}) => {
            const opts = { message_thread_id: threadId, ...extra };
            if (!opts.message_thread_id) opts.message_thread_id = threadId;
            return origSendChatAction(action, opts);
        };
    }
    return next();
});

// ---------------------------------------------------------------------
// Middleware 2: Authorisation Middleware
// Strictly verifies individual user IDs (fromId).
// Never authorises entire groups or channels.
// ---------------------------------------------------------------------
bot.use(createAuthMiddleware(ALLOWED_CHAT_IDS));

// Helper: Auto-balance code blocks to avoid Telegram markdown parse errors during streaming
function balanceMarkdown(text) {
    if (!text) return text;
    const fences = (text.match(/```/g) || []).length;
    let out = text;
    if (fences % 2 !== 0) {
        out += '\n```';
    }
    return out;
}

// Helper: Format tool calls cleanly for Antigravity & Grok
function formatToolCall(name, params = {}) {
    if (!name) return '`tool`';

    if ((name === 'run_command' || name === 'run_terminal_command') && (params.CommandLine || params.command)) {
        const rawCmd = params.CommandLine || params.command;
        const cmd = rawCmd.length > 45 ? rawCmd.slice(0, 42) + '...' : rawCmd;
        return `\`run_command("${cmd}")\``;
    }
    if ((name === 'view_file' || name === 'read_file') && (params.AbsolutePath || params.path || params.file_path)) {
        const p = params.AbsolutePath || params.path || params.file_path;
        return `\`read_file(${path.basename(p)})\``;
    }
    if ((name === 'replace_file_content' || name === 'search_replace') && (params.TargetFile || params.path)) {
        const p = params.TargetFile || params.path;
        return `\`edit_file(${path.basename(p)})\``;
    }
    if ((name === 'write_to_file' || name === 'write') && (params.TargetFile || params.path)) {
        const p = params.TargetFile || params.path;
        return `\`write_file(${path.basename(p)})\``;
    }
    if (name === 'list_dir' && (params.path || params.dir_path)) {
        const p = params.path || params.dir_path;
        return `\`list_dir(${path.basename(p) || '/'})\``;
    }
    if (name === 'grep' && params.pattern) {
        return `\`grep("${params.pattern}")\``;
    }
    if (name === 'search_web' && (params.query || params.search_term)) {
        const q = params.query || params.search_term;
        const shortQ = q.length > 35 ? q.slice(0, 32) + '...' : q;
        return `\`search_web("${shortQ}")\``;
    }
    if ((name === 'read_url_content' || name === 'web_fetch') && (params.Url || params.url)) {
        try {
            const u = new URL(params.Url || params.url);
            return `\`web_fetch(${u.hostname})\``;
        } catch {
            return `\`web_fetch\``;
        }
    }
    if (name === 'image_gen' && params.prompt) {
        const p = params.prompt.length > 30 ? params.prompt.slice(0, 27) + '...' : params.prompt;
        return `\`image_gen("${p}")\``;
    }
    return `\`${name}\``;
}

// Helper: send responses, chunking if long
async function sendLongResponse(ctx, text) {
    const trimmed = (text || '').trim();
    if (!trimmed) {
        await ctx.reply('*(No response generated)*', { parse_mode: 'Markdown' });
        return;
    }

    if (trimmed.length > 12000) {
        const preview = trimmed.slice(-3000);
        const tmpFile = path.join(os.tmpdir(), `agent-output-${Date.now()}.txt`);
        fs.writeFileSync(tmpFile, trimmed, 'utf8');

        await ctx.reply(
            `📄 *Output exceeded Telegram limit (attached as file)*\n\n\`\`\`\n... [truncated preview]\n${preview}\n\`\`\``,
            { parse_mode: 'Markdown' }
        );
        await ctx.replyWithDocument({ source: tmpFile, filename: 'agent-output.txt' });
        try { fs.unlinkSync(tmpFile); } catch {}
        return;
    }

    const CHUNK_SIZE = 3800;
    for (let i = 0; i < trimmed.length; i += CHUNK_SIZE) {
        const chunk = trimmed.slice(i, i + CHUNK_SIZE);
        try {
            await ctx.reply(chunk, { parse_mode: 'Markdown' });
        } catch {
            await ctx.reply(chunk);
        }
    }
}

// Core execution engine supporting per-topic sessions with LIVE STREAMING
async function runAgentStreamTurn(ctx, prompt, options = {}) {
    const session = options.session || getSession(ctx);
    const engine = options.engine || session.engine;
    const isGrok = engine === 'grok';
    const engineLabel = isGrok ? 'Grok' : 'Antigravity';
    const isInitialTopicTurn = options.isInitialTopicTurn || ctx?.state?.isInitialTopicTurn;

    let startStatus = `🤔 *Starting ${engineLabel} turn...*`;
    if (isInitialTopicTurn && session.topicName) {
        startStatus = `🤔 *Starting ${engineLabel} turn in new topic: ${session.topicName}...*`;
    }

    let statusMsg;
    try {
        statusMsg = await ctx.reply(startStatus, { parse_mode: 'Markdown' });
    } catch {
        statusMsg = await ctx.reply(startStatus.replace(/[*_`]/g, ''));
    }

    const toolCalls = [];
    let accumulatedText = '';
    let finalResultText = null;
    const handoff = takeHandoffPrompt(session, prompt, MEMORY_DIR);
    const modelPrompt = handoff.prompt;
    if (handoff.consumed) saveSessions();

    let turnRecorded = false;
    function recordFinishedTurn(exitCode, failureText) {
        if (turnRecorded) return;
        turnRecorded = true;
        if (!String(prompt || '').trim()) return;
        try {
            recordTopicTurn(MEMORY_DIR, session, {
                engine,
                request: prompt,
                outcome: failureText || finalResultText || accumulatedText,
                toolCalls,
                exitCode
            });
            console.log(`[Memory] Recorded turn for ${session.id}`);
        } catch (err) {
            console.error('[Memory] Failed to record topic turn:', err);
        }
    }
    let lastRenderedContent = '';
    let lastEditTime = 0;
    let editPending = false;
    let isFinished = false;

    function buildView(isFinal = false) {
        let content = '';

        if (isInitialTopicTurn) {
            content += `💡 *Initial Topic Prompt:* _${prompt}_\n━━━━━━━━━━━━━━━━\n`;
        }

        if (toolCalls.length > 0) {
            const toolLines = toolCalls.slice(-8).map(t => {
                const icon = t.state === 'DONE' ? '✅' : '⏳';
                return `• ${formatToolCall(t.name, t.params)} ${icon}`;
            }).join('\n');
            content += `🛠️ *Live Tools (${engineLabel}):*\n${toolLines}\n\n`;
        }

        const currentText = isFinal && finalResultText ? finalResultText : accumulatedText;

        if (currentText.trim()) {
            if (toolCalls.length > 0) {
                content += `━━━━━━━━━━━━━━━━\n`;
            }
            content += currentText;
        } else if (!isFinal) {
            if (toolCalls.length === 0) {
                content += `💭 *Thinking with ${engineLabel}...*`;
            }
        }

        if (!content.trim()) content = '*(Processing...)*';
        return content;
    }

    async function flushUpdate(isFinal = false) {
        const now = Date.now();
        if (!isFinal && (now - lastEditTime < 1600 || editPending)) {
            return;
        }

        const rawContent = buildView(isFinal);
        if (rawContent === lastRenderedContent && !isFinal) return;

        editPending = true;
        lastEditTime = now;
        lastRenderedContent = rawContent;

        let displayContent = rawContent;
        if (displayContent.length > 3800) {
            displayContent = displayContent.slice(0, 3800) + '\n\n... *(streaming continuation below)*';
        }

        const formatted = balanceMarkdown(displayContent);

        try {
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                null,
                formatted,
                { parse_mode: 'Markdown' }
            );
        } catch {
            try {
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    statusMsg.message_id,
                    null,
                    displayContent.replace(/[*_`~#]/g, '')
                );
            } catch {}
        } finally {
            editPending = false;
        }
    }

    const streamInterval = setInterval(() => {
        if (!isFinished) {
            flushUpdate(false).catch(() => {});
        }
    }, 1600);

    const typingInterval = setInterval(() => {
        ctx.sendChatAction('typing').catch(() => {});
    }, 4000);
    ctx.sendChatAction('typing').catch(() => {});

    return new Promise((resolve) => {
        let bin;
        const args = [];

        if (isGrok) {
            bin = GROK_BIN;
            args.push(
                '--always-approve',
                '--permission-mode', options.mode === 'plan' ? 'plan' : 'bypassPermissions',
                '--output-format', 'streaming-json'
            );

            // Resume this topic's own Grok session. A workspace-wide continue
            // would attach another topic that shares the same directory.
            if (!options.isNew && session.grokSessionId) {
                args.push('--resume', session.grokSessionId);
            }

            const model = options.model || session.grokModel;
            if (model) {
                args.push('-m', model);
            }

            const effort = options.effort || session.grokEffort;
            if (effort) {
                args.push('--effort', effort);
            }

            args.push('-p', modelPrompt);
        } else {
            bin = AGY_BIN;
            args.push(
                '--output-format', 'stream-json',
                '--dangerously-skip-permissions'
            );

            // Resume this topic's own Antigravity conversation.
            if (!options.isNew && session.agyConversationId) {
                args.push('--conversation', session.agyConversationId);
            }

            const model = options.model || session.agyModel;
            if (model) {
                args.push('--model', model);
            }

            const effort = options.effort || session.agyEffort;
            if (effort) {
                args.push('--effort', effort);
            }

            if (options.mode) {
                args.push('--mode', options.mode);
            }

            args.push('-p', modelPrompt);
        }

        const child = spawn(bin, args, {
            cwd: session.workspace,
            env: {
                ...process.env,
                PATH: SYSTEM_PATH,
                LANG: 'en_GB.UTF-8'
            }
        });

        session.activeProcess = child;

        try { child.stdin.end(); } catch {}

        const rl = readline.createInterface({
            input: child.stdout,
            crlfDelay: Infinity
        });

        rl.on('line', (line) => {
            if (!line.trim()) return;
            try {
                const data = JSON.parse(line);

                if (isGrok) {
                    if (data.type === 'text' && data.data) {
                        accumulatedText += data.data;
                    } else if (data.type === 'tool_call') {
                        toolCalls.push({
                            id: data.toolCallId,
                            name: data.toolName || data.title,
                            params: data.rawInput || {},
                            state: 'ACTIVE'
                        });
                    } else if (data.type === 'tool_call_update') {
                        if (data.status === 'completed' || data.status === 'failed') {
                            const idx = toolCalls.findLastIndex(t => (data.toolCallId && t.id === data.toolCallId) || t.state === 'ACTIVE');
                            if (idx !== -1) {
                                toolCalls[idx].state = 'DONE';
                            }
                        }
                    } else if (data.type === 'end') {
                        if (data.sessionId) {
                            session.grokSessionId = data.sessionId;
                            session.isNew = false;
                            saveSessions();
                        }
                    }
                } else {
                    if (data.event === 'init' && data.conversation_id) {
                        session.agyConversationId = data.conversation_id;
                        session.isNew = false;
                        saveSessions();
                    } else if (data.event === 'step_update' && data.step_update) {
                        const u = data.step_update;

                        if (u.step_type === 'tool') {
                            if (u.state === 'ACTIVE') {
                                toolCalls.push({
                                    name: u.tool_name,
                                    params: u.tool_info?.parameters || {},
                                    state: 'ACTIVE'
                                });
                            } else if (u.state === 'DONE') {
                                const activeIdx = toolCalls.findLastIndex(t => t.name === u.tool_name && t.state === 'ACTIVE');
                                if (activeIdx !== -1) {
                                    toolCalls[activeIdx].state = 'DONE';
                                }
                            }
                        }

                        if (u.step_type === 'agent_response' && u.text_delta) {
                            accumulatedText += u.text_delta;
                        }
                    } else if (data.event === 'result') {
                        if (data.result?.response) {
                            finalResultText = data.result.response;
                        }
                        if (data.result?.conversation_id) {
                            session.agyConversationId = data.result.conversation_id;
                            session.isNew = false;
                            saveSessions();
                        }
                    }
                }
            } catch {
                accumulatedText += line + '\n';
            }
        });

        child.stderr.on('data', (data) => {
            const str = data.toString();
            if (str.includes('Error:') || str.includes('panic:')) {
                accumulatedText += `\n[Stderr: ${str.trim()}]\n`;
            }
        });

        child.on('close', async (code) => {
            isFinished = true;
            clearInterval(streamInterval);
            clearInterval(typingInterval);
            session.activeProcess = null;
            session.turnCount = (session.turnCount || 0) + 1;
            session.lastActive = Date.now();
            saveSessions();
            recordFinishedTurn(code);

            await flushUpdate(true);

            const fullText = finalResultText || accumulatedText;
            const fullView = buildView(true);
            const prefixLen = Math.max(0, fullView.length - fullText.length);
            const renderedChars = Math.max(0, 3800 - prefixLen);
            if (fullText.length > renderedChars) {
                const remaining = fullText.slice(renderedChars);
                await sendLongResponse(ctx, remaining);
            }

            resolve(code ?? 0);
        });

        child.on('error', async (err) => {
            isFinished = true;
            clearInterval(streamInterval);
            clearInterval(typingInterval);
            session.activeProcess = null;
            saveSessions();
            recordFinishedTurn(-1, err.message);
            await ctx.reply(`❌ Process error: ${err.message}`);
            resolve(-1);
        });
    });
}

// ---------------------------------------------------------------------
// Telegram Forum Topic Event Handlers
// ---------------------------------------------------------------------
bot.on('forum_topic_created', async (ctx) => {
    const threadId = extractThreadId(ctx) || ctx.message?.message_thread_id || ctx.message?.message_id;
    const chatId = ctx.chat?.id?.toString();
    const topicInfo = ctx.message?.forum_topic_created;
    const topicName = topicInfo?.name || `Topic #${threadId}`;

    const session = getSession(ctx);
    session.topicName = topicName;
    saveSessions();

    if (chatId && threadId) {
        const existing = recentCreatedTopics.get(chatId);
        if (existing?.timer) clearTimeout(existing.timer);

        const record = {
            threadId,
            topicName,
            timestamp: Date.now(),
            handledPrompt: false,
            timer: null
        };

        // If the topic was created manually (not from a prompt typed in the 'All' tab),
        // send the initialisation greeting after 2.5 seconds.
        // If a prompt arrives within 2.5 seconds, handledPrompt becomes true and we avoid
        // sending an unnecessary greeting before the AI answer.
        record.timer = setTimeout(async () => {
            const current = recentCreatedTopics.get(chatId);
            if (current && current.threadId === threadId && !current.handledPrompt) {
                try {
                    await bot.telegram.sendMessage(
                        chatId,
                        `🌟 *Topic Session Initialised: ${topicName}*\n\n` +
                        `This topic operates as an independent session.\n` +
                        `• Engine: *${getEngineLabel(session)}*\n` +
                        `• Model: \`${getCurrentModel(session)}\`\n` +
                        `• Workspace: \`${session.workspace}\`\n\n` +
                        `Send any message here to start collaborating!`,
                        { message_thread_id: threadId, parse_mode: 'Markdown' }
                    );
                } catch (err) {
                    console.error('[Topics] Failed to send topic initialisation message:', err);
                }
            }
        }, 2500);

        recentCreatedTopics.set(chatId, record);
    }
});

// ---------------------------------------------------------------------
// Commands: Topic & Session Management
// ---------------------------------------------------------------------

// /sessions or /topics: list all active sessions in this chat
bot.command(['sessions', 'topics'], async (ctx) => {
    const currentChatId = ctx.chat?.id?.toString();
    const chatSessions = Object.values(sessions).filter(s => s.chatId === currentChatId);

    if (chatSessions.length === 0) {
        await ctx.reply('ℹ️ No active topics or sessions found for this chat yet.');
        return;
    }

    const currentSession = getSession(ctx);
    const lines = chatSessions.map(s => {
        const isCurrent = s.id === currentSession.id;
        const name = getTopicDisplayName(s);
        const status = s.activeProcess ? '⚙️ Running' : '💤 Idle';
        const engineLabel = s.engine === 'grok' ? 'Grok' : 'Antigravity';
        const model = s.engine === 'grok' ? s.grokModel : s.agyModel;
        return `${isCurrent ? '👉 ' : '• '}*${name}* [${status}]\n   Engine: ${engineLabel} | Model: \`${model}\` | Turns: ${s.turnCount || 0}`;
    });

    await ctx.reply(`📋 *Active AI Sessions in this Chat:*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
});

// /name or /topic: set or view the name of the current topic
bot.command(['name', 'topic'], async (ctx) => {
    const session = getSession(ctx);
    const newName = ctx.message.text.replace(/^\/(name|topic)/, '').trim();

    if (!newName) {
        await ctx.reply(
            `🏷️ *Topic Information*\n` +
            `• Current Name: *${getTopicDisplayName(session)}*\n` +
            `• Thread ID: \`${session.threadId || 'Main (no topic)'}\`\n` +
            `• Turns: ${session.turnCount || 0}\n\n` +
            `To rename this topic, type: \`/name <new name>\``,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    session.topicName = newName;
    saveSessions();
    await ctx.reply(`✅ Topic name updated to: *${newName}*`, { parse_mode: 'Markdown' });
});

// /engine command: toggle engine for the current topic
bot.command('engine', async (ctx) => {
    const session = getSession(ctx);
    const buttons = [
        [
            Markup.button.callback(
                `${session.engine === 'agy' ? '✅ ' : ''}🤖 Google Antigravity`,
                'set_engine:agy'
            )
        ],
        [
            Markup.button.callback(
                `${session.engine === 'grok' ? '✅ ' : ''}⚡ xAI Grok`,
                'set_engine:grok'
            )
        ]
    ];

    await ctx.reply(
        `⚙️ *Select AI Execution Engine*\n` +
        `📌 *Topic:* *${getTopicDisplayName(session)}*\n\n` +
        `• Active Engine: *${getEngineLabel(session)}*\n` +
        `• Active Model: \`${getCurrentModel(session)}\`\n` +
        `• Workspace: \`${session.workspace}\``,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        }
    );
});

bot.action(/^set_engine:(agy|grok)$/, async (ctx) => {
    const session = getSession(ctx);
    const selected = ctx.match[1];
    const { resumed } = switchEngine(session, selected);
    saveSessions();

    const continuity = resumed
        ? 'Resuming this engine\'s existing session for the topic.'
        : (memoryExists(MEMORY_DIR, session.id)
            ? 'This engine has no session in the topic yet. The next message includes the topic memory.'
            : 'This engine has no session in the topic yet. The next message starts a new session.');

    await ctx.answerCbQuery(`Switched to ${getEngineLabel(session)}`);
    await ctx.editMessageText(
        `✅ *Engine updated for ${getTopicDisplayName(session)}:* *${getEngineLabel(session)}*\n\n` +
        `• Model: \`${getCurrentModel(session)}\`\n` +
        `• Effort: \`${getCurrentEffort(session) || 'Default'}\`\n` +
        `• ${continuity}`,
        { parse_mode: 'Markdown' }
    );
});

// /model command: inline buttons tailored to active engine for the topic
bot.command('model', async (ctx) => {
    const session = getSession(ctx);
    const isGrok = session.engine === 'grok';
    const models = isGrok ? GROK_MODELS : AGY_MODELS;
    const activeModel = getCurrentModel(session);

    const buttons = models.map(m => [
        Markup.button.callback(
            `${m.id === activeModel ? '✅ ' : ''}${m.label}`,
            `set_model:${m.id}`
        )
    ]);

    await ctx.reply(
        `🤖 *Select AI Model (${getEngineLabel(session)})*\n` +
        `📌 *Topic:* *${getTopicDisplayName(session)}*\n` +
        `Current model: \`${activeModel}\``,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        }
    );
});

bot.action(/^set_model:(.+)$/, async (ctx) => {
    const session = getSession(ctx);
    const selected = ctx.match[1];
    if (session.engine === 'grok') {
        session.grokModel = selected;
    } else {
        session.agyModel = selected;
    }
    saveSessions();

    await ctx.answerCbQuery(`Switched to ${selected}`);
    await ctx.editMessageText(
        `✅ *Model updated for ${getTopicDisplayName(session)}:* \`${selected}\` (${getEngineLabel(session)})`,
        { parse_mode: 'Markdown' }
    );
});

// /effort command: inline buttons tailored to active engine for the topic
bot.command('effort', async (ctx) => {
    const session = getSession(ctx);
    const isGrok = session.engine === 'grok';
    const efforts = isGrok ? GROK_EFFORTS : AGY_EFFORTS;
    const activeEffort = getCurrentEffort(session);

    const buttons = [
        efforts.map(e =>
            Markup.button.callback(
                `${e.id === activeEffort ? '✅ ' : ''}${e.label}`,
                `set_effort:${e.id || 'default'}`
            )
        )
    ];

    await ctx.reply(
        `⚡ *Select Reasoning Effort (${getEngineLabel(session)})*\n` +
        `📌 *Topic:* *${getTopicDisplayName(session)}*\n` +
        `Current effort: \`${activeEffort || 'Default'}\``,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        }
    );
});

bot.action(/^set_effort:(.+)$/, async (ctx) => {
    const session = getSession(ctx);
    const raw = ctx.match[1];
    const selected = raw === 'default' ? '' : raw;

    if (session.engine === 'grok') {
        session.grokEffort = selected;
    } else {
        session.agyEffort = selected;
    }
    saveSessions();

    await ctx.answerCbQuery(`Effort set to ${selected || 'Default'}`);
    await ctx.editMessageText(
        `✅ *Reasoning effort set for ${getTopicDisplayName(session)}:* \`${selected || 'Default'}\` (${getEngineLabel(session)})`,
        { parse_mode: 'Markdown' }
    );
});

// Account billing. The TUI calls this x.ai/billing; on agent stdio the method is _x.ai/billing.
function fetchGrokBilling(cwd) {
    return new Promise((resolve) => {
        const proc = spawn(GROK_BIN, ['agent', '--always-approve', '--no-leader', 'stdio'], {
            cwd: cwd || '/tmp',
            env: { ...process.env, PATH: SYSTEM_PATH, LANG: 'en_GB.UTF-8' }
        });
        const rl = readline.createInterface({ input: proc.stdout });
        const pending = new Map();
        let nextId = 1;
        let settled = false;

        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rl.close();
            try { proc.stdin.end(); } catch {}
            proc.kill();
            resolve(value);
        };

        const timer = setTimeout(() => finish(null), 20000);

        function request(method, params) {
            const id = nextId++;
            return new Promise((res, rej) => {
                const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 15000);
                pending.set(id, (msg) => {
                    clearTimeout(t);
                    if (msg.error) rej(new Error(msg.error.message || method));
                    else res(msg.result);
                });
                proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
            });
        }

        rl.on('line', (line) => {
            let msg;
            try { msg = JSON.parse(line); } catch { return; }
            if (msg.id != null && pending.has(msg.id)) {
                const cb = pending.get(msg.id);
                pending.delete(msg.id);
                cb(msg);
            }
        });

        proc.on('error', () => finish(null));
        proc.on('close', () => finish(null));

        (async () => {
            try {
                await request('initialize', {
                    protocolVersion: 1,
                    clientCapabilities: { fs: { readTextFile: true }, terminal: true },
                    clientInfo: { name: 'telegram-terminal', version: '1' }
                });
                const billing = await request('_x.ai/billing', {});
                finish(billing);
            } catch {
                finish(null);
            }
        })();
    });
}

function formatBillingWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('en-GB', {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
}

function formatGrokBilling(billing) {
    const config = billing && billing.config;
    if (!config) return '\n\n*Weekly account* (`x.ai/billing`): unavailable';
    const period = config.currentPeriod || {};
    const start = config.billingPeriodStart || period.start;
    const end = config.billingPeriodEnd || period.end;
    const lines = ['*Weekly account* (`x.ai/billing`):'];
    if (billing.subscription_tier) lines.push(`• *Tier:* ${billing.subscription_tier}`);
    if (config.creditUsagePercent != null) {
        lines.push(`• *Used:* ${Math.round(Number(config.creditUsagePercent))}%`);
    }
    if (start && end) {
        lines.push(`• *Window:* ${formatBillingWhen(start)} → ${formatBillingWhen(end)} UTC`);
    }
    const onDemandUsed = Number(config.onDemandUsed && config.onDemandUsed.val) || 0;
    const onDemandCap = Number(config.onDemandCap && config.onDemandCap.val) || 0;
    const prepaid = Number(config.prepaidBalance && config.prepaidBalance.val) || 0;
    if (onDemandUsed || onDemandCap) lines.push(`• *On-demand:* ${onDemandUsed} / ${onDemandCap}`);
    if (prepaid) lines.push(`• *Prepaid:* ${prepaid}`);
    return '\n\n' + lines.join('\n');
}

// /usage and /quota commands
bot.command(['usage', 'quota'], async (ctx) => {
    const session = getSession(ctx);
    const typingInterval = setInterval(() => {
        ctx.sendChatAction('typing').catch(() => {});
    }, 4000);
    ctx.sendChatAction('typing').catch(() => {});

    try {
        if (session.engine === 'grok') {
            const sid = session.grokSessionId || getLatestGrokSession(session.workspace);
            const billingPromise = fetchGrokBilling(session.workspace);
            if (!sid) {
                const billingText = formatGrokBilling(await billingPromise);
                clearInterval(typingInterval);
                await ctx.reply(
                    `📊 *Grok Usage*\n\nNo recorded Grok session in \`${session.workspace}\` yet.${billingText}`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            const p = spawn(GROK_BIN, ['usage', sid], {
                cwd: session.workspace,
                env: { ...process.env, PATH: SYSTEM_PATH, LANG: 'en_GB.UTF-8' }
            });

            try { p.stdin.end(); } catch {}
            let stdout = '';
            p.stdout.on('data', d => { stdout += d.toString(); });
            p.on('close', async () => {
                clearInterval(typingInterval);
                const billingText = formatGrokBilling(await billingPromise);
                try {
                    const u = JSON.parse(stdout);
                    const s = u.session || {};
                    const cost = s.costUsdTicks ? (s.costUsdTicks / 10000000000).toFixed(4) : '0.0000';
                    const msg =
                        `📊 *Grok Usage & Session Statistics (${getTopicDisplayName(session)})*\n\n` +
                        `• *Session ID:* \`${u.sessionId}\`\n` +
                        `• *Primary Model:* \`${s.primaryModelId || 'grok'}\`\n` +
                        `• *Turns:* ${s.turnCount || 1} | *Model Calls:* ${s.modelCalls || 1}\n` +
                        `• *Session Cost:* $${cost} USD\n\n` +
                        `*Token Breakdown:*\n` +
                        `• Input: ${(s.inputTokens || 0).toLocaleString()}\n` +
                        `• Output: ${(s.outputTokens || 0).toLocaleString()}\n` +
                        `• Reasoning: ${(s.reasoningTokens || 0).toLocaleString()}\n` +
                        `• Cached Read: ${(s.cachedReadTokens || 0).toLocaleString()}\n` +
                        `• Total Tokens: ${(s.totalTokens || 0).toLocaleString()}` +
                        billingText;
                    await ctx.reply(msg, { parse_mode: 'Markdown' });
                } catch {
                    await ctx.reply(`📊 *Grok Usage*\n\`\`\`\n${stdout.trim()}\n\`\`\`${billingText}`, { parse_mode: 'Markdown' });
                }
            });
        } else {
            // Antigravity usage
            const p = spawn(AGY_BIN, ['-p', '/usage'], {
                cwd: session.workspace,
                env: { ...process.env, PATH: SYSTEM_PATH, LANG: 'en_GB.UTF-8' }
            });

            try { p.stdin.end(); } catch {}
            let stdout = '';
            let stderr = '';
            p.stdout.on('data', d => { stdout += d.toString(); });
            p.stderr.on('data', d => { stderr += d.toString(); });

            p.on('close', async () => {
                clearInterval(typingInterval);
                const output = (stdout || stderr || '*(No quota info available)*').trim();
                await ctx.reply(`📊 *Antigravity Model Quotas & Limits*\n\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
            });
        }
    } catch (err) {
        clearInterval(typingInterval);
        await ctx.reply(`❌ Failed to query usage: ${err.message}`);
    }
});

// /skills command
bot.command('skills', async (ctx) => {
    const session = getSession(ctx);
    const typingInterval = setInterval(() => {
        ctx.sendChatAction('typing').catch(() => {});
    }, 4000);
    ctx.sendChatAction('typing').catch(() => {});

    try {
        if (session.engine === 'grok') {
            const p = spawn(GROK_BIN, ['plugin', 'list'], {
                cwd: session.workspace,
                env: { ...process.env, PATH: SYSTEM_PATH, LANG: 'en_GB.UTF-8' }
            });
            try { p.stdin.end(); } catch {}
            let stdout = '';
            p.stdout.on('data', d => { stdout += d.toString(); });
            p.on('close', async () => {
                clearInterval(typingInterval);
                await ctx.reply(`🧠 *Grok Plugins & Extensions*\n\n\`\`\`\n${stdout.trim()}\n\`\`\``, { parse_mode: 'Markdown' });
            });
        } else {
            const p = spawn(AGY_BIN, ['-p', '/skills'], {
                cwd: session.workspace,
                env: { ...process.env, PATH: SYSTEM_PATH, LANG: 'en_GB.UTF-8' }
            });
            try { p.stdin.end(); } catch {}
            let stdout = '';
            p.stdout.on('data', d => { stdout += d.toString(); });
            p.on('close', async () => {
                clearInterval(typingInterval);
                await ctx.reply(`🧠 *Available Agent Skills*\n\n\`\`\`\n${stdout.trim()}\n\`\`\``, { parse_mode: 'Markdown' });
            });
        }
    } catch (err) {
        clearInterval(typingInterval);
        await ctx.reply(`❌ Failed to query skills: ${err.message}`);
    }
});

// /agents command (Antigravity subagents)
bot.command('agents', async (ctx) => {
    const session = getSession(ctx);
    const typingInterval = setInterval(() => {
        ctx.sendChatAction('typing').catch(() => {});
    }, 4000);
    ctx.sendChatAction('typing').catch(() => {});

    try {
        const p = spawn(AGY_BIN, ['-p', '/agents'], {
            cwd: session.workspace,
            env: { ...process.env, PATH: SYSTEM_PATH, LANG: 'en_GB.UTF-8' }
        });
        try { p.stdin.end(); } catch {}
        let stdout = '';
        p.stdout.on('data', d => { stdout += d.toString(); });
        p.on('close', async () => {
            clearInterval(typingInterval);
            const out = stdout.trim() || 'No custom agents defined.';
            await ctx.reply(`👥 *Available Agents*\n\n\`\`\`\n${out}\n\`\`\``, { parse_mode: 'Markdown' });
        });
    } catch (err) {
        clearInterval(typingInterval);
        await ctx.reply(`❌ Failed to query agents: ${err.message}`);
    }
});

// /credits command
bot.command('credits', async (ctx) => {
    const session = getSession(ctx);
    try {
        const p = spawn(AGY_BIN, ['-p', '/credits'], {
            cwd: session.workspace,
            env: { ...process.env, PATH: SYSTEM_PATH, LANG: 'en_GB.UTF-8' }
        });
        try { p.stdin.end(); } catch {}
        let stdout = '';
        p.stdout.on('data', d => { stdout += d.toString(); });
        p.on('close', async () => {
            await ctx.reply(`💳 *Account Credits*\n\n\`\`\`\n${stdout.trim()}\n\`\`\``, { parse_mode: 'Markdown' });
        });
    } catch (err) {
        await ctx.reply(`❌ Error: ${err.message}`);
    }
});

// /new command: start fresh session for the CURRENT topic
bot.command('new', async (ctx) => {
    const session = getSession(ctx);
    const archived = archiveTopicMemory(MEMORY_DIR, session.id);
    session.isNew = true;
    session.pendingHandoff = false;
    session.agyConversationId = null;
    session.grokSessionId = null;
    session.turnCount = 0;
    saveSessions();

    const archiveNote = archived
        ? 'The previous topic memory was archived.'
        : 'No topic memory was on file.';
    await ctx.reply(
        `🆕 *Conversation reset for ${getTopicDisplayName(session)}.*\n` +
        `${archiveNote}\n` +
        `Your next prompt in this topic will start a fresh session with *${getEngineLabel(session)}*.`,
        { parse_mode: 'Markdown' }
    );
});

// /plan command
bot.command('plan', async (ctx) => {
    const session = getSession(ctx);
    const task = ctx.message.text.replace('/plan', '').trim();
    if (!task) {
        await ctx.reply('Usage: `/plan <task description>`', { parse_mode: 'Markdown' });
        return;
    }

    if (session.activeProcess) {
        await ctx.reply('⚠️ Agent is currently busy in this topic. Use `/stop` to abort if needed.');
        return;
    }

    const isNew = session.isNew;
    session.isNew = false;

    await runAgentStreamTurn(ctx, task, {
        session,
        model: getCurrentModel(session),
        effort: getCurrentEffort(session),
        mode: 'plan',
        isNew
    });
});

// /workspace or /cd command
bot.command(['workspace', 'cd'], async (ctx) => {
    const session = getSession(ctx);
    const target = ctx.message.text.replace(/^\/(workspace|cd)/, '').trim();
    if (!target) {
        await ctx.reply(`📁 Current workspace for ${getTopicDisplayName(session)}: \`${session.workspace}\`\n\nTo change: \`/workspace <path>\``, { parse_mode: 'Markdown' });
        return;
    }

    const resolved = path.resolve(session.workspace, target);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        await ctx.reply(`❌ Directory does not exist: \`${resolved}\``, { parse_mode: 'Markdown' });
        return;
    }

    session.workspace = resolved;
    saveSessions();
    await ctx.reply(`✅ Workspace for ${getTopicDisplayName(session)} updated to:\n\`${session.workspace}\``, { parse_mode: 'Markdown' });
});

bot.command('pwd', async (ctx) => {
    const session = getSession(ctx);
    await ctx.reply(`📁 Workspace (${getTopicDisplayName(session)}): \`${session.workspace}\``, { parse_mode: 'Markdown' });
});

// /status command
bot.command('status', async (ctx) => {
    const session = getSession(ctx);
    const isTopicBusy = session.activeProcess !== null;
    const runningSessions = Object.values(sessions).filter(s => s.activeProcess !== null);

    const cpus = os.cpus().length;
    const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    const load = os.loadavg().map(l => l.toFixed(2)).join(', ');

    let activeSummary = '';
    if (runningSessions.length > 0) {
        activeSummary = `\n⚙️ *Running Tasks (${runningSessions.length}):*\n` +
            runningSessions.map(s => `• ${getTopicDisplayName(s)} (${getEngineLabel(s)})`).join('\n') + '\n';
    }

    await ctx.reply(
        `📊 *AI Terminal Suite Status*\n\n` +
        `📌 *Current Topic:* *${getTopicDisplayName(session)}*\n` +
        `• Topic State: ${isTopicBusy ? '⚙️ *Running turn...*' : '💤 *Idle (Ready)*'}\n` +
        `• Engine: *${getEngineLabel(session)}*\n` +
        `• Workspace: \`${session.workspace}\`\n` +
        `• Model: \`${getCurrentModel(session)}\`\n` +
        `• Effort: \`${getCurrentEffort(session) || 'Default'}\`\n` +
        `• Total Turns in Topic: ${session.turnCount || 0}\n` +
        activeSummary +
        `\n*Host Metrics:*\n` +
        `• CPU Cores: ${cpus} (Load: ${load})\n` +
        `• RAM: ${freeMemMb} MB free / ${totalMemMb} MB total`,
        { parse_mode: 'Markdown' }
    );
});

// /stop command
bot.command(['stop', 'kill', 'cancel'], async (ctx) => {
    const text = (ctx.message?.text || '').trim();

    if (text.includes('all')) {
        let stoppedCount = 0;
        for (const sess of Object.values(sessions)) {
            if (sess.activeProcess) {
                try {
                    sess.activeProcess.kill('SIGINT');
                    stoppedCount++;
                } catch {}
                sess.activeProcess = null;
            }
        }
        await ctx.reply(`🛑 Stopped ${stoppedCount} running agent turn(s) across all topics.`);
        return;
    }

    const session = getSession(ctx);
    if (!session.activeProcess) {
        await ctx.reply('ℹ️ No active agent turn is currently running in this topic.\nUse `/stop all` to abort across all topics.');
        return;
    }

    try {
        session.activeProcess.kill('SIGINT');
        session.activeProcess = null;
        await ctx.reply(`🛑 Sent interrupt signal (SIGINT) to the agent in ${getTopicDisplayName(session)}.`);
    } catch (err) {
        await ctx.reply(`⚠️ Failed to stop process: ${err.message}`);
    }
});

// /get command (download file from workspace)
bot.command(['get', 'download'], async (ctx) => {
    const session = getSession(ctx);
    const target = ctx.message.text.replace(/^\/(get|download)/, '').trim();
    if (!target) {
        await ctx.reply('Usage: `/get <path/to/file>`', { parse_mode: 'Markdown' });
        return;
    }

    const resolved = path.resolve(session.workspace, target);
    if (!fs.existsSync(resolved)) {
        await ctx.reply(`❌ File not found: \`${resolved}\``, { parse_mode: 'Markdown' });
        return;
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
        await ctx.reply(`❌ \`${resolved}\` is a directory. Specify a file.`, { parse_mode: 'Markdown' });
        return;
    }

    if (stat.size > 50 * 1024 * 1024) {
        await ctx.reply(`❌ File exceeds 50MB Telegram limit. Size: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
        return;
    }

    await ctx.replyWithDocument({ source: resolved, filename: path.basename(resolved) });
});

// /sh command: quick shell escape
bot.command('sh', async (ctx) => {
    const session = getSession(ctx);
    const cmd = ctx.message.text.replace(/^\/sh\s*/, '').trim();
    if (!cmd) {
        await ctx.reply('Usage: `/sh <bash command>`', { parse_mode: 'Markdown' });
        return;
    }

    let stdout = '';
    let stderr = '';

    const p = spawn('/bin/bash', ['-c', cmd], {
        cwd: session.workspace,
        env: { ...process.env, PATH: SYSTEM_PATH, LANG: 'en_GB.UTF-8' }
    });

    try { p.stdin.end(); } catch {}

    p.stdout.on('data', d => { stdout += d.toString(); });
    p.stderr.on('data', d => { stderr += d.toString(); });

    p.on('close', async (code) => {
        const out = (stdout || stderr || '*(No output)*').trim();
        const prefix = code === 0 ? '✅' : `❌ (Exit: ${code})`;
        await ctx.reply(`${prefix}\n\`\`\`\n${out}\n\`\`\``, { parse_mode: 'Markdown' });
    });
});

// /start command
bot.command('start', async (ctx) => {
    const session = getSession(ctx);
    await ctx.reply(
        `🤖 *AI Terminal Suite*\n\n` +
        `Interactive remote control for *Google Antigravity* (Gemini) and *xAI Grok*.\n` +
        `Supports independent multi-session topics/threads!\n\n` +
        `📌 *Current Topic:* *${getTopicDisplayName(session)}*\n` +
        `⚙️ *Active Engine:* *${getEngineLabel(session)}*\n` +
        `📁 *Workspace:* \`${session.workspace}\`\n` +
        `🧠 *Model:* \`${getCurrentModel(session)}\`\n` +
        `⚡ *Effort:* \`${getCurrentEffort(session) || 'Default'}\`\n\n` +
        `*Features:*\n` +
        `• Send any text to prompt the active agent in this topic\n` +
        `• Live tool execution updates & streaming text!\n` +
        `• Dedicated session history per topic\n` +
        `• \`/engine\` — Switch engine. Each engine keeps its own session; a new engine gets the topic memory\n` +
        `• \`/model\` — Switch model via inline buttons\n` +
        `• \`/sessions\` — View all active topics & sessions\n` +
        `• \`/name <title>\` — Set nickname for this topic\n` +
        `• \`/usage\` — Session stats, plus the weekly account window on Grok\n` +
        `• \`/effort\` — Switch reasoning effort\n` +
        `• \`/new\` — Archive topic memory and start a fresh session\n` +
        `• \`/plan <task>\` — Generate implementation plan\n` +
        `• \`/skills\` — View available agent skills\n` +
        `• \`/workspace <path>\` — Switch directory for this topic\n` +
        `• \`/get <file>\` — Download files to phone\n` +
        `• \`/sh <cmd>\` — Run bash command on server\n` +
        `• \`/stop\` — Cancel running execution in this topic (\`/stop all\` for all)\n` +
        `• \`/status\` — View system & topic metrics`,
        { parse_mode: 'Markdown' }
    );
});

// /help command
bot.command('help', async (ctx) => {
    await ctx.reply(
        `📖 *Command Reference*\n\n` +
        `*(Any text)* — Send prompt with real-time updates\n` +
        `\`/sessions\` or \`/topics\` — View all active topics and sessions\n` +
        `\`/name <title>\` — View or set nickname for current topic\n` +
        `\`/engine\` — Switch engine. An engine with no session here receives the topic memory\n` +
        `\`/model\` — Select active AI model for this topic\n` +
        `\`/usage\` or \`/quota\` — Session tokens, plus the weekly account window on Grok\n` +
        `\`/effort\` — Select reasoning effort tier\n` +
        `\`/new\` — Archive topic memory and start fresh in this topic\n` +
        `\`/plan <task>\` — Run in plan-only mode\n` +
        `\`/skills\` — View available skills\n` +
        `\`/workspace <path>\` — Switch workspace folder for this topic\n` +
        `\`/pwd\` — View current workspace\n` +
        `\`/get <file>\` — Download file to Telegram\n` +
        `\`/sh <command>\` — Execute a host bash command\n` +
        `\`/stop\` — Cancel running execution (\`/stop all\` to cancel all)\n` +
        `\`/status\` — Show server load & agent status`,
        { parse_mode: 'Markdown' }
    );
});

// Document / Image upload with optional prompt caption
bot.on(['document', 'photo'], async (ctx) => {
    const session = getSession(ctx);
    try {
        let fileId = null;
        let fileName = `upload-${Date.now()}`;

        if (ctx.message.document) {
            fileId = ctx.message.document.file_id;
            fileName = ctx.message.document.file_name || fileName;
        } else if (ctx.message.photo) {
            const photos = ctx.message.photo;
            fileId = photos[photos.length - 1].file_id;
            fileName = `photo-${Date.now()}.jpg`;
        }

        const fileLink = await ctx.telegram.getFileLink(fileId);
        const destination = path.join(session.workspace, fileName);

        const response = await fetch(fileLink.href);
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(destination, Buffer.from(buffer));

        const caption = ctx.message.caption?.trim();
        if (caption) {
            await ctx.reply(`📥 Saved \`${fileName}\`. Prompting ${getEngineLabel(session)} with caption...`, { parse_mode: 'Markdown' });
            const prompt = `I uploaded a file to the workspace at ${fileName}. ${caption}`;
            const isNew = session.isNew;
            session.isNew = false;

            await runAgentStreamTurn(ctx, prompt, {
                session,
                model: getCurrentModel(session),
                effort: getCurrentEffort(session),
                isNew
            });
        } else {
            await ctx.reply(`📥 Uploaded and saved to workspace:\n\`${destination}\``, { parse_mode: 'Markdown' });
        }
    } catch (err) {
        await ctx.reply(`❌ File upload failed: ${err.message}`);
    }
});

// Main text handler: Live interactive streaming agent turn!
bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    const session = getSession(ctx);

    // If it is an unhandled slash command
    if (text.startsWith('/')) {
        const typingInterval = setInterval(() => {
            ctx.sendChatAction('typing').catch(() => {});
        }, 4000);
        ctx.sendChatAction('typing').catch(() => {});

        try {
            const bin = session.engine === 'grok' ? GROK_BIN : AGY_BIN;
            const p = spawn(bin, ['-p', text], {
                cwd: session.workspace,
                env: { ...process.env, PATH: SYSTEM_PATH, LANG: 'en_GB.UTF-8' }
            });
            try { p.stdin.end(); } catch {}
            let stdout = '';
            let stderr = '';
            p.stdout.on('data', d => { stdout += d.toString(); });
            p.stderr.on('data', d => { stderr += d.toString(); });
            p.on('close', async (code) => {
                clearInterval(typingInterval);
                const out = (stdout || stderr || '*(No output)*').trim();
                await ctx.reply(`\`\`\`\n${out}\n\`\`\``, { parse_mode: 'Markdown' });
            });
        } catch (err) {
            clearInterval(typingInterval);
            await ctx.reply(`❌ Command error: ${err.message}`);
        }
        return;
    }

    if (session.activeProcess) {
        await ctx.reply(`⚠️ Agent is currently busy in ${getTopicDisplayName(session)}. Use \`/stop\` to abort the active turn.`);
        return;
    }

    const isNew = session.isNew;
    session.isNew = false;

    await runAgentStreamTurn(ctx, text, {
        session,
        model: getCurrentModel(session),
        effort: getCurrentEffort(session),
        isNew
    });
});

async function startBot() {
    loadSessions();

    console.log(`AI Terminal Suite starting with Dual-Engine (Antigravity & Grok) and Multi-Topic support.`);

    // Register Telegram Menu buttons for auto-complete on mobile
    try {
        await bot.telegram.setMyCommands([
            { command: 'engine', description: 'Switch engine (Antigravity / Grok)' },
            { command: 'model', description: 'Switch AI model' },
            { command: 'sessions', description: 'List active topic sessions' },
            { command: 'name', description: 'Name or rename current topic' },
            { command: 'usage', description: 'Session stats and weekly account usage' },
            { command: 'effort', description: 'Change reasoning effort tier' },
            { command: 'new', description: 'Start a fresh conversation in this topic' },
            { command: 'plan', description: 'Generate implementation plan' },
            { command: 'skills', description: 'View available agent skills' },
            { command: 'workspace', description: 'View or switch workspace directory' },
            { command: 'status', description: 'View server load & agent status' },
            { command: 'get', description: 'Download file from workspace' },
            { command: 'sh', description: 'Execute bash command on server' },
            { command: 'stop', description: 'Abort active agent task' },
            { command: 'help', description: 'Show all commands' }
        ]);
        console.log(`[Telegram] Registered bot commands menu`);
    } catch (e) {
        console.error(`[Telegram] Failed to register menu commands:`, e);
    }

    try {
        await bot.launch();
        console.log(`AI Terminal Suite is listening for Telegram updates across all topics.`);
    } catch (err) {
        console.error('Bot launch failed:', err);
    }
}

startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
