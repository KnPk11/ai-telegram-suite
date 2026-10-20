# Security & Hardening Policy

This document details the security architecture, threat model, and implemented hardening measures for the **AI Terminal Suite** Telegram daemon.

---

## 1. Security Model Overview

The AI Terminal Suite bridges Telegram messaging with local host agents (**Google Antigravity** and **xAI Grok**), which have capabilities to execute shell commands, inspect files, and modify local workspaces. Consequently, maintaining a strict access perimeter is paramount.

---

## 2. Implemented Hardening Steps

### Step 1: Permanent Removal of Pairing PIN
* **Previous Vulnerability**:
  The bot previously supported runtime pairing via a static or fallback PIN (`PAIRING_PIN=123456`). Because Telegram bot handles are public and globally searchable, anyone discovering the bot handle could brute-force the 6-digit PIN via `/pair` and permanently grant themselves full host access.
* **Remediation Implemented**:
  1. `PAIRING_PIN` has been completely removed from `.env` and runtime memory in [bot.js](bot.js).
  2. The `/pair` command has been permanently disabled. Any pairing attempt now returns an explicit administrative notice stating that dynamic PIN pairing is disabled for security.
  3. Authorised identities must now be explicitly provisioned in `.env` (`ALLOWED_CHAT_IDS`) by the host administrator.

### Step 2: Strict Sender-Level Authorisation (`fromId`) & Group Isolation
* **Previous Vulnerability**:
  In earlier implementations, when an authorised user messaged the bot inside a group or forum topic, the system automatically added the group's `chatId` (a negative number) to `ALLOWED_CHAT_IDS` and saved it to `.env`. Because subsequent checks evaluated `ALLOWED_CHAT_IDS.includes(chatId)`, all other members of that group or forum were automatically granted full access to execute commands and download files as root.
* **Remediation Implemented**:
  1. **Strict User Scoping**: Authorisation is now isolated in [auth.js](auth.js) and evaluates exclusively against `fromId` (`ctx.from.id`). `chatId` is never evaluated for access control.
  2. **Negative ID Rejection**: `parseAllowedUserIds()` automatically filters out any negative IDs at startup, ensuring group or channel IDs can never be interpreted as authorised user identities.
  3. **No Dynamic Persistence**: The automated `saveAllowedChatId()` function has been removed; running bots no longer possess write permissions back into `.env`.
  4. **Unauthorised Group Interaction Filtering**:
     - *Casual group chat*: Unauthorised messages from other members in a shared group are silently ignored, preventing spam and denial of service.
     - *Commands (`/...`)*: Unauthorised command attempts receive an explicit rejection notice containing their User ID.
     - *Inline buttons (Callback Queries)*: Unauthorised button clicks trigger a Telegram alert modal (`⛔ Unauthorised access`) without altering topic state.

---

## 3. Update Handling Matrix

| Context | Sender State | Update Type | Action Taken |
| :--- | :--- | :--- | :--- |
| **Private Chat** | Authorised | Any | Processed normally |
| **Private Chat** | Unauthorised | Any | Blocked; returns `⛔ Unauthorised Access` with user ID |
| **Group / Topic** | Authorised | Any | Processed normally; group ID is **not** stored |
| **Group / Topic** | Unauthorised | Casual text / upload | Silently ignored (no group spam) |
| **Group / Topic** | Unauthorised | Command (`/sh`, `/start`, etc.) | Blocked; replies with `⛔ Unauthorised Access` |
| **Group / Topic** | Unauthorised | Inline Button Click | Blocked; triggers Telegram UI alert `⛔ Unauthorised access` |

---

## 4. Automated Verification

The access control implementation is covered by automated unit tests in [test/auth.test.js](test/auth.test.js):

* Parsing and trimming of comma-separated IDs with negative group ID stripping.
* Strict validation of sender `fromId` irrespective of chat type.
* Rejection of `/pair` command and verification of security notice.
* Group isolation verification (ensuring allowed user list remains unmodified after group turns).
* Group suppression of casual messages vs explicit rejection of unauthorized commands.
* Callback query rejection with interactive alert modal.

Run the test suite using:

```bash
npm test
```

---

## 5. Remaining Hardening Roadmap

The following hardening steps remain recommended for defense-in-depth:

1. **Service Sandboxing (Step 3)**:
   Migrate `telegram-terminal.service` from `User=root` to a dedicated, unprivileged system user (e.g. `ai-runner`) without passwordless sudo.
2. **Filesystem Scoping (Step 4)**:
   Sanitise the `/get` handler in [bot.js](bot.js) to enforce path boundaries within allowed project workspaces, preventing arbitrary file reads (e.g. `/etc/shadow`, `~/.ssh/id_rsa`).
3. **Shell Command Restrictions (Step 5)**:
   Restrict or disable raw bash execution (`/sh`) over Telegram in favour of agent-mediated tools or SSH keys.
