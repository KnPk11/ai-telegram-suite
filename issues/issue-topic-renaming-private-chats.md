# Issue: Automatic & Manual Forum Topic Renaming in Telegram Private Chats

## Status
- **Status:** Open / Blocked by Upstream Telegram Client Behaviour
- **Component:** `titles.js`, `bot.js`, `test/titles.test.js`
- **Target Repo:** `KnPk11/ai-telegram-suite`

---

## 1. Problem Description

The AI Terminal Suite is deployed in a direct 1-to-1 private chat with forum topic mode enabled (`has_topics_enabled: true`, `allows_users_to_create_topics: true`).

The intended behaviour is:
1. When a user creates a new topic in Telegram and sends an initial prompt, the topic should automatically be renamed to a concise subject title (read from the AI engine session store, such as Antigravity, Grok, or OpenCode, or derived from the prompt).
2. Users should be able to run `/name <new name>` or `/topic <new name>` to manually rename the topic thread in Telegram.

### Symptoms Observed
- Running `/name <new topic name>` in Telegram records the new name locally in `sessions.json`, and the bot replies with success, but the thread name in Telegram clients (Desktop, Android, iOS) remains unchanged.
- Automatic renaming fails to visually update thread names in Telegram client applications.
- Topics started with slash commands (such as `/engine`, `/model`, or `/new <prompt>`) frequently remained titled with the command name (e.g. `/engine`).

---

## 2. Root Cause Analysis & Technical Findings

### A. Upstream Telegram Client Caching Bug (Private Chat Topics)
- **Bot API Server Response:** When calling Telegram Bot API `editForumTopic` with `chat_id: <user_id>` and `message_thread_id: <thread_id>`, Telegram servers process the request and respond with `HTTP 200 {"ok": true, "result": true}`. The database on Telegram servers actually records the updated topic name.
- **Client Sync Failure:** In standard supergroups, editing a forum topic generates an internal `messageActionTopicEdit` (`forum_topic_edited`) service notification across the update stream. In private chats with forum mode enabled (Bot API 9.x), Telegram servers **do not push this service message to active client sessions**.
- **Result:** Existing Telegram client sessions (Desktop, mobile) never receive a cache invalidation signal for thread headers in direct chats. They continue displaying the initial topic name from their local SQLite cache.
- **Workaround Verification:** Newly initialised sessions (e.g. freshly authenticated Telegram Web K sessions or after fully terminating and wiping client cache) fetch the updated topic name directly from the server, confirming the issue is strictly client-side update propagation.

### B. `TOPIC_ID_INVALID` on Deleted Threads
- If a user deletes a topic or if a message thread ID was transient, Telegram Bot API returns `400 Bad Request: TOPIC_ID_INVALID`. In the original wrapper, this error was swallowed, causing `/name` to report success even when Telegram rejected the call.

### C. Slash Commands Dropping Prompts (`/new`)
- In `bot.js`, `/new` was strictly handled as an administrative command resetting topic memory and turn counts. If a user opened a thread with `/new Hi can you help me...`, the prompt was ignored, no turn was launched, and auto-renaming never triggered.

### D. Manual Override Lock (`customTopicName`)
- Running `/name` sets `session.customTopicName = true` and `session.topicTitleSource = "custom"`. Once set, `maybeAutoRenameTopic` intentionally suppresses future automatic AI renames to prevent overwriting user-chosen names.

---

## 3. Attempted Solution Details

The following improvements were developed and tested across `titles.js`, `bot.js`, and `test/titles.test.js`:

1. **OpenCode Session Title Extraction (`titles.js`):**
   - Added `readOpenCodeSessionTitle` reading titles from `~/.local/share/opencode/opencode.db` via SQLite read-only query.
   - Updated `resolveSessionTitle` to prioritise OpenCode titles when `engine === "opencode"`.
2. **Generic & Placeholder Title Detection (`titles.js`):**
   - Recognised OpenCode date placeholders (`New session - YYYY-MM-DD...`), bare greetings (`Yooo`, `Hi`), and command names (`/engine`, `/model`).
   - Extended greeting prefix regex to handle repeated letters (e.g., `Yooo,`).
3. **Bot Ownership Guard (`titles.js` / `bot.js`):**
   - Introduced `isBotOwnedTopicName` to ensure the bot only auto-renames titles it generated or that are generic placeholders, preventing overwriting manual renames.
4. **Command Topic Placeholder Renaming (`bot.js`):**
   - Added `maybeReplaceCommandTopicName` to rename `/engine`, `/model`, or `/new` topic names to `New <Engine> chat`.
