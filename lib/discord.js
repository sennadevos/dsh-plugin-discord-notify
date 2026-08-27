import { DISCORD_CONTENT_CAP } from './config.js'

/**
 * Discord webhook transport.
 *
 * Three rules are enforced here rather than left to callers, because every one
 * of them is a way this plugin could misbehave with model-authored input:
 *
 *  1. `allowed_mentions: { parse: [] }` on EVERY send. Notification text comes
 *     from an LLM; without this, a message containing `@everyone` would ping
 *     the whole server.
 *  2. Sends to one target are serialized with a minimum gap. Discord allows
 *     5 requests per 2 seconds per webhook, and failed requests count too.
 *  3. The webhook URL never reaches a caller, an error, or a log line — it is
 *     a bearer credential, so anything derived from a response is redacted.
 */

/** 5 requests / 2s per webhook → one send per 400ms, serialized per target. */
const MIN_INTERVAL_MS = 400

/** Accepted webhook URL shapes, so a mistyped or non-Discord URL is refused. */
const WEBHOOK_URL = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/\d+\/[\w-]+$/

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether a string is a syntactically valid Discord webhook URL. */
export function isWebhookUrl(value) {
  return typeof value === 'string' && WEBHOOK_URL.test(value.trim())
}

/**
 * Remove a secret from any text derived from it. Belt: the exact value. Braces:
 * anything shaped like a webhook URL, in case Discord echoes one back.
 */
export function redact(text, secret) {
  let out = String(text ?? '')
  if (secret) out = out.split(secret).join('[webhook]')
  return out.replace(/https:\/\/[^\s"']*\/webhooks\/[^\s"']*/g, '[webhook]')
}

/**
 * Fit a message into Discord's content field, leaving room for a title line.
 * Returns the final content plus whether anything was cut, so the tool can say
 * so instead of silently delivering a truncated message.
 */
export function buildContent({ message, title, maxLength }) {
  const limit = Math.min(maxLength, DISCORD_CONTENT_CAP)
  const heading = title ? `**${title.replace(/[\r\n]+/g, ' ').trim()}**\n` : ''
  const room = limit - heading.length
  const body = String(message ?? '').trim()

  if (room <= 0) return { content: heading.slice(0, limit), truncated: true }
  if (body.length <= room) return { content: `${heading}${body}`, truncated: false }

  const marker = '\n…[truncated]'
  const keep = Math.max(0, room - marker.length)
  return { content: `${heading}${body.slice(0, keep)}${marker}`, truncated: true }
}

/** Build the webhook payload. `allowed_mentions` is not optional by design. */
export function buildPayload({ content, username }) {
  const payload = { content, allowed_mentions: { parse: [] } }
  if (username) payload.username = username
  return payload
}

/**
 * Create a sender that serializes per target and applies the retry policy.
 * Queues are keyed by target NAME, never by URL, so no secret is held in a map.
 */
export function createSender({ timeoutMs, retryOn429 }) {
  const chains = new Map()
  const lastSentAt = new Map()

  /** Run `fn` after any in-flight send to the same target, respecting the gap. */
  function serialize(targetName, fn) {
    const previous = chains.get(targetName) ?? Promise.resolve()
    const result = previous.then(async () => {
      const elapsed = Date.now() - (lastSentAt.get(targetName) ?? 0)
      if (elapsed < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - elapsed)
      try {
        return await fn()
      } finally {
        lastSentAt.set(targetName, Date.now())
      }
    })
    // The chain must survive a rejection, or one failure wedges the target.
    chains.set(targetName, result.then(() => {}, () => {}))
    return result
  }

  /** One HTTP attempt, with both our timeout and the caller's cancellation. */
  async function attempt(url, payload, signal) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    const relay = () => controller.abort(new Error('cancelled'))
    if (signal) {
      if (signal.aborted) relay()
      else signal.addEventListener('abort', relay, { once: true })
    }
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', relay)
    }
  }

  /** How long Discord asked us to wait, in ms, from body or header. */
  async function retryDelay(response) {
    const header = Number(response.headers.get('retry-after'))
    let seconds = Number.isFinite(header) ? header : NaN
    try {
      const body = await response.clone().json()
      if (Number.isFinite(body?.retry_after)) seconds = body.retry_after
    } catch {
      // Non-JSON 429: fall back to the header, then to one interval.
    }
    const ms = Number.isFinite(seconds) ? seconds * 1000 : MIN_INTERVAL_MS
    return Math.min(Math.max(ms, 0), 30000)
  }

  /**
   * Deliver one payload. Never throws for a delivery problem — returns a
   * result the tool can report as text. Cancellation still throws, because the
   * caller asked for that.
   */
  async function send({ targetName, url, payload, signal }) {
    return serialize(targetName, async () => {
      let response
      try {
        response = await attempt(url, payload, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        return { delivered: false, status: 0, detail: redact(error?.message || 'request failed', url) }
      }

      if (response.status === 429 && retryOn429) {
        await sleep(await retryDelay(response))
        try {
          response = await attempt(url, payload, signal)
        } catch (error) {
          if (signal?.aborted) throw error
          return { delivered: false, status: 0, detail: redact(error?.message || 'retry failed', url), retried: true }
        }
        return { ...(await classify(response, url)), retried: true }
      }

      return classify(response, url)
    })
  }

  return { send }
}

/** Turn a response into a delivery verdict, with Discord's own message if any. */
async function classify(response, url) {
  if (response.ok) return { delivered: true, status: response.status, detail: '' }

  let detail = `HTTP ${response.status}`
  try {
    const body = await response.text()
    if (body) detail = `HTTP ${response.status}: ${redact(body, url).slice(0, 300)}`
  } catch {
    // Body already consumed or unreadable; the status alone is the detail.
  }
  if (response.status === 404) detail += ' — the webhook may have been deleted'
  if (response.status === 401 || response.status === 403) detail += ' — the webhook URL looks invalid'
  return { delivered: false, status: response.status, detail }
}
