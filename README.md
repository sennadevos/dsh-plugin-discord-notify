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

Create a webhook in Discord under **Server Settings → Integrations → Webhooks**, copy its URL, then either set it where the credential provider will find it, or POST it to the plugin's own route:

```sh
curl -X POST http://127.0.0.1:3080/x-discord/target/alerts \
  -H 'content-type: application/json' \
  -d '{"url":"https://discord.com/api/webhooks/…/…"}'

curl -X POST http://127.0.0.1:3080/x-discord/test/alerts   # send a test message
curl http://127.0.0.1:3080/x-discord/targets               # status only, never values
```

These routes are **loopback-only**: they require a loopback `Host` header, and writes additionally require a local connection. dsh's browser-trust fence guards only paths under `/api`, so this prefix carries its own.

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

## Not yet built

A settings-panel row (`settings.general.item`) for configuring targets from the dsh UI is specified in [`SPEC.md`](./SPEC.md) §20–25 but not implemented: it needs a browser bundle in dsh's lazy-CJS factory format, whose build preset is not published outside the dsh repo. Configuration currently happens through the credential store or the routes above.

## License

MIT
