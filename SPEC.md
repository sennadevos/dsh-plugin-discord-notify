# dsh-plugin-discord-notify

Configurable Discord webhook targets the agent can call to notify. Config carries a *reference* to each webhook URL; the URL itself never enters a config file.

## Package

1. Dual-face package; source `dot_dsh/plugins/dsh-plugin-discord-notify/`.
2. `package.json` declares `dsh.bundle.patch: "./cordis.patch.yml"` and `dsh.client: {platform: "web", inject: [...]}`; `exports["./client"]` mandatory.
3. Installed with `dsh plugin --profile web add link:<path>`.
4. Node half: `inject: ['tools', 'credentials', 'webServer']`, all registrations inside `ctx.effect`.

## Secrets

5. Each target's URL is addressed by `credentialRef('<ENV_NAME>')`. Config stores only the env-var name — never the URL. The settings document stays safe to sync via chezmoi.
6. `ctx.credentials.resolve(ref)` runs **per notification, never cached** — a rotated webhook reaches the next call without a restart.
7. An absent or empty value is unconfigured: the tool returns readable text, not an exception.
8. The resolved URL never appears in tool output, errors, or logs.

## Config

9. Zod: `targets: Record<slug, {urlEnv, username?, defaultTitle?}>`, `defaultTarget`, `maxLength` 1900, `timeoutMs` 10000, `retryOn429` true.

## Tool

10. `notify_discord(message, target?, title?)` → `POST <resolved url>` with JSON `{content, username?, embeds?, allowed_mentions}`.
11. `allowed_mentions: {parse: []}` is sent **always** — agent-authored text can never ping `@everyone`, `@here`, or a role.
12. `content` is truncated to `maxLength` with a trailing marker; Discord's hard cap is 2000 characters.
13. Omitted `target` uses `defaultTarget`; an unknown target returns an error naming the configured targets.
14. Sends are serialized per target — Discord allows 5 requests per 2 seconds per webhook.
15. On HTTP 429, honour `retry_after`, retry once, then return failure text.
16. Success returns a terse confirmation (target name, HTTP 204). The payload is not echoed.

## Routes

17. Prefix `/x-discord` via `ctx.webServer.register`: `POST /target/:slug` (write a URL via `credentials.set`), `DELETE /target/:slug` (`unset`), `GET /targets` (`describe(ref)` per target — status only, never values), `POST /test/:slug`.
18. Handlers validate the `Host` header; `/x-discord` sits outside dsh's `/api` trust fence.
19. Routes exist because `ctx.remote.$mount` requires generated descriptors unavailable to third-party plugins.

## Settings UI

20. `inject: ['slots', 'locale', 'remote']`.
21. One row per target via `ctx.slots.inject('settings.general.item', …)`.
22. Row shows configured/unconfigured from `GET /targets`, and renders read-only where `describe().writable` is false — a live process-environment value shadows writes, and `set` would otherwise fail loudly.
23. The URL field is masked and write-only; a stored value is never read back into it.
24. Badges refresh on `ctx.remote.$on('credentials/reference-updated')` — this event is in dsh's forwarded allowlist, so no custom transport is needed for it.
25. "Send test" posts a fixed message through the same path as the tool.

## Done when

- A URL saved in the settings row flips the badge to configured; the value is absent from every config file.
- Agent `notify_discord` delivers to the channel; `@everyone` inside the message does not ping.
- An over-long message is truncated and delivered, not rejected.
- An unconfigured or unknown target returns readable text.
- `journalctl --user -u dsh-web` contains no webhook URL.
