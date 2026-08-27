import { buildContent, buildPayload, isWebhookUrl } from './discord.js'

/**
 * Configuration routes.
 *
 * These exist because a browser half cannot reach a plugin through dsh's
 * gateway: `ctx.remote.$mount` requires generated strict descriptors that a
 * third-party plugin has no way to produce. So configuration rides a plugin-
 * owned prefix instead.
 *
 * SECURITY: dsh's browser-trust fence guards only paths under `/api`, so this
 * prefix gets its own. Requests must carry a loopback Host header, which is
 * what stops a page on another origin from driving these routes via DNS
 * rebinding. Writes are further restricted to loopback peers.
 *
 *   GET    <prefix>/targets        → status of every target (never a value)
 *   POST   <prefix>/target/<name>  → { url } stored via credentials.set
 *   DELETE <prefix>/target/<name>  → credentials.unset
 *   POST   <prefix>/test/<name>    → deliver a fixed test message
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Whether the Host header names a loopback address. */
function hostIsLoopback(header) {
  if (!header) return false
  const value = String(header).trim().toLowerCase()
  const host = value.startsWith('[')
    ? value.slice(0, value.indexOf(']') + 1)
    : value.split(':')[0]
  return LOOPBACK_HOSTS.has(host)
}

/** Whether the connection itself came from this machine. */
function peerIsLoopback(req) {
  const address = req.socket?.remoteAddress
  if (!address) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readJson(req, limit = 8192) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (!size) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function registerRoutes(ctx, deps) {
  const { cfg, targets, sender } = deps
  const prefix = cfg.routePrefix.replace(/\/+$/, '')

  async function handler(req, res) {
    if (!hostIsLoopback(req.headers.host)) {
      return json(res, 403, { error: 'forbidden: this endpoint only accepts loopback requests' })
    }

    const url = new URL(req.url, 'http://localhost')
    const rest = url.pathname.slice(prefix.length).replace(/^\/+/, '')
    const [section, rawName] = rest.split('/')
    const name = rawName ? decodeURIComponent(rawName) : ''
    const method = req.method ?? 'GET'

    try {
      if (section === 'targets' && method === 'GET') {
        return json(res, 200, { targets: await targets.describeAll(), defaultTarget: cfg.defaultTarget ?? null })
      }

      if (section === 'target' && name) {
        if (!peerIsLoopback(req)) return json(res, 403, { error: 'forbidden: writes require a local connection' })

        const ref = targets.refFor(name)
        if (!ref) return json(res, 404, { error: `unknown target "${name}"` })

        if (method === 'POST') {
          const body = await readJson(req)
          const value = typeof body?.url === 'string' ? body.url.trim() : ''
          if (!isWebhookUrl(value)) {
            return json(res, 400, { error: 'not a Discord webhook URL (expected https://discord.com/api/webhooks/<id>/<token>)' })
          }
          const info = await ctx.credentials.describe(ref)
          if (info && info.writable === false) {
            return json(res, 409, { error: `${targets.find(name).urlEnv} is supplied by a read-only source (${info.source ?? 'environment'}) and cannot be written here` })
          }
          await ctx.credentials.set(ref, value)
          return json(res, 200, { ok: true, target: name })
        }

        if (method === 'DELETE') {
          await ctx.credentials.unset(ref)
          return json(res, 200, { ok: true, target: name })
        }
      }

      if (section === 'test' && name && method === 'POST') {
        if (!peerIsLoopback(req)) return json(res, 403, { error: 'forbidden: tests require a local connection' })

        const resolved = await targets.resolveUrl(name)
        if (resolved.error) return json(res, 400, { error: resolved.error })

        const { content } = buildContent({
          message: 'Test notification from dsh. If you can read this, the webhook works.',
          title: resolved.target.defaultTitle,
          maxLength: cfg.maxLength,
        })
        const outcome = await sender.send({
          targetName: name,
          url: resolved.url,
          payload: buildPayload({ content, username: resolved.target.username }),
        })
        return json(res, outcome.delivered ? 200 : 502, {
          ok: outcome.delivered,
          target: name,
          error: outcome.delivered ? undefined : outcome.detail,
        })
      }

      return json(res, 404, { error: 'no such route' })
    } catch (error) {
      // Never surface a raw stack: this handler has touched a secret.
      return json(res, 400, { error: String(error?.message ?? 'bad request').slice(0, 200) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: prefix, handler }))
}
