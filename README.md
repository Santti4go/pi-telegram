# pi-telegram

![pi-telegram screenshot](screenshot.png)

> Full pi build session: [View the session transcript](https://pi.dev/session/#14acfe07b7844c8abec55ed9fbddc17f), which captures the full pi session in which `pi-telegram` was built.

Telegram DM and forum-topic bridge for pi.

## Install

From git:

```bash
pi install git:github.com/badlogic/pi-telegram
```

Or for a single run:

```bash
pi -e git:github.com/badlogic/pi-telegram
```

## Configure

### Telegram

1. Open [@BotFather](https://t.me/BotFather)
2. Run `/newbot`
3. Pick a name and username
4. Copy the bot token

### pi

Start pi, then run:

```bash
/telegram-setup
```

Paste the bot token when prompted.

The extension stores config in:

```text
~/.pi/agent/telegram.json
```

## Connect a pi session

The Telegram bridge is session-local. Connect it only in the pi session that should own the bot:

```bash
/telegram-connect
```

To stop polling in the current session:

```bash
/telegram-disconnect
```

Check status:

```bash
/telegram-status
```

## Pair your Telegram account

After token setup and `/telegram-connect`:

1. Open the DM with your bot in Telegram
2. Send `/start`

The first DM user becomes the allowed Telegram user for the bridge. The extension only accepts messages from that user.

## Usage

Chat with your bot in Telegram DMs.

### Send text

Send any message in the bot DM. It is forwarded into pi with a `[telegram]` prefix.

### Send images and files

Send images, albums, or files in the DM.

The extension:
- downloads them to `~/.pi/agent/tmp/telegram`
- includes local file paths in the prompt
- forwards inbound images as image inputs to pi

### Ask for files back

If you ask pi for a file or generated artifact, pi should call the `telegram_attach` tool. The extension then sends those files with the next Telegram reply.

Examples:
- `summarize this image`
- `read this README and summarize it`
- `write me a markdown file with the plan and send it back`
- `generate a shell script and attach it`

### Stop a run

In Telegram, send:

```text
stop
```

or:

```text
/stop
```

That aborts the active pi turn.

### Queue follow-ups

If you send more Telegram messages while pi is busy, they are queued and processed in order.

## Streaming

The extension streams assistant text previews back to Telegram while pi is generating.

It tries Telegram draft streaming first with `sendMessageDraft`. If that is not supported for your bot, it falls back to `sendMessage` plus `editMessageText`.

## Forum topics: one topic per Pi session

Forum mode requires Node.js 22+, Unix-domain sockets, and the `flock` executable (typically provided by `util-linux`). Private mode does not require `flock`.

1. Pair your Telegram account in private mode first, as described above.
2. Create a **supergroup**, enable Topics, and add the bot as an administrator with **Manage Topics** permission. A broadcast channel is not a forum.
3. Disconnect **all** existing private-mode Pi pollers with `/telegram-disconnect`.
4. Add the numeric group ID to `~/.pi/agent/telegram.json`, preserving the existing token and allowed user:

   ```json
   {
     "forumChatId": -1001234567890
   }
   ```

   This is a fragment to merge, not a replacement for your configuration. The bot does not automatically discover which group you want to use. Keep the group private: other group members can read topic replies even though only `allowedUserId` can control Pi.

5. After installing these changes, run `/reload` in Pi, then `/telegram-connect`.
6. Open a second terminal, start a separate `pi` session, optionally `/name Backend`, then `/telegram-connect`. Each session gets its own topic. Keep each Pi process running to receive messages.

`/telegram-connect` creates the topic automatically and reports its name and ID. `/telegram-status` shows the current binding. `/new` creates a new session (and, after connecting, a new topic); `/resume` or `pi -c` reconnects the same saved session to its existing topic. These are Pi terminal commands, not Telegram commands. Ephemeral sessions are not supported in forum mode.

Bindings are stored in `~/.pi/agent/telegram-threads.json`. On reconnect, a small connection message verifies the topic; deleted topics are replaced and closed topics are reopened. A failed validation request does not replace an existing topic unless Telegram explicitly reports that it is missing. Topic names follow the session name, or the working-directory name. Running `/name Backend` in Pi renames the connected topic to `π session — Backend` and updates the saved mapping. Pi names changed while disconnected are synchronized on the next `/telegram-connect`. While connected, renaming the topic in Telegram also updates the Pi session name: `Backend` becomes session `Backend` and topic `π session — Backend`. The prefix is stripped from the session name and restored on the topic. Only edits made by the paired `allowedUserId` are accepted (not other admins, bots, or anonymous admins). Icon-only edits do not invoke the agent. Telegram-side edits while disconnected are not synchronized; the saved Pi name wins on reconnect. Names are capped at Telegram's 128-character limit; a failed rename is reported without disconnecting the session. After updating dispatcher or client code, disconnect all forum sessions, exit all those Pi processes, and wait at least five seconds. Resume each with `pi -c` (or `pi --session <path|id>`) and reconnect. A full Pi restart is required because `/reload` may retain native `.mjs` modules in Node's module cache; stopping all clients also ensures the new dispatcher is launched. General and other topics are ignored; commands, files, typing, and streaming are scoped to the bound topic. Streaming uses message edits, not private-chat drafts.

A detached local dispatcher is launched automatically under `flock`. It owns the single `getUpdates` loop and routes messages to sessions over a user-only Unix socket. It exits about five seconds after the last session disconnects. Two processes cannot connect the same session topic simultaneously. Do not run another bot poller/webhook consumer with the same token, including an old private-mode instance.

Topics are **kept** on disconnect/shutdown; `close` and `delete` cleanup are not implemented. Messages for disconnected topics are discarded while the dispatcher is polling. Socket delivery is live/best-effort, not a durable offline queue. If the dispatcher dies, Pi reports the disconnect; run `/telegram-connect` again after any pending turn finishes. To change bot/group configuration, disconnect all sessions and wait five seconds before reconnecting. To return to private mode, remove `forumChatId` after disconnecting all forum sessions.

Runtime files (socket, lock, cursor) live under `~/.pi/agent/telegram-runtime/`. This implementation supports the single bot configured in `telegram.json`.

### Tests

```bash
npm test
```

Tests use mocked Telegram APIs; they never contact Telegram or modify your real configuration.

## Notes

- In private mode, only one pi session should be connected to the bot at a time
- Replies are sent as normal Telegram messages, not quote-replies
- Long replies are split below Telegram's 4096 character limit
- Outbound files are sent via `telegram_attach`

## License

MIT
