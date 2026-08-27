import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildContent, buildPayload } from '../discord.js'

/**
 * The `notify_discord` tool.
 *
 * Delivery problems are RETURNED, not thrown: an unconfigured or deleted
 * webhook is a fact the model should read and act on, not an exception that
 * derails a turn. Cancellation is the one thing that still throws.
 */
export function registerNotifyDiscord(ctx, deps) {
  const { cfg, targets, sender } = deps
  const names = targets.names()

  const parameters = {
    message: {
      type: 'string',
      required: true,
      description: 'The notification text. Plain text or Discord markdown. Mentions never ping: @everyone, @here and role mentions are suppressed on every send.',
    },
    title: {
      type: 'string',
      description: 'Optional bold heading placed on the first line, above the message.',
    },
  }

  // Only offer a target parameter when there is a real choice to make, and
  // constrain it to the configured names so the model cannot invent one.
  if (names.length > 1) {
    parameters.target = {
      type: 'string',
      enum: names,
      description: `Which webhook to notify. Defaults to "${cfg.defaultTarget ?? names[0]}".`,
    }
  }

  const description = names.length
    ? `Send a notification to Discord via a configured webhook (${names.join(', ')}). `
      + 'Use it to tell the user something they should see away from the terminal: a long task finished, '
      + 'a build broke, input is needed. One short message per event — this posts to a real channel.'
    : 'Send a notification to Discord via a configured webhook. No webhook targets are configured yet, '
      + 'so calls will report that instead of delivering.'

  ctx.tools.register(defineTool({
    name: 'notify_discord',
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', description: 'Whether Discord accepted the message.' },
          target: { type: 'string', description: 'The target that was used.' },
          truncated: { type: 'boolean', description: 'Whether the message was shortened to fit Discord\'s limit.' },
          detail: { type: 'string', description: 'Why delivery failed; empty on success.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    // The transport applies its own timeout; this is the outer ceiling that
    // also covers the serialization wait and a single 429 retry.
    timeoutMs: cfg.timeoutMs + 35000,
    async execute(args, exec) {
      const name = args.target ?? cfg.defaultTarget
      if (!name) {
        return {
          delivered: false,
          target: '',
          truncated: false,
          detail: names.length
            ? `no target given and no defaultTarget configured — pass one of: ${names.join(', ')}`
            : 'no webhook targets are configured',
        }
      }

      const resolved = await targets.resolveUrl(name)
      if (resolved.error) {
        return { delivered: false, target: name, truncated: false, detail: resolved.error }
      }

      const { content, truncated } = buildContent({
        message: args.message,
        title: args.title ?? resolved.target.defaultTitle,
        maxLength: cfg.maxLength,
      })

      if (!content.trim()) {
        return { delivered: false, target: name, truncated: false, detail: 'message is empty' }
      }

      const outcome = await sender.send({
        targetName: name,
        url: resolved.url,
        payload: buildPayload({ content, username: resolved.target.username }),
        signal: exec?.signal,
      })

      return {
        delivered: outcome.delivered,
        target: name,
        truncated,
        detail: outcome.delivered ? '' : outcome.detail,
      }
    },
  }))
}

/** Terse model-facing text. Deliberately not the payload. */
function renderResult(value) {
  if (value?.delivered) {
    return `Notified Discord (${value.target})${value.truncated ? ' — message truncated to fit' : ''}.`
  }
  return `Discord notification NOT delivered${value?.target ? ` (${value.target})` : ''}: ${value?.detail || 'unknown error'}`
}
