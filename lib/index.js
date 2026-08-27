import { validateConfig } from './config.js'
import { createSender } from './discord.js'
import { createTargets } from './targets.js'
import { registerRoutes } from './routes.js'
import { registerNotifyDiscord } from './tools/notify-discord.js'

export const name = 'discord-notify'
export const inject = ['tools', 'credentials', 'webServer']

/**
 * Discord webhook notifications for the DeepSeek Harness.
 *
 * Config names webhook TARGETS; each target declares `urlEnv`, the
 * environment-variable name addressing its webhook URL. The URL itself lives
 * with the credential provider ($DSH_HOME/.credentials.yaml, the process
 * environment, or a .env layer) and is resolved per notification — so this
 * plugin's configuration is safe to commit and sync, and rotating a webhook
 * takes effect on the next call with no restart.
 *
 * Registers:
 *  - `notify_discord` — the agent-facing tool (lib/tools/notify-discord.js).
 *  - a `<routePrefix>` route group for configuring and testing targets
 *    (lib/routes.js), loopback-only.
 */
export function apply(ctx, config = {}) {
  const cfg = validateConfig(config)
  const targets = createTargets(ctx, cfg)
  const sender = createSender({ timeoutMs: cfg.timeoutMs, retryOn429: cfg.retryOn429 })

  registerNotifyDiscord(ctx, { cfg, targets, sender })
  registerRoutes(ctx, { cfg, targets, sender })
}
