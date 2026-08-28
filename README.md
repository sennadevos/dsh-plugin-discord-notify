# dsh-plugin-discord-notify

Discord webhook notifications for the [DeepSeek Harness](https://github.com/deepseek-ai). Configure one or more webhook **targets**; the agent can then call `notify_discord` to tell you something you should see away from the terminal — a long task finished, a build broke, input is needed.

The webhook URL is a bearer credential: anyone holding it can post to your channel. So this plugin never stores one in a config file.

## How the secret is held

Config declares only the **name of an environment variable**:

```yaml
- insert:
    - id: discord-notify
      name: 'dsh-plugin-discord-notify'
      config:
        targets:
          alerts:
            urlEnv: DISCORD_WEBHOOK_ALERTS
        defaultTarget: alerts
```

The URL behind `DISCORD_WEBHOOK_ALERTS` lives with dsh's credential provider — `$DSH_HOME/.credentials.yaml`, the process environment, or a `.env` layer. This follows the doctrine of `@deepseek-ai/dsh-credentials`: *configuration carries references to secrets, never the secrets.* Two consequences worth knowing:

- **Your config stays safe to commit and sync** (chezmoi included). Nothing secret is in it.
- **Rotating a webhook needs no restart.** The reference is resolved on every notification, never cached, so a changed URL is used by the very next call.

## Install

```sh
dsh plugin --profile web add link:/path/to/dsh-plugin-discord-notify
```

`dsh plugin` forwards to pnpm and then reconciles `dsh.profile.bundles` itself, so the plugin is wired in as a profile layer automatically. A `link:` spec is the local-development form; `file:`, a git spec, or a published version all work the same way.

## Configure a target

Create a webhook in Discord under **Server Settings → Integrations → Webhooks** and copy its URL. Then pick whichever of the three routes suits you — they all write to the same place, so you can mix them freely.

### In the UI

**Settings → General → Discord notifications.** Each configured target gets a row showing whether it is set, a write-only field to paste a URL into, and **Send test** / **Clear** buttons. A stored URL is never displayed again — the server reports only *whether* a target is configured — so pasting a new one replaces it.

A target supplied by a read-only source (a live environment variable) renders as read-only rather than offering a write that would silently not take effect.

### Deterministically, from a file

For reproducible setups, put the URL in dsh's credential file — `$DSH_HOME/.credentials.yaml`, mode `0600`:

```yaml
version: 1
refs:
  DISCORD_WEBHOOK_ALERTS: https://discord.com/api/webhooks/…/…
```

The credential provider observes external edits, and references resolve per notification, so this takes effect without restarting dsh. An environment variable of the same name works identically and takes precedence (a target backed by one is then read-only in the UI, by design).

The **target declaration** — names, `urlEnv`, `defaultTarget` — lives in the plugin's config in your `cordis.patch.yml`, which is ordinary version-controlled configuration. Together that means a machine is provisioned by writing two files and never clicking anything: the declaration in your dotfiles, the secret in the credential file.

### Over HTTP

```sh
curl -X POST http://127.0.0.1:3080/x-discord/target/alerts \
  -H 'content-type: application/json' \
  -d '{"url":"https://discord.com/api/webhooks/…/…"}'

curl -X POST http://127.0.0.1:3080/x-discord/test/alerts   # send a test message
curl http://127.0.0.1:3080/x-discord/targets               # status only, never values
curl -X DELETE http://127.0.0.1:3080/x-discord/target/alerts
```

These routes are **loopback-only**: they require a loopback `Host` header, and writes additionally require a local connection. dsh's browser-trust fence guards only paths under `/api`, so this prefix carries its own. The settings row above is a client of exactly these routes.

## The tool

`notify_discord(message, title?, target?)`

- `target` is only offered when more than one is configured, and is constrained to the configured names.
- `title` becomes a bold first line.
- Messages are truncated to fit Discord's 2000-character cap, and the result says when that happened.
- The result reports success or the reason for failure as short text. An unconfigured or deleted webhook is a **returned fact**, not a thrown exception — the model can read it and adapt.

### Mentions can never ping

Every send carries `allowed_mentions: { parse: [] }`. Notification text is model-authored; without this, a message containing `@everyone` would ping your whole server. The text is preserved verbatim, it simply cannot mention anyone.

## Config reference

| Key | Default | Meaning |
| --- | --- | --- |
| `targets` | `{}` | Map of target name → `{ urlEnv, username?, defaultTitle? }` |
| `defaultTarget` | single target, else unset | Used when the tool call omits `target` |
| `maxLength` | `1900` | Truncation limit; capped at Discord's 2000 |
| `timeoutMs` | `10000` | Per-request timeout |
| `retryOn429` | `true` | Honour `retry_after` and retry once |
| `routePrefix` | `/x-discord` | Where the configuration routes live |

Invalid config fails loudly at load: a URL in place of an env name, a `defaultTarget` naming no target, two targets sharing one reference, or an unknown key inside a target.

## Rate limits

Discord allows 5 requests per 2 seconds per webhook, and failed requests count. Sends to one target are serialized with a minimum gap; a 429 is retried once after the delay Discord asks for. A failed send never wedges the queue.

## Development

```sh
npm install
npm test          # 25 tests, no network required
```

Tests cover truncation, mention suppression, URL validation, secret redaction, the retry policy, and queue serialization. `fetch` is stubbed, so nothing is sent.

## The browser half has no build step

dsh's client bundles are lazy-CJS factory modules, and dsh builds its own with an in-repo `tsdown` preset that is **not published** outside the dsh repository. Rather than reproduce that toolchain, [`lib/client.js`](./lib/client.js) is hand-written in the target format: the factory wrapper verbatim, and `React.createElement` instead of JSX. There is nothing to compile — what the file says is what the browser runs — so `npm test` and a service restart are the whole edit loop.

React and `@deepseek-ai/dsh-client-ui-primitives` are seeded by the shell's `require`; the row uses neither beyond React itself, and styles with inherited colour and translucent greys so it sits correctly in both the light and dark themes.

## License

MIT
