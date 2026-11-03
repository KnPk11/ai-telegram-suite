'use strict';

// Dynamic model catalogue for Antigravity (`agy models`), Grok (`grok models`),
// and OpenCode (`opencode models`).
// Results are cached in memory; the static fallback lists are only used when the
// CLI call fails and nothing has been fetched yet.

const { spawn } = require('child_process');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 30000;

const FALLBACK_MODELS = {
    agy: [
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
        { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
        { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
    ],
    grok: [
        { id: 'grok-4.7', label: 'grok-4.7', isDefault: true },
        { id: 'grok-4.7-build-fast', label: 'grok-4.7-build-fast' }
    ],
    opencode: [
        { id: 'opencode/big-pickle', label: 'opencode/big-pickle' }
    ]
};

// Strip ANSI escape codes and spinner carriage-return frames.
function cleanLines(output) {
    return String(output || '')
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .split('\n')
        .map(line => line.split('\r').pop().trimEnd())
        .filter(Boolean);
}

// `agy models` prints `<id><TAB or 2+ spaces><Display Name>` per line.
function parseAgyModels(output) {
    const models = [];
    for (const line of cleanLines(output)) {
        const m = line.trim().match(/^([a-z0-9][\w.\-]*)(?:\t+|\s{2,})(.+)$/i);
        if (m) models.push({ id: m[1], label: m[2].trim() });
    }
    return models;
}

// `grok models` prints a bulleted list: `  * grok-4.7 (default)` / `  - grok-4.6`.
// `opencode models` prints one `provider/model` id per line.
function parseOpenCodeModels(output) {
    const models = [];
    const seen = new Set();
    for (const line of cleanLines(output)) {
        const id = line.trim();
        if (!id.includes('/') || /\s/.test(id)) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        models.push({ id, label: id });
    }
    return models;
}

function parseGrokModels(output) {
    const models = [];
    for (const line of cleanLines(output)) {
        const m = line.match(/^\s*[*-]\s+(\S+)(\s+\(default\))?\s*$/);
        if (m) models.push({ id: m[1], label: m[1], isDefault: Boolean(m[2]) });
    }
    return models;
}

function modelIcon(engine, model) {
    const id = model.id.toLowerCase();
    if (engine === 'grok') {
        if (model.isDefault) return '⭐';
        if (id.includes('fast')) return '🏎️';
        return '⚡';
    }
    if (engine === 'opencode') {
        if (id.includes('free')) return '🆓';
        if (id.includes('flash')) return '⚡';
        return '🧩';
    }
    if (id.includes('argon')) return '💎';
    if (id.includes('flash')) return '⚡';
    if (id.includes('gemini')) return '🧠';
    if (id.includes('opus')) return '👑';
    if (id.includes('sonnet')) return '🎭';
    if (id.includes('claude')) return '🎭';
    if (id.includes('gpt')) return '🌐';
    return '🤖';
}

function formatModelLabel(engine, model) {
    const suffix = engine === 'grok' && model.isDefault ? ' (default)' : '';
    return `${modelIcon(engine, model)} ${model.label}${suffix}`;
}

function runModelsCommand(bin, env) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let settled = false;
        const child = spawn(bin, ['models'], { cwd: '/tmp', env });
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            reject(new Error(`${bin} models timed out`));
        }, FETCH_TIMEOUT_MS);

        try { child.stdin.end(); } catch {}
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.on('error', err => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) reject(new Error(`${bin} models exited with code ${code}`));
            else resolve(stdout);
        });
    });
}

function createModelCatalogue({ bins, env, ttlMs = CACHE_TTL_MS, runCommand = runModelsCommand, log = console }) {
    const cache = {};    // engine -> { models, fetchedAt, source }
    const inFlight = {}; // engine -> Promise

    async function fetchModels(engine) {
        const parse = engine === 'grok'
            ? parseGrokModels
            : (engine === 'opencode' ? parseOpenCodeModels : parseAgyModels);
        const output = await runCommand(bins[engine], env);
        const models = parse(output);
        if (models.length === 0) throw new Error(`no models parsed from ${engine} output`);
        return models;
    }

    async function getModels(engine, { force = false } = {}) {
        const entry = cache[engine];
        const fresh = entry && entry.source === 'cli' && Date.now() - entry.fetchedAt < ttlMs;
        if (fresh && !force) return entry;

        if (!inFlight[engine]) {
            inFlight[engine] = fetchModels(engine)
                .then(models => {
                    cache[engine] = { models, fetchedAt: Date.now(), source: 'cli' };
                    log.log(`[Models] Fetched ${models.length} ${engine} models`);
                    return cache[engine];
                })
                .catch(err => {
                    log.error(`[Models] Failed to fetch ${engine} models: ${err.message}`);
                    // Keep serving the last good list; otherwise fall back to the static one.
                    if (entry) return entry;
                    return { models: FALLBACK_MODELS[engine] || [], fetchedAt: Date.now(), source: 'fallback' };
                })
                .finally(() => { delete inFlight[engine]; });
        }
        return inFlight[engine];
    }

    return { getModels };
}

module.exports = {
    FALLBACK_MODELS,
    parseAgyModels,
    parseGrokModels,
    parseOpenCodeModels,
    formatModelLabel,
    createModelCatalogue
};
