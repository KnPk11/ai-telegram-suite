'use strict';

// Argv for one headless turn. OpenCode's `-p` is the server password, so its
// prompt is positional. `-c` / `--continue` is also avoided: it resumes the
// last session in the workspace and would cross Telegram topics.

function buildTurnArgs(engine, options = {}) {
    const prompt = String(options.prompt ?? '');
    const resume = !options.isNew && options.sessionId;

    if (engine === 'grok') {
        const args = [
            '--always-approve',
            '--permission-mode', options.mode === 'plan' ? 'plan' : 'bypassPermissions',
            '--output-format', 'streaming-json'
        ];
        if (resume) args.push('--resume', options.sessionId);
        if (options.model) args.push('-m', options.model);
        if (options.effort) args.push('--effort', options.effort);
        args.push('-p', prompt);
        return args;
    }

    if (engine === 'opencode') {
        const args = ['run', '--format', 'json', '--auto'];
        if (resume) args.push('--session', options.sessionId);
        if (options.model) args.push('-m', options.model);
        if (options.effort) args.push('--variant', options.effort);
        if (options.mode === 'plan') args.push('--agent', 'plan');
        args.push(prompt);
        return args;
    }

    const args = [
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions'
    ];
    if (resume) args.push('--conversation', options.sessionId);
    if (options.model) args.push('--model', options.model);
    if (options.effort) args.push('--effort', options.effort);
    if (options.mode) args.push('--mode', options.mode);
    args.push('-p', prompt);
    return args;
}

// Unknown Telegram slash commands are forwarded as a one-shot CLI prompt.
function buildSlashArgs(engine, text) {
    if (engine === 'opencode') return ['run', '--auto', String(text ?? '')];
    return ['-p', String(text ?? '')];
}

function sessionIdFor(session, engine) {
    if (!session) return null;
    if (engine === 'grok') return session.grokSessionId || null;
    if (engine === 'opencode') return session.opencodeSessionId || null;
    return session.agyConversationId || null;
}

module.exports = {
    buildTurnArgs,
    buildSlashArgs,
    sessionIdFor
};
