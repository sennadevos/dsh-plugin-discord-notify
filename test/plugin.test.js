import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { apply, inject, name } from '../lib/index.js'

const URL_OK = 'https://discord.com/api/webhooks/123456789/abcDEF-ghi_jkl'

/**
 * A stand-in for the cordis Context, carrying just the services this plugin
 * injects. Enough to run `apply` and then drive what it registered.
 */
function fakeCtx({ stored = {}, writable = true } = {}) {
  const tools = new Map()
  const routes = []
  const disposers = []

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    credentials: {
      async resolve(ref) {
        const value = stored[String(ref)]
        // The seam's rule: an empty stored value is absent.
        return value ? { value, source: 'file' } : undefined
      },
      async describe(ref) {
        return { configured: Boolean(stored[String(ref)]), source: 'file', writable }
      },
      async set(ref, value) { stored[String(ref)] = value },
      async unset(ref) { delete stored[String(ref)] },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) { disposers.push(fn()) },
  }

  return { ctx, tools, routes, disposers, stored }
}

/** Drive a registered route handler with a minimal req/res pair. */
async function call(route, { method = 'GET', path, body, host = '127.0.0.1:3080', peer = '127.0.0.1' } = {}) {
  const req = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    { method, url: path, headers: { host }, socket: { remoteAddress: peer } },
  )
  let status = 0
  let payload = ''
  const res = {
    writeHead(code) { status = code; return res },
    end(chunk) { if (chunk) payload += chunk },
  }
  await route.handler(req, res)
  return { status, body: payload ? JSON.parse(payload) : undefined }
}

async function withFetch(impl, run) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try { return await run() } finally { globalThis.fetch = original }
}

const CONFIG = { targets: { alerts: { urlEnv: 'DISCORD_WEBHOOK_ALERTS' } }, defaultTarget: 'alerts' }

test('the plugin declares the cordis contract dsh expects', () => {
  assert.equal(name, 'discord-notify')
  assert.deepEqual(inject, ['tools', 'credentials', 'webServer'])
})

test('apply registers the tool and one route group', () => {
  const { ctx, tools, routes } = fakeCtx()
  apply(ctx, CONFIG)
  assert.ok(tools.has('notify_discord'))
  assert.equal(routes.length, 1)
  assert.deepEqual({ kind: routes[0].kind, path: routes[0].path }, { kind: 'prefix', path: '/x-discord' })
})

// defineTool compiles the author-facing parameter DSL into JSON Schema, so
// these assert the compiled form the model actually receives.
test('a single target means the tool offers no target parameter', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, CONFIG)
  const { parameters } = tools.get('notify_discord')
  assert.ok(!('target' in parameters.properties), 'no needless choice')
  assert.deepEqual(parameters.required, ['message'])
  assert.equal(parameters.properties.message.type, 'string')
})

test('several targets expose a constrained target parameter', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { targets: { alerts: { urlEnv: 'A_HOOK' }, builds: { urlEnv: 'B_HOOK' } }, defaultTarget: 'alerts' })
  assert.deepEqual(tools.get('notify_discord').parameters.properties.target.enum, ['alerts', 'builds'])
})

test('the tool delivers and reports terse text, not the payload', async () => {
  const { ctx, tools } = fakeCtx({ stored: { DISCORD_WEBHOOK_ALERTS: URL_OK } })
  apply(ctx, CONFIG)
  const def = tools.get('notify_discord')

  let sent
  const value = await withFetch((url, init) => {
    sent = { url, body: JSON.parse(init.body) }
    return new Response(null, { status: 204 })
  }, () => def.execute({ message: 'deploy finished' }, { signal: undefined }))

  assert.equal(value.delivered, true)
  assert.equal(value.target, 'alerts')
  assert.equal(sent.url, URL_OK)
  assert.deepEqual(sent.body.allowed_mentions, { parse: [] })

  const blocks = def.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /^Notified Discord \(alerts\)\.$/)
})

test('an unconfigured target returns a readable fact, not an exception', async () => {
  const { ctx, tools } = fakeCtx({ stored: {} })
  apply(ctx, CONFIG)
  const value = await tools.get('notify_discord').execute({ message: 'hi' }, {})

  assert.equal(value.delivered, false)
  assert.match(value.detail, /not configured/)
  assert.match(value.detail, /DISCORD_WEBHOOK_ALERTS/)
  assert.match(tools.get('notify_discord').output.render({}, value)[0].text, /NOT delivered/)
})

test('an @everyone message is delivered without the ability to ping', async () => {
  const { ctx, tools } = fakeCtx({ stored: { DISCORD_WEBHOOK_ALERTS: URL_OK } })
  apply(ctx, CONFIG)
  let body
  await withFetch((_u, init) => {
    body = JSON.parse(init.body)
    return new Response(null, { status: 204 })
  }, () => tools.get('notify_discord').execute({ message: '@everyone @here <@&12345> ship it' }, {}))

  assert.match(body.content, /@everyone/, 'text preserved verbatim')
  assert.deepEqual(body.allowed_mentions, { parse: [] }, 'but nothing can be mentioned')
})

