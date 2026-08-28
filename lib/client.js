/**
 * Browser half: a row in Settings → General for configuring webhook targets.
 *
 * dsh's client bundles are lazy-CJS factory modules — the shell hands the
 * factory a `require` seeded with React and the UI primitives. dsh builds its
 * own bundles with an in-repo tsdown preset that is not published, so this
 * file is hand-written in that format: no JSX (React.createElement instead),
 * no imports, no build step. What you read here is what the browser runs.
 *
 * The row talks to this plugin's own loopback routes (/x-discord/...) with
 * plain fetch. It never receives a stored webhook URL — the server reports
 * only whether a target is configured — so the input is write-only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-discord-notify',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Only `slots` is required; the row owns its own state and fetching. */
    const inject = ['slots']

    // Theme-agnostic styling: inherit colour from the surrounding settings
    // panel and use translucent greys for structure, so the row reads
    // correctly in both the light and dark themes without depending on
    // token names that are not part of any public contract.
    const S = {
      group: { display: 'flex', flexDirection: 'column', gap: '10px' },
      title: { fontWeight: 600 },
      hint: { opacity: 0.65, fontSize: '0.85em', lineHeight: 1.5 },
      target: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '10px 12px',
        border: '1px solid rgba(128,128,128,0.28)',
        borderRadius: '8px',
      },
      head: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      name: { fontWeight: 600 },
      env: { opacity: 0.6, fontSize: '0.82em', fontFamily: 'var(--ds-font-family-code, monospace)' },
      badge: (ok) => ({
        marginLeft: 'auto',
        fontSize: '0.75em',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid ' + (ok ? 'rgba(60,170,120,0.55)' : 'rgba(128,128,128,0.4)'),
        color: ok ? 'rgb(60,170,120)' : 'inherit',
        opacity: ok ? 1 : 0.7,
        whiteSpace: 'nowrap',
      }),
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      input: {
        flex: '1 1 260px',
        minWidth: 0,
        padding: '6px 9px',
        borderRadius: '6px',
        border: '1px solid rgba(128,128,128,0.4)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '0.9em',
      },
      button: (kind) => ({
        padding: '6px 12px',
        borderRadius: '6px',
        border: '1px solid rgba(128,128,128,0.4)',
        background: kind === 'primary' ? 'rgba(88,101,242,0.16)' : 'transparent',
        borderColor: kind === 'primary' ? 'rgba(88,101,242,0.55)' : 'rgba(128,128,128,0.4)',
        color: 'inherit',
        font: 'inherit',
        fontSize: '0.88em',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }),
      note: (bad) => ({
        fontSize: '0.83em',
        lineHeight: 1.5,
        color: bad ? 'rgb(212,100,90)' : 'rgb(60,170,120)',
      }),
      readonly: { fontSize: '0.83em', opacity: 0.7, lineHeight: 1.5 },
    }

    /** Call a plugin route and return parsed JSON plus the status. */
    async function api(path, init) {
      const response = await fetch(path, {
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      let body = {}
      try {
        body = await response.json()
      } catch {
        // A non-JSON body means something upstream answered; status carries it.
      }
      return { ok: response.ok, status: response.status, body }
    }

    /** One configurable target. */
    function TargetCard({ target, prefix, onChanged }) {
      const [url, setUrl] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)

      const run = async (fn) => {
        setBusy(true)
        setNote(null)
        try {
          await fn()
        } catch (error) {
          setNote({ bad: true, text: String(error?.message || error) })
        } finally {
          setBusy(false)
        }
      }

      const save = () => run(async () => {
        const value = url.trim()
        if (!value) {
          setNote({ bad: true, text: 'Paste a webhook URL first.' })
          return
        }
        const { ok, body } = await api(`${prefix}/target/${encodeURIComponent(target.name)}`, {
          method: 'POST',
          body: JSON.stringify({ url: value }),
        })
        if (!ok) {
          setNote({ bad: true, text: body.error || 'Could not save.' })
          return
        }
        setUrl('')
        setNote({ bad: false, text: 'Saved.' })
        onChanged()
      })

      const clear = () => run(async () => {
        const { ok, body } = await api(`${prefix}/target/${encodeURIComponent(target.name)}`, { method: 'DELETE' })
        if (!ok) {
          setNote({ bad: true, text: body.error || 'Could not clear.' })
          return
        }
        setNote({ bad: false, text: 'Cleared.' })
        onChanged()
      })

      const test = () => run(async () => {
        const { ok, body } = await api(`${prefix}/test/${encodeURIComponent(target.name)}`, { method: 'POST' })
        setNote(ok
          ? { bad: false, text: 'Test message sent — check the channel.' }
          : { bad: true, text: body.error || 'Test failed.' })
      })

      const children = [
        h('div', { key: 'head', style: S.head },
          h('span', { style: S.name }, target.name),
          h('span', { style: S.env }, target.urlEnv),
          target.isDefault ? h('span', { key: 'def', style: S.env }, '· default') : null,
          h('span', { style: S.badge(target.configured) }, target.configured ? 'configured' : 'not set'),
        ),
      ]

      if (target.writable) {
        children.push(
          h('div', { key: 'row', style: S.row },
            h('input', {
              type: 'password',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: target.configured
                ? 'Paste a new webhook URL to replace the stored one'
                : 'https://discord.com/api/webhooks/…',
              value: url,
              disabled: busy,
              style: S.input,
              onChange: (event) => setUrl(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') save() },
            }),
            h('button', { type: 'button', style: S.button('primary'), disabled: busy, onClick: save }, 'Save'),
            target.configured
              ? h('button', { key: 't', type: 'button', style: S.button(), disabled: busy, onClick: test }, 'Send test')
              : null,
            target.configured
              ? h('button', { key: 'c', type: 'button', style: S.button(), disabled: busy, onClick: clear }, 'Clear')
              : null,
          ),
        )
      } else {
        children.push(
          h('div', { key: 'ro', style: S.readonly },
            `Supplied by a read-only source${target.source ? ` (${target.source})` : ''}, so it cannot be changed here. `
            + `Unset ${target.urlEnv} in the environment to manage it from this panel.`),
        )
      }

      if (note) children.push(h('div', { key: 'note', style: S.note(note.bad) }, note.text))

      return h('div', { style: S.target }, children)
    }

    /** The settings row: lists every configured target. */
    function DiscordNotifyRow() {
      const prefix = '/x-discord'
      const [state, setState] = React.useState({ status: 'loading', targets: [] })

      const load = React.useCallback(async () => {
        try {
          const { ok, body } = await api(`${prefix}/targets`)
          if (!ok) throw new Error(body.error || 'could not read targets')
          setState({ status: 'ready', targets: body.targets || [] })
        } catch (error) {
          setState({ status: 'error', targets: [], error: String(error?.message || error) })
        }
      }, [])

      React.useEffect(() => { load() }, [load])

      const body = []
      if (state.status === 'loading') {
        body.push(h('div', { key: 'l', style: S.hint }, 'Loading…'))
      } else if (state.status === 'error') {
        body.push(h('div', { key: 'e', style: S.note(true) }, state.error))
      } else if (!state.targets.length) {
        body.push(h('div', { key: 'n', style: S.hint },
          'No targets are configured. Add one to the plugin\'s `targets` config, then reload.'))
      } else {
        for (const target of state.targets) {
          body.push(h(TargetCard, { key: target.name, target, prefix, onChanged: load }))
        }
      }

      return h('div', { style: S.group },
        h('div', { key: 'title', style: S.title }, 'Discord notifications'),
        h('div', { key: 'hint', style: S.hint },
          'Webhook URLs are stored in the credential store, never in a config file. '
          + 'A stored URL is never shown again — paste a new one to replace it.'),
        ...body,
      )
    }

    /** Client plugin body: contribute one row to the General settings section. */
    function apply(ctx) {
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'discord-notify',
        order: 60,
      }, DiscordNotifyRow))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