5. **Handling Manual Telegram Renames (`bot.js`):**
   - Added `bot.on("forum_topic_edited")` listener to detect manual renames in Telegram and preserve user choices.
6. **`/name` Command Robustness (`bot.js`):**
   - Stripped bot usernames (`/name@botname`) and angle brackets (`<new name>`).
   - Verified the response from `renameForumTopicOnTelegram` and alerted the user if Telegram rejected the thread ID.
7. **`/new <prompt>` Turn Execution (`bot.js`):**
   - Allowed `/new <prompt>` to reset the conversation and immediately launch the agent turn with the prompt.

All 39 unit tests in `test/*.test.js` passed with these changes.

---

## 4. Full Untracked Patch

The full diff of the attempted changes is appended below.

```diff
diff --git a/bot.js b/bot.js
index 0225b1e..bc4b811 100644
--- a/bot.js
+++ b/bot.js
@@ -29,6 +29,7 @@ const {
     isPromptEchoTitle,
     readFirstPromptFromMemory,
     resolveSessionTitle,
+    isBotOwnedTopicName,
     renameForumTopicOnTelegram
 } = require('./titles');
 require('dotenv').config();
@@ -141,6 +142,8 @@ function saveSessions() {
                 pendingHandoff: Boolean(sess.pendingHandoff),
                 customTopicName: Boolean(sess.customTopicName),
                 autoTitled: Boolean(sess.autoTitled),
+                topicTitleSource: sess.topicTitleSource || null,
+                lastBotTopicName: sess.lastBotTopicName || null,
                 turnCount: sess.turnCount || 0,
                 createdAt: sess.createdAt,
                 lastActive: sess.lastActive
@@ -298,6 +301,8 @@ function getSession(ctx) {
             pendingHandoff: false,
             customTopicName: false,
             autoTitled: false,
+            topicTitleSource: 'telegram',
+            lastBotTopicName: null,
             activeProcess: null,
             turnCount: 0,
             createdAt: Date.now(),
@@ -320,17 +325,20 @@ function getSession(ctx) {
 async function maybeAutoRenameTopic(session, prompt = '') {
     if (!session || !session.threadId || session.customTopicName) return false;
     const effectivePrompt = prompt || readFirstPromptFromMemory(session.id, { memoryDir: MEMORY_DIR });
+    if (!isBotOwnedTopicName(session, effectivePrompt)) return false;
+
     const currentIsGenericOrEcho =
         isGenericTopicTitle(session.topicName) ||
         isPromptEchoTitle(session.topicName, effectivePrompt);
-    const needsTitle = !session.autoTitled || currentIsGenericOrEcho;
-    if (!needsTitle) return false;
+    if (session.autoTitled && !currentIsGenericOrEcho) return false;
 
     const { title, source } = await resolveSessionTitle(session, effectivePrompt, { memoryDir: MEMORY_DIR });
     if (!title) return false;
     if (title === session.topicName) {
         if (source === 'ai' && !session.autoTitled) {
             session.autoTitled = true;
+            session.topicTitleSource = 'ai';
+            session.lastBotTopicName = title;
             saveSessions();
         }
         return source === 'ai';
@@ -345,6 +353,8 @@ async function maybeAutoRenameTopic(session, prompt = '') {
         const renamed = await renameForumTopicOnTelegram(bot.telegram, session.chatId, session.threadId, title);
         if (!renamed) return false;
         session.topicName = title;
+        session.lastBotTopicName = title;
+        session.topicTitleSource = source;
         if (source === 'ai') {
             session.autoTitled = true;
         }
@@ -390,6 +400,35 @@ function getEngineShortLabel(session) {
     return 'Antigravity';
 }
 
+async function maybeReplaceCommandTopicName(session) {
+    if (!session || !session.threadId || session.customTopicName || (session.turnCount || 0) > 0) {
+        return false;
+    }
+    const currentName = String(session.topicName || '').trim();
+    const isCommandOrPlaceholder = currentName.startsWith('/') || /^New (?:Antigravity|Grok|OpenCode) chat$/i.test(currentName);
+    if (!isCommandOrPlaceholder) {
+        return false;
+    }
+    const placeholder = `New ${getEngineShortLabel(session)} chat`;
+    if (currentName === placeholder) {
+        return false;
+    }
+
+    try {
+        const renamed = await renameForumTopicOnTelegram(bot.telegram, session.chatId, session.threadId, placeholder);
+        if (!renamed) return false;
+        session.topicName = placeholder;
+        session.lastBotTopicName = placeholder;
+        session.topicTitleSource = 'fallback';
+        saveSessions();
+        console.log(`[Topics] Replaced command topic name ${session.id} -> "${placeholder}"`);
+        return true;
+    } catch (err) {
+        console.error(`[Topics] Failed to replace command topic name for ${session.id}:`, err.message);
+        return false;
+    }
+}
+
 function binForEngine(engine) {
     if (engine === 'grok') return GROK_BIN;
     if (engine === 'opencode') return OPENCODE_BIN;
@@ -842,6 +881,14 @@ async function runAgentStreamTurn(ctx, prompt, options = {}) {
                 })
                 .catch(() => {});
 
+            if (session.engine === 'opencode') {
+                setTimeout(() => {
+                    if (!session.customTopicName && !session.autoTitled) {
+                        maybeAutoRenameTopic(session, prompt).catch(() => {});
+                    }
+                }, 10000);
+            }
+
             await flushUpdate(true);
 
             const fullText = finalResultText || accumulatedText;
@@ -961,6 +1008,26 @@ bot.on('forum_topic_created', async (ctx) => {
     }
 });
 
+bot.on('forum_topic_edited', async (ctx) => {
+    const rawName = ctx.message?.forum_topic_edited?.name;
+    if (!rawName) return;
+
+    const newName = sanitizeTopicTitle(rawName);
+    if (!newName) return;
+
+    const session = getSession(ctx);
+    if (session.lastBotTopicName && newName === sanitizeTopicTitle(session.lastBotTopicName)) {
+        return;
+    }
+
+    session.topicName = newName;
+    session.customTopicName = true;
+    session.autoTitled = true;
+    session.topicTitleSource = 'custom';
+    saveSessions();
+    console.log(`[Topics] Topic ${session.id} renamed manually in Telegram -> "${newName}"; auto-naming disabled`);
+});
+
 // ---------------------------------------------------------------------
 // Commands: Topic & Session Management
 // ---------------------------------------------------------------------
@@ -991,7 +1058,9 @@ bot.command(['sessions', 'topics'], async (ctx) => {
 // /name or /topic: set or view the name of the current topic
 bot.command(['name', 'topic'], async (ctx) => {
     const session = getSession(ctx);
-    const newName = sanitizeTopicTitle(ctx.message.text.replace(/^\/(name|topic)/, '').trim());
+    const rawInput = ctx.message.text.replace(/^\/(?:name|topic)(?:@\w+)?/i, '').trim();
+    const unbracketed = rawInput.replace(/^<(.+)>$/, '$1').trim();
+    const newName = sanitizeTopicTitle(unbracketed);
 
     if (!newName) {
         await ctx.reply(
@@ -1006,19 +1075,35 @@ bot.command(['name', 'topic'], async (ctx) => {
     }
 
     session.topicName = newName;
+    session.lastBotTopicName = newName;
     session.customTopicName = true;
     session.autoTitled = true;
+    session.topicTitleSource = 'custom';
     saveSessions();
 
+    let renamedOnTelegram = false;
     if (session.threadId) {
         try {
-            await renameForumTopicOnTelegram(ctx.telegram, session.chatId, session.threadId, newName);
+            renamedOnTelegram = await renameForumTopicOnTelegram(ctx.telegram, session.chatId, session.threadId, newName);
         } catch (err) {
             console.error(`[Topics] Failed to rename forum topic ${session.id} on Telegram:`, err.message);
         }
     }
 
-    await ctx.reply(`✅ Topic name updated to: *${newName}*`, { parse_mode: 'Markdown' });
+    if (!session.threadId) {
+        await ctx.reply(`✅ Topic name updated to: *${newName}* (Main chat has no Telegram topic to rename)`, { parse_mode: 'Markdown' });
+    } else if (renamedOnTelegram) {
+        await ctx.reply(
+            `✅ Topic name updated to: *${newName}*\n\n` +
+            `_Note: Telegram clients heavily cache private-chat topic headers locally. If your app still shows the previous title in the list, restart Telegram to refresh the view._`,
+            { parse_mode: 'Markdown' }
+        );
+    } else {
+        await ctx.reply(
+            `⚠️ Topic name saved locally as: *${newName}*, but Telegram could not update the thread (thread ID \`${session.threadId}\` was not recognised as an active forum topic by Telegram).`,
+            { parse_mode: 'Markdown' }
+        );
+    }
 });
 
 // /engine command: toggle engine for the current topic