test('the tool rejects arguments that violate its declared schema', async () => {
  const { ctx, tools } = fakeCtx({ stored: { DISCORD_WEBHOOK_ALERTS: URL_OK } })
  apply(ctx, CONFIG)
  await assert.rejects(() => tools.get('notify_discord').execute({}, {}), /message/i)
})

test('GET /targets reports status and never a value', async () => {
  const { ctx, routes } = fakeCtx({ stored: { DISCORD_WEBHOOK_ALERTS: URL_OK } })
  apply(ctx, CONFIG)
  const { status, body } = await call(routes[0], { path: '/x-discord/targets' })

  assert.equal(status, 200)
  assert.equal(body.defaultTarget, 'alerts')
  assert.deepEqual(body.targets[0], {
    name: 'alerts',
    urlEnv: 'DISCORD_WEBHOOK_ALERTS',
    configured: true,
    source: 'file',
    writable: true,
    usable: true,
    isDefault: true,
  })
  assert.ok(!JSON.stringify(body).includes('abcDEF'), 'no secret in the response')
})

test('a non-loopback Host header is refused', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, CONFIG)
  for (const host of ['evil.example', '10.137.42.2:3080', 'attacker.test:80']) {
    const { status } = await call(routes[0], { path: '/x-discord/targets', host })
    assert.equal(status, 403, `host ${host} should be refused`)
  }
  // Loopback spellings are allowed.
  for (const host of ['127.0.0.1:3080', 'localhost:3080', '[::1]:3080']) {
    const { status } = await call(routes[0], { path: '/x-discord/targets', host })
    assert.equal(status, 200, `host ${host} should be allowed`)
  }
})

test('POST /target stores a valid webhook URL', async () => {
  const { ctx, routes, stored } = fakeCtx()
  apply(ctx, CONFIG)
  const { status, body } = await call(routes[0], {
    method: 'POST', path: '/x-discord/target/alerts', body: { url: URL_OK },
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(stored.DISCORD_WEBHOOK_ALERTS, URL_OK)
})

test('POST /target refuses anything that is not a Discord webhook URL', async () => {
  const { ctx, routes, stored } = fakeCtx()
  apply(ctx, CONFIG)
  for (const url of ['https://evil.example/api/webhooks/1/t', 'not a url', '', 'http://discord.com/api/webhooks/1/t']) {
    const { status } = await call(routes[0], { method: 'POST', path: '/x-discord/target/alerts', body: { url } })
    assert.equal(status, 400, `should refuse ${JSON.stringify(url)}`)
  }
  assert.equal(stored.DISCORD_WEBHOOK_ALERTS, undefined, 'nothing stored')
})

test('POST /target refuses to write when a read-only source shadows the reference', async () => {
  const { ctx, routes } = fakeCtx({ writable: false })
  apply(ctx, CONFIG)
  const { status, body } = await call(routes[0], {
    method: 'POST', path: '/x-discord/target/alerts', body: { url: URL_OK },
  })
  assert.equal(status, 409)
  assert.match(body.error, /read-only source/)
})

test('writes from a non-local peer are refused even with a loopback Host', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, CONFIG)
  const { status } = await call(routes[0], {
    method: 'POST', path: '/x-discord/target/alerts', body: { url: URL_OK }, peer: '10.137.42.6',
  })
  assert.equal(status, 403)
})

test('DELETE /target clears the stored value', async () => {
  const { ctx, routes, stored } = fakeCtx({ stored: { DISCORD_WEBHOOK_ALERTS: URL_OK } })
  apply(ctx, CONFIG)
  const { status } = await call(routes[0], { method: 'DELETE', path: '/x-discord/target/alerts' })
  assert.equal(status, 200)
  assert.equal(stored.DISCORD_WEBHOOK_ALERTS, undefined)
})

test('POST /test delivers through the same path as the tool', async () => {
  const { ctx, routes } = fakeCtx({ stored: { DISCORD_WEBHOOK_ALERTS: URL_OK } })
  apply(ctx, CONFIG)
  let body
  const result = await withFetch((_u, init) => {
    body = JSON.parse(init.body)
    return new Response(null, { status: 204 })
  }, () => call(routes[0], { method: 'POST', path: '/x-discord/test/alerts' }))

  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.deepEqual(body.allowed_mentions, { parse: [] })
})

test('an unknown target and an unknown route both 404', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, CONFIG)
  assert.equal((await call(routes[0], { method: 'DELETE', path: '/x-discord/target/nope' })).status, 404)
  assert.equal((await call(routes[0], { path: '/x-discord/whatever' })).status, 404)
})

test('invalid config fails at apply time, not on first use', () => {
  const { ctx } = fakeCtx()
  assert.throws(() => apply(ctx, { targets: { alerts: { urlEnv: URL_OK } } }), /invalid config/)
})
