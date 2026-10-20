'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const auth = require('../auth');

test('parseAllowedUserIds parses, trims, and discards negative group IDs', () => {
    assert.deepEqual(auth.parseAllowedUserIds(''), []);
    assert.deepEqual(auth.parseAllowedUserIds(null), []);
    assert.deepEqual(auth.parseAllowedUserIds('111111111'), ['111111111']);
    assert.deepEqual(
        auth.parseAllowedUserIds(' 111111111 , 222222222 , -100987654321 '),
        ['111111111', '222222222']
    );
});

test('isUserAuthorised strictly checks fromId against allowed list', () => {
    const allowed = ['111111111', '222222222'];

    assert.equal(auth.isUserAuthorised(allowed, '111111111'), true);
    assert.equal(auth.isUserAuthorised(allowed, 111111111), true);
    assert.equal(auth.isUserAuthorised(allowed, '999999999'), false);
    assert.equal(auth.isUserAuthorised(allowed, null), false);
    assert.equal(auth.isUserAuthorised([], '111111111'), false);
});

test('createAuthMiddleware rejects /pair command and disables pairing PIN', async () => {
    const middleware = auth.createAuthMiddleware(['111111111']);
    let repliedText = '';
    let nextCalled = false;

    const ctx = {
        chat: { id: 111111111, type: 'private' },
        from: { id: 111111111 },
        message: { text: '/pair 123456' },
        reply: async (text) => { repliedText = text; }
    };

    await middleware(ctx, async () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.match(repliedText, /PIN pairing has been disabled for security/i);
});

test('createAuthMiddleware allows authorised user in group chat without authorising group', async () => {
    const allowed = ['111111111'];
    const middleware = auth.createAuthMiddleware(allowed);
    let nextCalled = false;

    const ctx = {
        chat: { id: -1001234567890, type: 'supergroup' },
        from: { id: 111111111 },
        message: { text: 'Hello bot' }
    };

    await middleware(ctx, async () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    // Ensure allowed list has not been modified to include group ID
    assert.deepEqual(allowed, ['111111111']);
});

test('createAuthMiddleware blocks unauthorised user in group chat', async () => {
    const allowed = ['111111111'];
    const middleware = auth.createAuthMiddleware(allowed);
    let nextCalled = false;
    let replied = false;

    // Regular conversation text from unknown user: silently ignore
    const ctxCasual = {
        chat: { id: -1001234567890, type: 'supergroup' },
        from: { id: 999999999 },
        message: { text: 'Just chatting in group' },
        reply: async () => { replied = true; }
    };

    await middleware(ctxCasual, async () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(replied, false);

    // Command attempt from unknown user: explicit rejection
    let rejectionMessage = '';
    const ctxCommand = {
        chat: { id: -1001234567890, type: 'supergroup' },
        from: { id: 999999999 },
        message: { text: '/sh ls -la' },
        reply: async (text) => { rejectionMessage = text; }
    };

    await middleware(ctxCommand, async () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.match(rejectionMessage, /Unauthorised Access/i);
});

test('createAuthMiddleware blocks unauthorised callback query with alert', async () => {
    const allowed = ['111111111'];
    const middleware = auth.createAuthMiddleware(allowed);
    let nextCalled = false;
    let cbAlert = null;

    const ctxCb = {
        chat: { id: -1001234567890, type: 'supergroup' },
        from: { id: 999999999 },
        callbackQuery: { id: 'cb_123' },
        answerCbQuery: async (text, opts) => {
            cbAlert = { text, opts };
        }
    };

    await middleware(ctxCb, async () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(cbAlert?.text, '⛔ Unauthorised access');
    assert.equal(cbAlert?.opts?.show_alert, true);
});
