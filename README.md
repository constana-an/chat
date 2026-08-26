# Team Chat

A small team-chat web app: public channels, direct messages, @mentions, per-channel
unread counts, channel mutes, and quiet hours.

No dependencies, no build step. Node's standard library on the server, plain
ES modules in the browser.

```bash
npm start
```

Then open <http://localhost:3000>. Sessions are stored per **browser tab**, so you can
open a second tab, pick a different username, and watch both sides of a conversation
at once.

```bash
npm test
```

31 tests: the notification rules in isolation, plus an end-to-end pass over the HTTP
API and the event stream.

## What it does

| Feature | Where |
| --- | --- |
| Sign in with a username and password (a new name registers) | `POST /api/session` |
| Join and leave public channels, create new ones | `POST /api/channels/:id/join`, `/leave` |
| Post messages and read history | `GET`/`POST /api/channels/:id/messages` |
| Direct messages | `GET`/`POST /api/dms/:userId/messages` |
| @mention notifications, with autocomplete in the composer | `parseMentions()` in [notifications.js](server/notifications.js) |
| Per-channel unread and mention counts | `unreadFor()` in [store.js](server/store.js) |
| Channel mutes | `PATCH /api/channels/:id/prefs` |
| Quiet hours, in the user's own timezone | `PATCH /api/settings/quiet-hours` |
| Live updates, presence, toasts | SSE at `GET /api/events` |

## The notification policy

This is the part worth being explicit about, because "muted" means different things in
different apps. The rules live in [`server/notifications.js`](server/notifications.js)
as pure functions, so they are readable and testable on their own.

**Unread counts are always tracked.** Muting a channel silences alerts; it does not
hide activity. A muted channel still counts unread messages — it just shows them in a
plain grey badge instead of a red one, and the channel name stays bold.

**Only DMs and @mentions produce a notification.** Ordinary channel chatter never
lands in the notification inbox, muted or not; that is what the unread count is for.

**Channel mutes never suppress a DM or an @mention.** This is the requirement, and it
falls out of the model rather than being special-cased: a mute is consulted only for
`activity`-kind messages, and DMs and mentions are never that kind. When a mention does
arrive from a muted channel, the notification is tagged `bypassedMute` so the UI can
say *"delivered despite the channel mute"*.

**Quiet hours are a separate, later stage.** They can downgrade an alert to a silent
inbox entry, but they never drop it — you always see what you missed when you come
back. `allowDirect` lets DMs ring through anyway.

The two stages compose independently:

| Message | Channel muted | Quiet hours active | Unread? | Inbox? | Toast + sound? |
| --- | --- | --- | --- | --- | --- |
| Channel activity | no | no | ✅ | — | — |
| Channel activity | **yes** | no | ✅ | — | — |
| @mention | no | no | ✅ | ✅ | ✅ |
| @mention | **yes** | no | ✅ | ✅ | ✅ *(bypasses the mute)* |
| @mention | **yes** | **yes** | ✅ | ✅ | — *(silenced, not dropped)* |
| Direct message | n/a | no | ✅ | ✅ | ✅ |
| Direct message | n/a | **yes** | ✅ | ✅ | only if `allowDirect` |

Quiet-hours windows may wrap past midnight (`22:00 → 08:00`), and are evaluated
against a timezone offset the client reports on connect, so a window means the same
thing to a user in Tokyo as to one in Berlin.

## How it fits together

```
server/
  index.js          HTTP server, JSON body parsing, static files
  routes.js         the API; fans each new message out to its audience
  notifications.js  mentions, mutes, quiet hours — pure, no I/O
  store.js          in-memory data + JSON persistence to data/db.json
  hub.js            server-sent-events, one stream per open tab
public/
  index.html        markup
  styles.css        styling
  app.js            client: state, rendering, event stream, composer
tests/
  notifications.test.js   the rules, in isolation
  api.test.js             end-to-end over HTTP and the event stream
```

A few decisions worth knowing about:

**Unread counts ride on one global sequence number.** Every message gets a monotonic
`seq`; a read cursor is just "the highest `seq` I have seen in this conversation".
Counting unread means walking backwards from the end until you cross the cursor, so it
stays cheap and can never drift out of sync with the messages themselves.

**Joining a channel does not inherit its backlog as unread.** Your cursor starts at the
current sequence, so you see the history but arrive with a clean slate.

**Session tokens go in the `Authorization` header, not a cookie or a URL.** That is why
the client reads the event stream with `fetch` + `ReadableStream` instead of
`EventSource` (which cannot set headers): it keeps tokens out of URLs *and* lets each
browser tab hold a different session, which is what makes the app testable by one
person.

**Conversation ids are opaque.** DM threads are keyed `dm_<idA>_<idB>` with the ids
sorted, so both participants land on the same thread. The server tells each side who
the thread is *with*; the client never parses the id.

## Running it for other people

The server binds every interface, so it is reachable from your network as soon as it
starts. It has **no TLS**, so put it on a private network rather than the open internet.

The least-effort safe option is [Tailscale](https://tailscale.com): everyone installs it
and joins your tailnet, then opens `http://<your-machine>:3000`. Traffic is encrypted by
WireGuard, and nobody outside the tailnet can reach the server at all. No code changes.

A user guide for the people you invite (in Chinese) is served alongside the app at
`http://<your-machine>:3000/manual.html`, and linked from the sign-in screen. It covers
signing in, the unread badge colours, and how mutes and quiet hours interact.

If you ever do expose it publicly, TLS stops being optional — terminate it with Caddy or
Cloudflare in front, and read the limitations below first.

### Accounts

Signing in with an unused username registers it and sets the password; signing in with a
known one checks it. Passwords are hashed with `scrypt` (N=65536, r=8 — about 80 ms per
attempt) and stored salted in `data/db.json`, which is written mode `0600`.

Five wrong passwords for one username start an exponential lockout, capped at five
minutes. The lockout is per username, so one person guessing cannot lock everyone out.

Accounts created before passwords existed have no hash; the first sign-in claims one. The
server lists any such accounts at startup — delete the data file rather than shipping
them to other people.

## Limitations

Deliberately out of scope for something this size:

- **No TLS.** Run it behind Tailscale or a reverse proxy that terminates HTTPS. Over plain
  HTTP the session token is readable by anything on the path.
- **No password reset and no email.** A forgotten password means editing `data/db.json`.
- **Sessions live in memory**, so restarting the server signs everyone out. That is a
  reasonable default here, not an oversight.
- **The lockout is in memory too**, and keyed only by username — it slows guessing, it
  does not stop a determined attacker with a botnet.
- **Persistence is a JSON file**, rewritten (debounced) on change, capped at the last
  500 messages per conversation. Fine for one process; swap `store.js` for a real
  database before running more than one.
- **Public channels only** — no private channels or invitations.
- **No message editing, deletion, threads, reactions, or file uploads.**
- `@here`/`@channel` are not implemented; mentions are per-user only.
