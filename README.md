# AI Terminal Suite — Telegram Dual-Engine Wrapper

Interactive Telegram remote control for **Google Antigravity (Gemini)** and **xAI Grok** with native support for **Telegram Forum Topics (Threads)**.

Designed specifically to solve mobile SSH pain points and provide isolated, parallel AI sessions directly from Telegram.

---

## Key Features

1. **Telegram Forum Topics (Threads) Support**:
   - Create topics in your Telegram supergroup (e.g. *#frontend*, *#backend*, *#experiments*).
   - Each topic maintains its own independent conversation context, workspace directory, model choice, and execution engine.
   - Run AI turns in parallel across multiple topics without collisions or blocking.
   - Automatic greeting and session initialisation upon creating a new topic.
   - Use `/sessions` to view all active topic sessions, and `/name <title>` to customise topic labels.

2. **Dual AI Engines**:
   - **Google Antigravity (`agy`)**: Gemini 3.8 Flash, Gemini 3.1 Pro, Claude Sonnet 4.6, Claude Opus 4.6 Thinking, and GPT-OSS 120B.
   - **xAI Grok (`grok`)**: Grok 4.7, Grok 4.7 Fast, Grok 4.6, and Grok 4.5.
   - Switch engine seamlessly per topic via `/engine`.

3. **Live Streaming & Tool Visualisation**:
   - Real-time message streaming updates with tool call status badges (`run_command`, `read_file`, `edit_file`, `web_fetch`).
   - Clean auto-folding and document file attachment for very long responses (>12,000 characters).

4. **Independent Task Control**:
   - Send `/stop` in a topic to cancel only that topic's turn.
   - Send `/stop all` to abort active turns across all topics simultaneously.

5. **Filesystem & Utilities**:
   - `/workspace <path>` or `/cd <path>`: Set workspace directory independently per topic.
   - `/get <file>`: Download files from the server directly to Telegram.
   - Upload documents or photos with captions to auto-save to the topic workspace and prompt the AI.
   - `/sh <cmd>`: Quick shell command execution on the host.

---

## Command Reference

| Command | Description |
| :--- | :--- |
| *(Any message)* | Prompt the AI agent in the current topic |
| `/sessions` or `/topics` | List all active topic sessions in this chat |
| `/name <title>` | View or set a nickname for the current topic |
| `/engine` | Switch between Antigravity (Gemini) and Grok |
| `/model` | Select active AI model for this topic |
| `/effort` | Select reasoning effort tier (Default, Low, Medium, High, Max) |
| `/new` | Reset conversation context for the current topic |
| `/plan <task>` | Run in plan-only mode |
| `/usage` or `/quota` | Query token usage and rate limits |
| `/skills` | View available agent skills |
| `/workspace <path>` | Switch workspace folder for this topic |
| `/pwd` | View current topic workspace |
| `/get <file>` | Download file from host to Telegram |
| `/sh <cmd>` | Execute a host bash command |
| `/stop` | Abort active agent task in this topic (`/stop all` to abort all) |
| `/status` | View server load, memory, and running tasks |
| `/help` | Display command reference |

---

## Daemon Management

The service runs continuously via `systemd`:

```bash
# Check service status
systemctl status telegram-terminal

# Restart daemon
systemctl restart telegram-terminal

# Follow live service logs
journalctl -u telegram-terminal -f
```
