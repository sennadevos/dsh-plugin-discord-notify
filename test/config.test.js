import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../lib/config.js'

test('defaults apply to an empty config', () => {
  const cfg = validateConfig({})
  assert.deepEqual(cfg.targets, {})
  assert.equal(cfg.maxLength, 1900)
  assert.equal(cfg.timeoutMs, 10000)
  assert.equal(cfg.retryOn429, true)
  assert.equal(cfg.routePrefix, '/x-discord')
  assert.equal(cfg.defaultTarget, undefined)
})

test('a single target becomes the default on its own', () => {
  const cfg = validateConfig({ targets: { alerts: { urlEnv: 'DISCORD_WEBHOOK_ALERTS' } } })
  assert.equal(cfg.defaultTarget, 'alerts')
})

test('several targets leave the default unset unless declared', () => {
  const targets = { alerts: { urlEnv: 'A_HOOK' }, builds: { urlEnv: 'B_HOOK' } }
  assert.equal(validateConfig({ targets }).defaultTarget, undefined)
  assert.equal(validateConfig({ targets, defaultTarget: 'builds' }).defaultTarget, 'builds')
})

test('a webhook URL in place of an env name is refused', () => {
  assert.throws(
    () => validateConfig({ targets: { alerts: { urlEnv: 'https://discord.com/api/webhooks/1/tok' } } }),
    /environment-variable name, not a URL/,
  )
})

test('a defaultTarget naming no target is refused at apply time', () => {
  assert.throws(
    () => validateConfig({ targets: { alerts: { urlEnv: 'A_HOOK' } }, defaultTarget: 'typo' }),
    /not a configured target/,
  )
})

test('two targets sharing one reference is refused', () => {
  assert.throws(
    () => validateConfig({ targets: { a: { urlEnv: 'SAME_HOOK' }, b: { urlEnv: 'SAME_HOOK' } } }),
    /both use urlEnv SAME_HOOK/,
  )
})

test('an unknown key inside a target is refused rather than ignored', () => {
  assert.throws(
    () => validateConfig({ targets: { alerts: { urlEnv: 'A_HOOK', url: 'https://…' } } }),
    /discord-notify: invalid config/,
  )
})

test('maxLength cannot exceed Discord\'s cap', () => {
  assert.throws(() => validateConfig({ maxLength: 2001 }), /discord-notify: invalid config/)
  assert.equal(validateConfig({ maxLength: 2000 }).maxLength, 2000)
})

test('target names are constrained to a readable slug', () => {
  assert.throws(() => validateConfig({ targets: { 'Bad Name': { urlEnv: 'A_HOOK' } } }), /lowercase/)
  assert.equal(Object.keys(validateConfig({ targets: { 'ci-builds': { urlEnv: 'A_HOOK' } } }).targets)[0], 'ci-builds')
})
