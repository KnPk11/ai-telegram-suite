'use strict';

/**
 * Parses allowed user IDs from environment string.
 * Filters out empty values and any negative IDs (Telegram groups/channels).
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parseAllowedUserIds(raw) {
    if (!raw) return [];
    return String(raw)
        .split(',')
        .map(id => id.trim())
        .filter(id => Boolean(id) && !id.startsWith('-'));
}

/**
 * Verifies if an incoming sender (fromId) is in the authorised user list.
 * Never checks or authorises group chat IDs.
 *
 * @param {string[]} allowedUserIds
 * @param {string|number} fromId
 * @returns {boolean}
 */
function isUserAuthorised(allowedUserIds, fromId) {
    if (!fromId || !Array.isArray(allowedUserIds) || allowedUserIds.length === 0) {
        return false;
    }
    return allowedUserIds.includes(String(fromId));
}

/**
 * Middleware for Telegraf restricting access strictly to approved user IDs.
 * Disables PIN pairing permanently.
 *
 * @param {string[]} allowedUserIds
 * @returns {Function}
 */
function createAuthMiddleware(allowedUserIds) {
    return async (ctx, next) => {
        const chatId = ctx.chat?.id?.toString();
        const fromId = ctx.from?.id?.toString();
        if (!chatId) return;

        const text = ctx.message?.text?.trim() || ctx.message?.caption?.trim() || '';

        // Inform user that pairing via PIN has been permanently disabled
        if (text.startsWith('/pair')) {
            await ctx.reply(
                `🔒 *PIN pairing has been disabled for security.*\n\n` +
                `To authorise access, add your Telegram User ID (\`${fromId || chatId}\`) directly to \`ALLOWED_CHAT_IDS\` in your \`.env\` file.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        if (!allowedUserIds || allowedUserIds.length === 0) {
            await ctx.reply(
                `🔒 *Bot Not Configured*\n\n` +
                `No authorised user IDs are configured. Please add your Telegram User ID (\`${fromId || chatId}\`) to \`ALLOWED_CHAT_IDS\` in your \`.env\` file.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const isAuthorised = isUserAuthorised(allowedUserIds, fromId);
        if (!isAuthorised) {
            if (ctx.callbackQuery) {
                await ctx.answerCbQuery('⛔ Unauthorised access', { show_alert: true }).catch(() => {});
                return;
            }

            const isPrivate = !ctx.chat?.type || ctx.chat.type === 'private';
            const isCommand = text.startsWith('/');
            if (isPrivate || isCommand) {
                await ctx.reply(
                    `⛔ *Unauthorised Access*\nYour User ID: \`${fromId || chatId}\``,
                    { parse_mode: 'Markdown' }
                );
            }
            return;
        }

        return next();
    };
}

module.exports = {
    parseAllowedUserIds,
    isUserAuthorised,
    createAuthMiddleware
};
