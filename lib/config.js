import { z } from 'zod'

/**
 * Config validation. Invalid config fails LOUDLY at apply time with a precise
 * message, rather than surfacing later as a confusing runtime error.
 *
 * Doctrine (from @deepseek-ai/dsh-credentials): configuration carries
 * REFERENCES to secrets, never the secrets. A target therefore declares
 * `urlEnv` — an environment-variable name — and never a webhook URL.
 */

/** Discord's hard cap on the `content` field of a webhook message. */
export const DISCORD_CONTENT_CAP = 2000

/** POSIX shell identifier: what a credential reference is allowed to be. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Target names stay short and lowercase so they read well as tool arguments. */
const TARGET_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

const targetSchema = z.object({
  urlEnv: z.string().regex(ENV_NAME, 'must be an environment-variable name, not a URL'),
  username: z.string().min(1).max(80).optional(),
  defaultTitle: z.string().min(1).max(256).optional(),
}).strict()

export const pluginConfigSchema = z.object({
  targets: z.record(z.string().regex(TARGET_NAME, 'must be lowercase letters, digits and hyphens'), targetSchema).optional(),
  defaultTarget: z.string().optional(),
  maxLength: z.number().int().min(1).max(DISCORD_CONTENT_CAP).optional(),
  timeoutMs: z.number().int().positive().optional(),
  retryOn429: z.boolean().optional(),
  routePrefix: z.string().startsWith('/').optional(),
}).passthrough()

const DEFAULTS = {
  targets: {},
  maxLength: 1900,
  timeoutMs: 10000,
  retryOn429: true,
  routePrefix: '/x-discord',
}

/**
 * Validate and normalize config. Also rejects a `defaultTarget` that names no
 * configured target, which would otherwise only surface on the first
 * notification attempt.
 */
export function validateConfig(config = {}) {
  const result = pluginConfigSchema.safeParse(config)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`discord-notify: invalid config — ${issues.join('; ')}`)
  }

  const cfg = { ...DEFAULTS, ...result.data }
  const names = Object.keys(cfg.targets)

  if (cfg.defaultTarget === undefined) {
    // A single configured target is unambiguously the default.
    cfg.defaultTarget = names.length === 1 ? names[0] : undefined
  } else if (!names.includes(cfg.defaultTarget)) {
    throw new Error(
      `discord-notify: defaultTarget "${cfg.defaultTarget}" is not a configured target`
      + (names.length ? ` (have: ${names.join(', ')})` : ' (no targets configured)'),
    )
  }

  // Two targets sharing one reference is almost certainly a copy-paste slip:
  // they would post to the same channel while looking independent.
  const seen = new Map()
  for (const [name, target] of Object.entries(cfg.targets)) {
    const clash = seen.get(target.urlEnv)
    if (clash) throw new Error(`discord-notify: targets "${clash}" and "${name}" both use urlEnv ${target.urlEnv}`)
    seen.set(target.urlEnv, name)
  }

  return cfg
}