@@ -1056,6 +1141,7 @@ bot.command('engine', async (ctx) => {
             ...Markup.inlineKeyboard(buttons)
         }
     );
+    maybeReplaceCommandTopicName(session).catch(() => {});
 });
 
 bot.action(/^set_engine:(agy|grok|opencode)$/, async (ctx) => {
@@ -1079,6 +1165,7 @@ bot.action(/^set_engine:(agy|grok|opencode)$/, async (ctx) => {
         `• ${continuity}`,
         { parse_mode: 'Markdown' }
     );
+    maybeReplaceCommandTopicName(session).catch(() => {});
 });
 
 // Telegram callback data is limited to 64 bytes. Long model ids get a stable
@@ -1148,6 +1235,7 @@ bot.command('model', async (ctx) => {
     ctx.sendChatAction('typing').catch(() => {});
     const { text, extra } = await buildModelMenu(session);
     await ctx.reply(text, extra);
+    maybeReplaceCommandTopicName(session).catch(() => {});
 });
 
 bot.action(/^model_page:(\d+)$/, async (ctx) => {
@@ -1201,6 +1289,7 @@ bot.action(/^set_model:(.+)$/, async (ctx) => {
         `✅ *Model updated for ${getTopicDisplayName(session)}:* \`${selected}\` (${getEngineLabel(session)})`,
         { parse_mode: 'Markdown' }
     );
+    maybeReplaceCommandTopicName(session).catch(() => {});
 });
 
 // /effort command: inline buttons tailored to active engine for the topic
@@ -1565,11 +1654,14 @@ bot.command('credits', async (ctx) => {
 // /new command: start fresh session for the CURRENT topic
 bot.command('new', async (ctx) => {
     const session = getSession(ctx);
+    const rawPrompt = ctx.message.text.replace(/^\/new(?:@\w+)?/i, '').trim();
     const archived = archiveTopicMemory(MEMORY_DIR, session.id);
     session.isNew = true;
     session.pendingHandoff = false;
     session.customTopicName = false;
     session.autoTitled = false;
+    session.topicTitleSource = 'telegram';
+    session.lastBotTopicName = null;
     session.agyConversationId = null;
     session.grokSessionId = null;
     session.opencodeSessionId = null;
@@ -1579,12 +1671,24 @@ bot.command('new', async (ctx) => {
     const archiveNote = archived
         ? 'The previous topic memory was archived.'
         : 'No topic memory was on file.';
-    await ctx.reply(
-        `🆕 *Conversation reset for ${getTopicDisplayName(session)}.*\n` +
-        `${archiveNote}\n` +
-        `Your next prompt in this topic will start a fresh session with *${getEngineLabel(session)}*.`,
-        { parse_mode: 'Markdown' }
-    );
+
+    if (rawPrompt) {
+        await ctx.reply(
+            `🆕 *Conversation reset for ${getTopicDisplayName(session)}.*\n` +
+            `${archiveNote}\n` +
+            `Starting new session with *${getEngineLabel(session)}*...`,
+            { parse_mode: 'Markdown' }
+        );
+        startAgentTurn(ctx, session, rawPrompt);
+    } else {
+        await ctx.reply(
+            `🆕 *Conversation reset for ${getTopicDisplayName(session)}.*\n` +
+            `${archiveNote}\n` +
+            `Your next prompt in this topic will start a fresh session with *${getEngineLabel(session)}*.`,
+            { parse_mode: 'Markdown' }
+        );
+        maybeReplaceCommandTopicName(session).catch(() => {});
+    }
 });
 
 // /plan command
@@ -1893,10 +1997,11 @@ bot.on('text', async (ctx) => {
 
 async function backfillGenericTopicTitles() {
     for (const sess of Object.values(sessions)) {
-        if (!sess.threadId || sess.customTopicName) continue;
+        if (!sess.threadId || sess.customTopicName || sess.autoTitled === true) continue;
         const firstPrompt = readFirstPromptFromMemory(sess.id, { memoryDir: MEMORY_DIR });
-        if (!isGenericTopicTitle(sess.topicName) && !isPromptEchoTitle(sess.topicName, firstPrompt)) continue;
-        if (!sess.agyConversationId && !sess.grokSessionId && !sess.opencodeSessionId && !firstPrompt) continue;
+        const hasSessionOrPrompt = Boolean(sess.agyConversationId || sess.grokSessionId || sess.opencodeSessionId || firstPrompt);
+        if (!hasSessionOrPrompt) continue;
+        if (!isBotOwnedTopicName(sess, firstPrompt)) continue;
         try {
             await maybeAutoRenameTopic(sess, firstPrompt);
         } catch {}
diff --git a/test/titles.test.js b/test/titles.test.js
index 3fa64c1..6718751 100644
--- a/test/titles.test.js
+++ b/test/titles.test.js
@@ -141,3 +141,123 @@ test('renameForumTopicOnTelegram converts numeric chatId and treats TOPIC_NOT_MO
         true
     );
 });
+
+test('resolveSessionTitle handles OpenCode engine and placeholder titles', async () => {
+    const session = {
+        engine: 'opencode',
+        opencodeSessionId: 'ses_123'
+    };
+
+    const resAi = await titles.resolveSessionTitle(session, 'What is OpenCode?', {
+        readOpenCodeTitle: async () => 'LLM Origin Inquiry'
+    });
+    assert.deepEqual(resAi, {
+        title: 'LLM Origin Inquiry',
+        source: 'ai'
+    });
+
+    const resPlaceholder = await titles.resolveSessionTitle(session, 'What is OpenCode?', {
+        readOpenCodeTitle: async () => 'New session - 2026-11-03T13:50:48.378Z'
+    });
+    assert.equal(resPlaceholder.source, 'fallback');
+    assert.equal(resPlaceholder.title, 'OpenCode');
+});
+
+test('isGenericTopicTitle recognises OpenCode placeholders, command topics, and casual greetings', () => {
+    assert.equal(titles.isGenericTopicTitle('New session - 2026-11-03T13:50:48.378Z'), true);
+    assert.equal(titles.isGenericTopicTitle('New OpenCode chat'), true);
+    assert.equal(titles.isGenericTopicTitle('Greeting'), true);
+    assert.equal(titles.isGenericTopicTitle('Casual greeting'), true);
+    assert.equal(titles.isGenericTopicTitle('Yooo'), true);
+    assert.equal(titles.isGenericTopicTitle('/engine'), true);
+
+    assert.equal(titles.isGenericTopicTitle('LLM Origin Inquiry'), false);
+});
+
+test('deriveFallbackTitle strips conversational filler including stretched greetings', () => {
+    const candidate = titles.deriveFallbackTitle('Yooo, could you tell me what LLM are you?');
+    assert.ok(!candidate.startsWith('Yo'), `Expected title not to start with 'Yo', got "${candidate}"`);
+    assert.ok(!candidate.startsWith('Could'), `Expected title not to start with 'Could', got "${candidate}"`);
+});
+
+test('readOpenCodeSessionTitle reads title from SQLite database and handles missing values', async () => {
+    const fs = require('node:fs');
+    const os = require('node:os');
+    const path = require('node:path');
+    const { execFileSync } = require('node:child_process');
+
+    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-opencode-test-'));
+    const dbPath = path.join(tmpDir, 'opencode.db');
+
+    try {
+        const initScript = [
+            'import sqlite3, sys',
+            'conn = sqlite3.connect(sys.argv[1])',
+            'conn.execute("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)")',
+            'conn.execute("INSERT INTO session VALUES (?, ?)", ("ses_123", "LLM Origin Inquiry"))',
+            'conn.commit()',
+            'conn.close()'
+        ].join('\n');
+        execFileSync('python3', ['-c', initScript, dbPath]);
+
+        const title = await titles.readOpenCodeSessionTitle('ses_123', { opencodeDbPath: dbPath });
+        assert.equal(title, 'LLM Origin Inquiry');
+
+        const missingIdTitle = await titles.readOpenCodeSessionTitle('ses_nonexistent', { opencodeDbPath: dbPath });
+        assert.equal(missingIdTitle, '');
+
+        const emptyIdTitle = await titles.readOpenCodeSessionTitle('', { opencodeDbPath: dbPath });
+        assert.equal(emptyIdTitle, '');
+
+        const missingFileTitle = await titles.readOpenCodeSessionTitle('ses_123', {
+            opencodeDbPath: path.join(tmpDir, 'missing.db')
+        });
+        assert.equal(missingFileTitle, '');
+    } finally {
+        fs.rmSync(tmpDir, { recursive: true, force: true });
+    }
+});
+
+test('isBotOwnedTopicName verifies bot ownership before renaming', () => {
+    assert.equal(
+        titles.isBotOwnedTopicName({ customTopicName: true, topicName: 'New chat' }, 'some prompt'),
+        false
+    );
+
+    assert.equal(
+        titles.isBotOwnedTopicName({ topicTitleSource: 'custom', topicName: 'New chat' }, 'some prompt'),
+        false
+    );
+
+    const prompt1 = 'i need advice about AI voice agents';
+    const fallbackTitle = titles.deriveFallbackTitle(prompt1);
+    assert.equal(
+        titles.isBotOwnedTopicName({ topicName: fallbackTitle }, prompt1),
+        true
+    );
+
+    assert.equal(
+        titles.isBotOwnedTopicName({ topicName: 'My Hand Picked Name' }, prompt1),
+        false
+    );
+
+    assert.equal(
+        titles.isBotOwnedTopicName({ topicName: '/engine' }, ''),
+        true
+    );
+    assert.equal(
+        titles.isBotOwnedTopicName({ topicName: 'New OpenCode chat' }, ''),
+        true
+    );
+
+    // Telegram's own name for a fresh topic (e.g. a shortened first message) is replaceable
+    assert.equal(
+        titles.isBotOwnedTopicName({ topicTitleSource: 'telegram', topicName: 'Could you check why my backups are' }, 'Could you check why my backups are failing every night?'),
+        true
+    );
+    // A name the bot did not set, with a known non-telegram source, is left alone
+    assert.equal(
+        titles.isBotOwnedTopicName({ topicTitleSource: 'ai', lastBotTopicName: 'Backup Failure Analysis', topicName: 'Backups' }, 'x'),
+        false
+    );
+});
diff --git a/titles.js b/titles.js
index 65c07dc..c4f02c4 100644
--- a/titles.js
+++ b/titles.js
@@ -6,6 +6,8 @@ const path = require('path');
 const { execFile } = require('child_process');
 
 const DEFAULT_AGY_DB_PATH = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversation_summaries.db');
+const DEFAULT_OPENCODE_DB_PATH = process.env.OPENCODE_DB_PATH ||
+    path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');
 const DEFAULT_GROK_SESSIONS_DIR = path.join(os.homedir(), '.grok', 'sessions');
 const DEFAULT_MEMORY_DIR = path.join(__dirname, 'memory');
 const MAX_TOPIC_TITLE_LEN = 64;
@@ -16,6 +18,11 @@ const GENERIC_EXACT_TITLES = new Set([
     'new chat session',
     'untitled',
     'main chat',
+    'greeting',
+    'greetings',
+    'casual greeting',
+    'llm identity inquiry',
+    'model identity inquiry',
     'general greeting',
     'current time inquiry',
     'ai model identity inquiry',
@@ -40,10 +47,12 @@ const GENERIC_EXACT_TITLES = new Set([
     'question'
 ]);
 
-const ADVICE_PATTERN = /^(?:(?:hi|hello|hey)(?:\s+there)?[,!.\s]+)?(?:i\s+(?:need|want|would\s+like)|can\s+i\s+get|give\s+me|looking\s+for|i'?m\s+looking\s+for)\s+(?:some\s+)?(advice|help|guidance|info|information|suggestions|tips|recommendations|thoughts)\s+(?:on|about|with|for|regarding)\s+(.+)$/i;
+const EXTENDED_GREETING_PREFIX = /^(?:hi+|hello+|hey+|hiya|yo+|sup|howdy|ok(?:ay)?(?:\s+so)?|so|btw)(?:\s+there)?[,!.\s]+/i;
+const LEGACY_GREETING_PREFIX = /^(?:hi|hello|hey)(?:\s+there)?[,!.\s]+/i;
 
-const FILLER_PREFIXES = [
-    /^(?:hi|hello|hey)(?:\s+there)?[,!.\s]+/i,
+const ADVICE_PATTERN = /^(?:(?:hi+|hello+|hey+|hiya|yo+|sup|howdy|ok(?:ay)?(?:\s+so)?|so|btw)(?:\s+there)?[,!.\s]+)?(?:i\s+(?:need|want|would\s+like)|can\s+i\s+get|give\s+me|looking\s+for|i'?m\s+looking\s+for)\s+(?:some\s+)?(advice|help|guidance|info|information|suggestions|tips|recommendations|thoughts)\s+(?:on|about|with|for|regarding)\s+(.+)$/i;
+
+const COMMON_FILLER_PREFIXES = [
     /^(?:i\s+wanted\s+to\s+(?:ask|know|check|see)\s+(?:about\s+)?)/i,
     /^(?:i\s+need\s+to\s+(?:ask|check|know|see|find)\s+(?:about\s+)?)/i,
     /^(?:i\s+(?:need|want|would\s+like)\s+(?:some\s+)?(?:advice|help|guidance|info|information|suggestions|tips)\s+(?:on|about|with|for)\s+)/i,
@@ -56,6 +65,16 @@ const FILLER_PREFIXES = [
     /^(?:my|the|a|an)\s+(?=\S+\s+\S+)/i
 ];
 
+const FILLER_PREFIXES = [
+    EXTENDED_GREETING_PREFIX,
+    ...COMMON_FILLER_PREFIXES
+];
+
+const LEGACY_FILLER_PREFIXES = [
+    LEGACY_GREETING_PREFIX,
+    ...COMMON_FILLER_PREFIXES
+];
+
 const LOWERCASE_TITLE_WORDS = new Set([
     'a', 'an', 'the', 'and', 'or', 'but', 'for', 'nor', 'on', 'at', 'to', 'from', 'by', 'in', 'of', 'with', 'about', 'into', 'onto', 'per', 'via'
 ]);
@@ -112,9 +131,12 @@ function isGenericTopicTitle(title) {
     if (/^topic\s*#\d+$/i.test(cleaned)) return true;
     if (cleaned.endsWith('...') || cleaned.endsWith('…')) return true;
     if (String(title).trim().endsWith('...') || String(title).trim().endsWith('…')) return true;
+    if (/^new session\s*-\s*\d{4}-\d{2}-\d{2}/i.test(cleaned)) return true;
+    if (/^new\s+(?:[a-z0-9_-]+\s+)?(?:chat|session)\b/i.test(cleaned)) return true;
 
     const lower = cleaned.toLowerCase().replace(/[.!?]+$/g, '').trim();
     if (GENERIC_EXACT_TITLES.has(lower)) return true;
+    if (/^(?:yo+|hi+|hey+|hello+)$/i.test(lower)) return true;
     if (lower.length <= 3) return true;
 
     return false;
@@ -135,7 +157,7 @@ function toSmartTitleCase(text) {
     }).join(' ');
 }
 
-function deriveFallbackTitle(prompt) {
+function deriveFallbackTitle(prompt, { legacy = false } = {}) {
     if (!prompt || typeof prompt !== 'string') return '';
     const firstLine = prompt
         .split(/\r?\n/)
@@ -165,12 +187,14 @@ function deriveFallbackTitle(prompt) {
 
     if (isGenericTopicTitle(text)) return '';
 
+    const prefixes = legacy ? LEGACY_FILLER_PREFIXES : FILLER_PREFIXES;
+
     // Special handling for "i need advice about <X>" -> "<X> Advice"
     const adviceMatch = text.match(ADVICE_PATTERN);
     if (adviceMatch) {
         const noun = adviceMatch[1].toLowerCase();
         let subject = adviceMatch[2].replace(/[,:;]+$/, '').trim();
-        for (const re of FILLER_PREFIXES) {
+        for (const re of prefixes) {
             subject = subject.replace(re, '').trim();
         }
         const subjectWords = subject.split(/\s+/).filter(Boolean).slice(0, 6);
@@ -180,7 +204,7 @@ function deriveFallbackTitle(prompt) {
         }
     }
 
-    for (const re of FILLER_PREFIXES) {
+    for (const re of prefixes) {
         text = text.replace(re, '').trim();
     }
 
@@ -256,6 +280,30 @@ function readGrokSessionTitle(workspace, sessionId, { grokSessionsDir = DEFAULT_
     });
 }
 
+function readOpenCodeSessionTitle(sessionId, { opencodeDbPath = DEFAULT_OPENCODE_DB_PATH } = {}) {
+    return new Promise((resolve) => {
+        if (!sessionId || !fs.existsSync(opencodeDbPath)) {
+            resolve('');
+            return;
+        }
+
+        const script = [
+            'import sqlite3, sys',
+            'conn = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)',
+            'row = conn.execute("SELECT title FROM session WHERE id = ?", (sys.argv[2],)).fetchone()',
+            'print(row[0] if row and row[0] else "")'
+        ].join('; ');
+
+        execFile('python3', ['-c', script, opencodeDbPath, sessionId], { timeout: 4000 }, (err, stdout) => {
+            if (err) {
+                resolve('');
+                return;
+            }
+            resolve(sanitizeTopicTitle(stdout));
+        });
+    });
+}
+
 function readFirstPromptFromMemory(sessionId, { memoryDir = DEFAULT_MEMORY_DIR } = {}) {
     if (!sessionId || !memoryDir) return '';
     try {
@@ -277,17 +325,20 @@ async function resolveSessionTitle(session, prompt, options = {}) {
     const effectivePrompt = prompt || readFirstPromptFromMemory(session.id, options);
     const readAgy = options.readAgyTitle || ((id) => readAgyConversationTitle(id, options));
     const readGrok = options.readGrokTitle || ((ws, id) => readGrokSessionTitle(ws, id, options));
-
-    const preferGrok = session.engine === 'grok';
-    const readers = preferGrok
-        ? [
-            async () => (session.grokSessionId ? readGrok(session.workspace, session.grokSessionId) : ''),
-            async () => (session.agyConversationId ? readAgy(session.agyConversationId) : '')
-        ]
-        : [
-            async () => (session.agyConversationId ? readAgy(session.agyConversationId) : ''),
-            async () => (session.grokSessionId ? readGrok(session.workspace, session.grokSessionId) : '')
-        ];
+    const readOpenCode = options.readOpenCodeTitle || ((id) => readOpenCodeSessionTitle(id, options));
+
+    const readAgyThunk = async () => (session.agyConversationId ? readAgy(session.agyConversationId) : '');
+    const readGrokThunk = async () => (session.grokSessionId ? readGrok(session.workspace, session.grokSessionId) : '');
+    const readOpenCodeThunk = async () => (session.opencodeSessionId ? readOpenCode(session.opencodeSessionId) : '');
+
+    let readers;
+    if (session.engine === 'opencode') {
+        readers = [readOpenCodeThunk, readAgyThunk, readGrokThunk];
+    } else if (session.engine === 'grok') {
+        readers = [readGrokThunk, readAgyThunk, readOpenCodeThunk];
+    } else {
+        readers = [readAgyThunk, readGrokThunk, readOpenCodeThunk];
+    }
 
     for (const reader of readers) {
         const aiTitle = sanitizeTopicTitle(await reader());
@@ -304,6 +355,44 @@ async function resolveSessionTitle(session, prompt, options = {}) {
     return { title: '', source: 'none' };
 }
 
+function isBotOwnedTopicName(session, firstPrompt) {
+    if (!session) return false;
+    if (session.customTopicName) return false;
+    if (session.topicTitleSource === 'custom') return false;
+
+    const topicName = session.topicName || '';
+    if (isGenericTopicTitle(topicName) || isPromptEchoTitle(topicName, firstPrompt)) {
+        return true;
+    }
+
+    // The name Telegram gave the topic on creation (often a shortened first message).
+    // A manual rename in Telegram switches the source to 'custom' via forum_topic_edited.
+    if (session.topicTitleSource === 'telegram') {
+        return true;
+    }
+
+    if (
+        (session.topicTitleSource === 'fallback' || session.topicTitleSource === 'ai') &&
+        session.lastBotTopicName &&
+        topicName === session.lastBotTopicName
+    ) {
+        return true;
+    }
+
+    if (!session.topicTitleSource) {
+        const fallback = deriveFallbackTitle(firstPrompt);
+        if (fallback && topicName === fallback) {
+            return true;
+        }
+        const legacyFallback = deriveFallbackTitle(firstPrompt, { legacy: true });
+        if (legacyFallback && topicName === legacyFallback) {
+            return true;
+        }
+    }
+
+    return false;
+}
+
 async function renameForumTopicOnTelegram(telegram, chatId, threadId, name) {
     if (!telegram || !chatId || !threadId || !name) return false;
     const cleanName = sanitizeTopicTitle(name);
@@ -347,6 +436,8 @@ module.exports = {
     readFirstPromptFromMemory,
     readAgyConversationTitle,
     readGrokSessionTitle,
+    readOpenCodeSessionTitle,
     resolveSessionTitle,
+    isBotOwnedTopicName,
     renameForumTopicOnTelegram
 };

```

---

## 5. Potential Future Architectural Approaches

1. **Topic Creation via API (`createForumTopic`):**
   - Provide a `/newtopic <name>` or `/topic new <name>` command in the bot.
   - Calling `createForumTopic` creates the thread with the intended name from the start, avoiding the `editForumTopic` client-side update bug entirely.
2. **Header Message / Pinned Status:**
   - Because client topic lists in private chats may not reflect renames, the bot can maintain an in-thread header or pin indicating the topic title, active engine, model, and turn count.
3. **Upstream Telegram Client Fixes:**
   - Monitor Telegram client releases (Telegram Desktop / iOS / Android) for fixes to `messageActionTopicEdit` delivery in direct-message forum mode.
