import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'

/**
 * Target resolution against the credential seam.
 *
 * `resolve` runs per notification and is never cached: that is what makes a
 * rotated webhook reach the very next call without restarting the plugin.
 * An absent or empty stored value counts as unconfigured everywhere.
 */
export function createTargets(ctx, cfg) {
  const names = () => Object.keys(cfg.targets)

  /** The target record for a name, or undefined. */
  const find = (name) => cfg.targets[name]

  /** A branded reference for a target, or undefined if the name is unusable. */
  function refFor(name) {
    const target = find(name)
    if (!target || !isCredentialRefName(target.urlEnv)) return undefined
    return credentialRef(target.urlEnv)
  }

  /**
   * Resolve a target's webhook URL. Returns the value and its source layer, or
   * a reason the caller can report verbatim.
   */
  async function resolveUrl(name) {
    const target = find(name)
    if (!target) {
      const known = names()
      return {
        error: `unknown target "${name}"`
          + (known.length ? ` — configured targets: ${known.join(', ')}` : ' — no targets are configured'),
      }
    }

    const ref = refFor(name)
    if (!ref) return { error: `target "${name}" has an unusable urlEnv (${target.urlEnv})` }

    const hit = await ctx.credentials.resolve(ref)
    if (!hit) {
      return {
        error: `target "${name}" is not configured — set the webhook URL for ${target.urlEnv}`
          + ' (dsh settings, $DSH_HOME/.credentials.yaml, or the environment)',
      }
    }
    return { url: hit.value, source: hit.source, target }
  }

  /**
   * Status of every target, safe for a configuration UI: whether it resolves,
   * which layer supplies it, and whether it can be written. Never a value.
   */
  async function describeAll() {
    return Promise.all(names().map(async (name) => {
      const target = find(name)
      const ref = refFor(name)
      if (!ref) return { name, urlEnv: target.urlEnv, configured: false, writable: false, usable: false }
      const info = await ctx.credentials.describe(ref)
      return {
        name,
        urlEnv: target.urlEnv,
        configured: Boolean(info?.configured),
        source: info?.source,
        // A read-only source (a live process env var) shadows writes: the seam
        // rejects a set() rather than let it silently not take effect.
        writable: Boolean(info?.writable),
        usable: true,
        isDefault: name === cfg.defaultTarget,
      }
    }))
  }

  return { names, find, refFor, resolveUrl, describeAll }
}
