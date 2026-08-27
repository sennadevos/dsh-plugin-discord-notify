import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContent, buildPayload, createSender, isWebhookUrl, redact } from '../lib/discord.js'

const URL_OK = 'https://discord.com/api/webhooks/123456789/abcDEF-ghi_jkl'

test('isWebhookUrl accepts the real shapes and refuses everything else', () => {
  assert.ok(isWebhookUrl(URL_OK))
  assert.ok(isWebhookUrl('https://discord.com/api/v10/webhooks/1/tok-en_1'))
  assert.ok(isWebhookUrl('https://canary.discord.com/api/webhooks/1/tok'))
  assert.ok(isWebhookUrl('https://discordapp.com/api/webhooks/1/tok'))

  assert.ok(!isWebhookUrl('http://discord.com/api/webhooks/1/tok'), 'plain http')
  assert.ok(!isWebhookUrl('https://evil.example/api/webhooks/1/tok'), 'wrong host')
  assert.ok(!isWebhookUrl('https://discord.com/api/webhooks/1'), 'no token')
  assert.ok(!isWebhookUrl('DISCORD_WEBHOOK_ALERTS'), 'an env name is not a URL')
  assert.ok(!isWebhookUrl(undefined))
})

test('redact removes the exact secret and anything webhook-shaped', () => {
  assert.equal(redact(`failed posting to ${URL_OK} twice`, URL_OK), 'failed posting to [webhook] twice')
  // Even without being told the secret, a leaked URL is scrubbed.
  assert.equal(redact(`see ${URL_OK}`, undefined), 'see [webhook]')
  assert.equal(redact('plain error', URL_OK), 'plain error')
})

test('buildContent keeps short messages intact', () => {
  const { content, truncated } = buildContent({ message: 'build finished', maxLength: 1900 })
  assert.equal(content, 'build finished')
  assert.equal(truncated, false)
})

test('buildContent adds a bold title on its own line', () => {
  const { content } = buildContent({ message: 'all green', title: 'CI', maxLength: 1900 })
  assert.equal(content, '**CI**\nall green')
})

test('buildContent truncates to the limit and says so', () => {
  const { content, truncated } = buildContent({ message: 'x'.repeat(5000), maxLength: 100 })
  assert.equal(truncated, true)
  assert.ok(content.length <= 100, `length ${content.length} exceeds limit`)
  assert.ok(content.endsWith('…[truncated]'))
})

test('buildContent never exceeds Discord\'s hard cap even if config asks for more', () => {
  const { content } = buildContent({ message: 'y'.repeat(9000), maxLength: 99999 })
  assert.ok(content.length <= 2000, `length ${content.length} exceeds 2000`)
})

test('buildContent flattens newlines in the title so the heading stays one line', () => {
  const { content } = buildContent({ message: 'body', title: 'a\nb', maxLength: 200 })
  assert.equal(content, '**a b**\nbody')
})

test('buildPayload always suppresses mentions', () => {
  const payload = buildPayload({ content: '@everyone deploy done' })
  assert.deepEqual(payload.allowed_mentions, { parse: [] })
  // The text is preserved — it simply cannot ping.
  assert.equal(payload.content, '@everyone deploy done')
  assert.ok(!('username' in payload), 'username omitted when not set')
})

test('buildPayload passes a username override through', () => {
  assert.equal(buildPayload({ content: 'x', username: 'dsh' }).username, 'dsh')
})

/** Swap global fetch for one call, restoring it afterwards. */
async function withFetch(impl, run) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

const ok = () => new Response(null, { status: 204 })

test('send reports success on 204', async () => {
  const sender = createSender({ timeoutMs: 5000, retryOn429: true })
  const result = await withFetch(ok, () =>
    sender.send({ targetName: 'alerts', url: URL_OK, payload: { content: 'hi' } }))
  assert.deepEqual(result, { delivered: true, status: 204, detail: '' })
})

test('send retries once on 429 and honours retry_after', async () => {
  let calls = 0
  const sender = createSender({ timeoutMs: 5000, retryOn429: true })
  const started = Date.now()
  const result = await withFetch(() => {
    calls += 1
    if (calls === 1) {
      return new Response(JSON.stringify({ retry_after: 0.05 }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    }
    return ok()
  }, () => sender.send({ targetName: 'alerts', url: URL_OK, payload: { content: 'hi' } }))

  assert.equal(calls, 2, 'retried exactly once')
  assert.equal(result.delivered, true)
  assert.equal(result.retried, true)
  assert.ok(Date.now() - started >= 45, 'waited for retry_after')
})

test('send does not retry a 429 when the policy is off', async () => {
  let calls = 0
  const sender = createSender({ timeoutMs: 5000, retryOn429: false })
  const result = await withFetch(() => {
    calls += 1
    return new Response('rate limited', { status: 429 })
  }, () => sender.send({ targetName: 'alerts', url: URL_OK, payload: { content: 'hi' } }))

  assert.equal(calls, 1)
  assert.equal(result.delivered, false)
})

test('send returns a verdict rather than throwing when the network fails', async () => {
  const sender = createSender({ timeoutMs: 5000, retryOn429: true })
  const result = await withFetch(() => Promise.reject(new Error(`ECONNREFUSED ${URL_OK}`)), () =>
    sender.send({ targetName: 'alerts', url: URL_OK, payload: { content: 'hi' } }))

  assert.equal(result.delivered, false)
  assert.ok(!result.detail.includes('abcDEF'), `secret leaked: ${result.detail}`)
  assert.ok(result.detail.includes('[webhook]'))
})

test('an error body never carries the webhook URL back to the caller', async () => {
  const sender = createSender({ timeoutMs: 5000, retryOn429: false })
  const result = await withFetch(() => new Response(`bad webhook ${URL_OK}`, { status: 404 }), () =>
    sender.send({ targetName: 'alerts', url: URL_OK, payload: { content: 'hi' } }))

  assert.equal(result.delivered, false)
  assert.ok(!result.detail.includes('abcDEF'), `secret leaked: ${result.detail}`)
  assert.ok(result.detail.includes('deleted'), 'explains a 404')
})

test('sends to one target are serialized with a gap, not fired in parallel', async () => {
  const sender = createSender({ timeoutMs: 5000, retryOn429: true })
  const at = []
  await withFetch(() => { at.push(Date.now()); return ok() }, async () => {
    await Promise.all([
      sender.send({ targetName: 'alerts', url: URL_OK, payload: { content: '1' } }),
      sender.send({ targetName: 'alerts', url: URL_OK, payload: { content: '2' } }),
    ])
  })
  assert.equal(at.length, 2)
  assert.ok(at[1] - at[0] >= 380, `gap was only ${at[1] - at[0]}ms`)
})

test('a failed send does not wedge the target queue', async () => {
  const sender = createSender({ timeoutMs: 5000, retryOn429: false })
  let calls = 0
  const results = await withFetch(() => {
    calls += 1
    return calls === 1 ? Promise.reject(new Error('boom')) : ok()
  }, async () => [
    await sender.send({ targetName: 'alerts', url: URL_OK, payload: { content: '1' } }),
    await sender.send({ targetName: 'alerts', url: URL_OK, payload: { content: '2' } }),
  ])

  assert.equal(results[0].delivered, false)
  assert.equal(results[1].delivered, true, 'second send still went through')
})
