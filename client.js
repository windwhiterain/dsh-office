/**
 * dsh-office Web panel: one page that switches between every mounted office, showing each
 * one's colleague roster, hire form, public channel, and composer.
 *
 * The roster and the user mailbox are two side columns of that page, each opened and closed
 * from a button in its header, so neither shares a scrollport with the public channel.
 *
 * Loaded as a dynamic client module. The factory id must equal the package name so the
 * bundle route and the module-table identity agree. Data comes from the Host's office
 * routes, which apply the connection policy themselves.
 *
 * The sidebar entry and the main panel share one id: the sidebar owns the button and
 * addresses the matching main panel by that id.
 */
window.__ModuleLoader__.load({
  id: 'dsh-office',
  factory(require) {
    const React = require('react')
    // `ui-primitives` is a baseline platform module: the shell seeds it into the frozen
    // module table, so a dynamic bundle requires it without declaring an external. Using
    // its Menu and Button is what makes the office controls look like the rest of the UI.
    const { Button, IconChevronDownOutlineRegular, Menu, Modal } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Polling interval for the office snapshot. */
    const POLL_MS = 4000
    /**
     * How long an office edit waits for the Loader to apply the profile patch it wrote.
     *
     * A create or delete returns as soon as the row is written; the Loader reconciles the
     * file afterwards, and its watcher stabilizes writes before it reacts. Waiting covers
     * that gap, and the timeout is reported rather than hidden.
     */
    const SETTLE_TIMEOUT_MS = 30000
    /** Separator inside one model option value; never valid in a provider or model id. */
    const ROUTE_SEPARATOR = '\u0000'
    /** Registry routes, served by the office host rather than by any one office. */
    const OFFICES_ROUTE = '/dsh-office/offices'
    const CREATE_OFFICE_ROUTE = '/dsh-office/offices/create'
    const DELETE_OFFICE_ROUTE = '/dsh-office/offices/delete'
    const RENAME_OFFICE_ROUTE = '/dsh-office/offices/rename'
    /**
     * The roles offered before the snapshot arrives, and the one a colleague starts as.
     *
     * The office owns both values and reports them in the state snapshot — a role travels with the
     * session permission preset the office row maps it to — so this list is only what the picker
     * shows while that read is still in flight. A deployment that changes its mapping is therefore
     * reflected as soon as the snapshot lands, not overridden by these defaults.
     */
    const FALLBACK_ROLES = [
      { id: 'member' },
      { id: 'leader' },
      { id: 'consultant', permission: 'read-only' },
    ]
    const DEFAULT_ROLE = 'member'
    /**
     * The `localStorage` key holding this panel's own UI state.
     *
     * The panel is registered in the `main` slot, so opening another page unmounts it and
     * React state alone loses a half-written post and the office the operator was reading.
     * One record holds every field that must outlive that.
     */
    const PANEL_STATE_KEY = 'dsh-office.panel'
    /**
     * The panel's two side columns. Whether each is open is a standing preference rather than a
     * per-visit default, and each id is what the panel header's toggle addresses.
     */
    const RAIL_STATE_KEY = 'colleagues'
    const MAILBOX_STATE_KEY = 'mailbox'
    /** One office panel mounts at a time, so these ids are fixed rather than generated. */
    const RAIL_PANEL_ID = 'dsh-office-colleagues'
    const MAILBOX_PANEL_ID = 'dsh-office-mailbox'

    /**
     * Build a URL for one office route.
     *
     * The office travels as a query parameter rather than as a path segment, because an office
     * name accepts any script and a path segment would have to be percent-encoded twice — once
     * when the Host registers the route and once here. `URLSearchParams` encodes for both.
     * @param verb - `state`, `history`, `post`, `hire`, `configure`, or `dismiss`.
     * @param officeName - the office to act on.
     * @returns the request path.
     */
    function officeRoute(verb, officeName) {
      return `${OFFICES_ROUTE}/${verb}?${new URLSearchParams({ office: officeName })}`
    }

    /**
     * How one role reads in a picker.
     *
     * A role that the office row maps to a session permission preset shows it, because choosing
     * that role changes what the colleague's session may write, not only what it is called.
     * @param role - one `{ id, permission }` entry from the snapshot's `roles`.
     * @returns the option label.
     */
    function roleLabel(role) {
      return role.permission === undefined ? role.id : `${role.id} · ${role.permission}`
    }

    /**
     * The role and description fields the hire and edit dialogs share.
     *
     * One declaration for both, so the two surfaces cannot drift: they post to different routes
     * but offer the same choices and read back the same validation.
     * @param props.roles - the roles the office offers, from its snapshot.
     * @param props.role - the selected role id.
     * @param props.onRole - receives a newly selected role id.
     * @param props.description - the description draft.
     * @param props.onDescription - receives a new description draft.
     * @param props.onEnter - the dialog's Enter handler.
     * @returns the two form rows, as one array of children.
     */
    function colleagueFields(props) {
      const { roles, role, onRole, description, onDescription, onEnter } = props
      return [
        h('select', {
          key: 'role',
          style: field,
          value: role,
          'aria-label': 'Colleague role',
          onChange: event => onRole(event.target.value),
        }, roles.map(entry => h('option', { key: entry.id, value: entry.id }, roleLabel(entry)))),
        h('input', {
          key: 'description',
          style: field,
          value: description,
          placeholder: 'Description (optional)',
          'aria-label': 'Colleague description',
          onChange: event => onDescription(event.target.value),
          onKeyDown: onEnter,
        }),
      ]
    }

    /**
     * The panel's persisted UI state: which office it was showing, the draft it had typed,
     * and the wake toggle.
     *
     * Every read goes through one in-memory record, so a remount inside the same page load
     * restores the panel without touching storage, and a reload restores it from storage.
     * None of it is authoritative: an unreadable entry, denied storage, or a stored office
     * name that no longer exists each degrades to the value the panel would have started
     * from anyway.
     */
    const panelState = (() => {
      let record
      const open = () => {
        if (record !== undefined) return record
        record = {}
        if (typeof localStorage === 'undefined') return record
        try {
          const parsed = JSON.parse(localStorage.getItem(PANEL_STATE_KEY) ?? 'null')
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) record = parsed
        } catch {
          // Malformed or unreadable storage starts the panel at its defaults.
        }
        return record
      }
      return {
        get(key, fallback) {
          const value = open()[key]
          return value === undefined ? fallback : value
        },
        set(key, value) {
          open()[key] = value
          if (typeof localStorage === 'undefined') return
          try {
            localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(record))
          } catch {
            // Storage can be denied or full; the in-memory record still carries this page load.
          }
        },
      }
    })()

    /** Distance from the feed's floor, in pixels, that still counts as reading the newest message. */
    const FEED_FOLLOW_THRESHOLD = 24
    /** How long a reader's scrolling settles before it is sampled into follow intent. */
    const FEED_SAMPLE_MS = 500

    /**
     * Bottom-follow intent for one channel feed.
     *
     * Adapted from the harness conversation's own scroll controller
     * (`packages/client/ui-chat/src/client/chat/use-scroll-follow.ts`), which keeps the reader's
     * intent separate from the offset for two reasons that apply here unchanged: "at the bottom"
     * is a threshold rather than an exact equality, because a reader who stops a few pixels short
     * still means to follow the newest message; and a programmatic jump records the position it
     * landed on, so the scroll event it causes is not mistaken for reader movement.
     */
    class FeedFollow {
      /**
       * @param following - whether a new message should move the feed to the bottom.
       * @param threshold - accepted distance from the floor, in pixels.
       */
      constructor(following, threshold) {
        this.following = following
        this.threshold = threshold
        this.sampledTop = undefined
      }

      /**
       * Read one scrollport without measuring its children.
       * @param element - the scrolling feed.
       * @returns its position, viewport height, and maximum top.
       */
      metrics(element) {
        const height = element.clientHeight
        return { top: element.scrollTop, height, floor: Math.max(0, element.scrollHeight - height) }
      }

      /**
       * @param metrics - current geometry.
       * @returns whether the position is close enough to the floor to count as following.
       */
      nearBottom(metrics) {
        return metrics.floor - metrics.top <= this.threshold
      }

      /**
       * Adopt one settled reader position as the current intent.
       * @param metrics - geometry sampled after the reader stopped moving.
       * @returns the intent after sampling.
       */
      sample(metrics) {
        const movedByReader = this.sampledTop === undefined || Math.abs(metrics.top - this.sampledTop) > 0.5
        this.sampledTop = metrics.top
        if (movedByReader) this.following = this.nearBottom(metrics)
        return this.following
      }

      /**
       * Position the feed without that movement counting as reader intent.
       * @param element - the scrolling feed.
       * @param metrics - geometry before positioning.
       * @param top - requested offset, clamped to the measured range.
       * @returns the offset the feed landed on.
       */
      jump(element, metrics, top) {
        const target = Math.max(0, Math.min(metrics.floor, top))
        if (target !== metrics.top) element.scrollTop = target
        this.sampledTop = element.scrollTop
        this.following = this.nearBottom({ ...metrics, top: this.sampledTop })
        return this.sampledTop
      }

      /**
       * Land on the newest message and keep following it.
       * @param element - the scrolling feed.
       * @param metrics - current geometry.
       * @returns the offset the feed landed on.
       */
      toBottom(element, metrics) {
        this.following = true
        return this.jump(element, metrics, metrics.floor)
      }
    }

    /**
     * `useState` for one panel field that must outlive the panel unmounting and a reload.
     * @param key - the field's name inside {@link PANEL_STATE_KEY}.
     * @param fallback - the value to start from when nothing is stored.
     * @returns the value, and a setter that writes every update through to storage.
     * @remarks The stored value is read once per mount, so a caller whose `key` varies must key
     *   the component by the same value; otherwise the first draft of the first key stays on
     *   screen under the second key's name.
     */
    function useStoredState(key, fallback) {
      const [value, setValue] = useState(() => panelState.get(key, fallback))
      const update = useCallback((next) => {
        // The record, not React state, holds the previous value: both are written on every
        // update, and reading the record keeps two updates in one render pass from losing one.
        const resolved = typeof next === 'function' ? next(panelState.get(key, fallback)) : next
        panelState.set(key, resolved)
        setValue(resolved)
      }, [key, fallback])
      return [value, update]
    }

    const page = {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
    }
    const header = {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '16px 20px 12px',
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
    }
    const title = { margin: 0, fontSize: '16px', fontWeight: 600 }
    const muted = { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' }
    /** The office-management disclosures sit at the end of the header, opposite the switcher. */
    const headerForms = { display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }
    const switcherLabel = { maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    const switcherChevron = { display: 'inline-flex', alignItems: 'center' }
    const emptyState = { padding: '48px 24px', maxWidth: '560px' }
    const emptyTitle = { margin: '0 0 8px', fontSize: '15px', fontWeight: 600 }
    const emptyBody = { ...muted, margin: 0, lineHeight: 1.6 }
    const body = { display: 'flex', flex: 1, minHeight: 0 }
    /**
     * The roster column. Like the mailbox sidebar it is a head over a body, so all three columns
     * of the page name themselves the same way and scroll on their own.
     */
    const rail = {
      width: '260px',
      flex: 'none',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      borderRight: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
    }
    const railBody = { flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px' }
    const person = { padding: '6px 0', fontSize: '13px' }
    const personHead = { display: 'flex', alignItems: 'center', gap: '6px' }
    const personName = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    /** What a colleague was configured to be: it wraps, where the name beside it is elided. */
    const personNote = { ...muted, marginTop: '2px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }
    const dismissButton = {
      flex: 'none',
      padding: '2px 6px',
      fontSize: '11px',
      borderRadius: '4px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
    }
    const channel = { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }
    const feed = { flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }
    /**
     * The row that stands where the folded messages are: it is part of the feed's column, so it
     * scrolls with the messages it precedes rather than floating over them.
     */
    const foldedRow = { display: 'flex', justifyContent: 'center' }
    /**
     * One column's name, at the top of the column that holds it.
     *
     * Every column of the body draws the same message bubbles, so each is named where it starts:
     * without a name two feeds are told apart only by which side of the panel they are on. The
     * head is a row, so a column that can be closed carries its close button at the far end.
     */
    const columnHead = {
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '10px 20px',
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
      fontSize: '12px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    /**
     * The user's mailbox: a sidebar of its own, opened from the panel header.
     *
     * It is a column beside the public channel rather than a disclosure above it, so the two
     * feeds share neither a width nor a scrollport, and the mailbox gets the column's full height
     * instead of pushing the channel down.
     */
    const mailboxSide = {
      width: '320px',
      flex: 'none',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      borderLeft: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
    }
    /**
     * A closable side column's head: its own name, and the button that closes it. The count is
     * not repeated here — it is what the column's header toggle carries.
     */
    const sideHead = { ...columnHead, color: 'var(--dsw-alias-label-primary)' }
    const columnTitle = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    /** The sidebar's own scrollport, which no other feed shares. */
    const mailboxFeed = {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      padding: '12px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    }
    const columnClose = {
      flex: 'none',
      padding: '2px 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
    }
    const bubble = {
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '8px',
      padding: '8px 12px',
      background: 'var(--dsw-alias-bg-layer-1)',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      fontSize: '13px',
    }
    const bubbleHead = { ...muted, marginBottom: '4px' }
    /**
     * A compacted range renders as the summary that replaced it, marked so the operator can
     * tell a written record from what a colleague actually said.
     */
    const summaryBubble = {
      ...bubble,
      borderStyle: 'dashed',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const composerRow = { display: 'flex', gap: '8px', alignItems: 'center', padding: '12px 20px', borderTop: '1px solid var(--dsw-alias-border-l1)' }
    const field = {
      width: '100%',
      boxSizing: 'border-box',
      marginBottom: '6px',
      padding: '6px 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '13px',
    }
    const button = {
      padding: '8px 14px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-brand-primary)',
      color: 'var(--dsw-alias-bg-base)',
      font: 'inherit',
      cursor: 'pointer',
    }
    const notice = { margin: '0 20px 12px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' }
    const toggle = { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' }
    /**
     * The composer's text layers. The input renders the draft with transparent text and the
     * layer behind it paints the same characters, so a mention can carry the reference color
     * the harness editor gives one. Both layers take the same font, padding, and line height,
     * which is the whole alignment contract between them.
     */
    const composerField = { position: 'relative', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)' }
    const composerText = { font: 'inherit', fontSize: '13px', lineHeight: '20px' }
    const composerOverlay = {
      ...composerText,
      position: 'absolute',
      inset: 0,
      padding: '8px 10px',
      whiteSpace: 'pre',
      overflow: 'hidden',
      pointerEvents: 'none',
      color: 'var(--dsw-alias-label-primary)',
    }
    const composerInput = { ...composerText, flex: 1, minWidth: 0, padding: '8px 10px', border: 'none', background: 'transparent', outline: 'none', caretColor: 'var(--dsw-alias-label-primary)' }
    const placeholderText = { color: 'var(--dsw-alias-label-secondary)' }
    /** The reference color the harness editor gives an inline reference. */
    const mentionText = { color: 'var(--dsw-alias-state-business-primary)' }
    const mentionMenu = {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 'calc(100% + 6px)',
      zIndex: 20,
      maxHeight: '240px',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      padding: '3px',
      borderRadius: '16px',
      background: 'var(--dsw-specific-menu)',
      boxShadow: 'var(--dsw-elevation-prominent)',
      border: '0.5px solid var(--dsw-alias-border-l1)',
    }
    const mentionRow = {
      display: 'block',
      width: '100%',
      minHeight: '34px',
      padding: '6px 8px',
      border: 'none',
      borderRadius: '8px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
      textAlign: 'left',
      cursor: 'pointer',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    /** Dialog furniture: one card per office row, plus the shared action and status rows. */
    const dialogActions = { display: 'flex', justifyContent: 'flex-end', gap: '8px' }
    const dialogRow = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '8px 10px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-layer-1)',
      fontSize: '13px',
    }
    const dialogList = { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '4px' }
    const dialogRowName = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    const dialogTag = {
      flex: 'none',
      padding: '1px 6px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-l2)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11px',
    }
    const dialogNotice = { margin: '8px 0 0', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }
    const dialogFailure = { ...dialogNotice, color: 'var(--dsw-alias-state-error-primary)' }
    const smallButton = {
      flex: 'none',
      padding: '4px 10px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
    }
    /**
     * An open column's toggle. The brand color is the one state cue that survives both color
     * schemes, where the layer tokens for a raised surface are the same value in the light one.
     */
    const openedSmallButton = {
      ...smallButton,
      border: '1px solid var(--dsw-alias-brand-primary)',
      color: 'var(--dsw-alias-brand-primary)',
    }

    /**
     * One side column's toggle, in the panel header.
     *
     * Both columns open from here rather than from inside themselves, because a column that is
     * closed has nothing left on screen to click.
     * @param props.label - the column's name.
     * @param props.count - how many entries the column holds, or undefined before the snapshot.
     * @param props.open - whether the column is showing.
     * @param props.controls - the id of the column element this button toggles.
     * @param props.onToggle - receives the click.
     * @returns the button.
     */
    function ColumnToggle(props) {
      const { label, count, open, controls, onToggle } = props
      return h('button', {
        type: 'button',
        style: open ? openedSmallButton : smallButton,
        'aria-expanded': open,
        'aria-controls': controls,
        onClick: onToggle,
      }, `${label}${count === undefined || count === 0 ? '' : ` · ${String(count)}`}`)
    }

    /**
     * Resolve every `@name` token in one draft against the current roster.
     *
     * A token is a trigger at the draft start or after whitespace, then a colleague's exact
     * name — longest first, so a title containing a space matches whole — ending at a
     * boundary, so `@张三x` is prose rather than a mention. One derivation feeds the colored
     * text, the feed's rendering, and the wake list, so what the operator sees named is
     * exactly whom the post wakes.
     * @param text - the message body.
     * @param names - the roster's colleague names.
     * @returns the matched spans, in draft order.
     */
    function parseMentions(text, names) {
      const ordered = [...names].filter(name => typeof name === 'string' && name.length > 0)
        .sort((left, right) => right.length - left.length)
      const spans = []
      for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== '@') continue
        if (index > 0 && !/\s/.test(text[index - 1])) continue
        const rest = text.slice(index + 1)
        const found = ordered.find(name => rest.toLowerCase().startsWith(name.toLowerCase())
          && (rest.length === name.length || !/[\p{L}\p{N}_]/u.test(rest[name.length])))
        if (found === undefined) continue
        spans.push({ start: index, end: index + 1 + found.length, name: found })
        index += found.length
      }
      return spans
    }

    /**
     * The mention spans one body shows.
     *
     * The server decides who a post wakes and reports those names back with the stored
     * message, so a feed message colors only the names the server resolved: a preview that
     * over-matches can never color a colleague the post did not wake.
     * @param text - the message body.
     * @param names - the roster's colleague names.
     * @param woke - the names the server resolved for this body, when it reported them.
     * @returns the spans to color.
     */
    function mentionSpans(text, names, woke) {
      const spans = parseMentions(text, names)
      if (!Array.isArray(woke)) return spans
      const allowed = new Set(woke)
      return spans.filter(span => allowed.has(span.name))
    }

    /**
     * Render one message body with its mentions colored.
     * @param text - the stored message body.
     * @param names - the roster's colleague names.
     * @param woke - the names the server resolved for this body, when it reported them.
     * @returns React children for the body.
     */
    function renderMentions(text, names, woke) {
      const spans = mentionSpans(text, names, woke)
      if (spans.length === 0) return text
      const parts = []
      let cursor = 0
      for (const span of spans) {
        if (span.start > cursor) parts.push(text.slice(cursor, span.start))
        parts.push(h('span', { key: `m${String(span.start)}`, style: mentionText }, text.slice(span.start, span.end)))
        cursor = span.end
      }
      parts.push(text.slice(cursor))
      return parts
    }

    /**
     * The open mention token before one caret position, when the operator is typing one.
     * @param text - the composer draft.
     * @param caret - the caret offset.
     * @returns the trigger's `@` offset and the partial name typed after it, or undefined.
     */
    function openMention(text, caret) {
      for (let index = caret - 1; index >= 0; index -= 1) {
        const character = text[index]
        if (character === '@') {
          return index > 0 && !/\s/.test(text[index - 1]) ? undefined : { start: index, query: text.slice(index + 1, caret) }
        }
        if (/\s/.test(character)) return undefined
      }
      return undefined
    }

    /**
     * The public-channel composer.
     *
     * `@` opens the roster the way the harness composer opens its own trigger menu: the arrow
     * keys walk it, Enter or Tab accepts the highlighted name, Escape closes it, and the name
     * stays in the draft as colored text. The wake list is derived from those same tokens, so
     * a post wakes exactly the colleagues it names.
     */
    function Composer(props) {
      const { officeName, colleagues, userName, onPosted } = props
      // The draft is stored per office: switching offices, leaving the page, and reloading the
      // browser all keep a post that was typed but not sent.
      const [draft, setDraft] = useStoredState(`draft:${officeName}`, '')
      // A post notifies the whole office by default, matching `office_post`; unchecking it
      // narrows the wake to the colleagues the body names with `@`. The choice is the
      // operator's standing preference, so it is remembered across offices and reloads.
      const [wakeAll, setWakeAll] = useStoredState('wakeAll', true)
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(undefined)
      const [trigger, setTrigger] = useState(undefined)
      const [active, setActive] = useState(0)
      const [focused, setFocused] = useState(false)
      const [composing, setComposing] = useState(false)
      const inputRef = useRef(null)
      const overlayRef = useRef(null)
      /** Caret position to restore after an accepted mention rewrites the draft. */
      const caretRef = useRef(undefined)

      const names = [...colleagues.map(colleague => colleague.name), userName]
        .filter(name => typeof name === 'string' && name.length > 0)
      const spans = parseMentions(draft, names)
      const candidates = trigger === undefined
        ? []
        : names.filter(name => name.toLowerCase().includes(trigger.query.toLowerCase())).slice(0, 8)
      const highlighted = candidates.length === 0 ? 0 : Math.min(active, candidates.length - 1)

      useEffect(() => {
        const caret = caretRef.current
        if (caret === undefined || inputRef.current === null) return
        caretRef.current = undefined
        inputRef.current.setSelectionRange(caret, caret)
        if (overlayRef.current !== null) overlayRef.current.scrollLeft = inputRef.current.scrollLeft
      }, [draft])

      const change = (event) => {
        const next = event.target.value
        setDraft(next)
        // An input-method composition owns the text until it commits; opening the roster on a
        // half-composed name would offer candidates for a string the operator cannot see yet.
        setTrigger(composing ? undefined : openMention(next, event.target.selectionStart ?? next.length))
        setActive(0)
      }

      const accept = (name) => {
        if (trigger === undefined) return
        const head = draft.slice(0, trigger.start)
        const inserted = `@${name} `
        caretRef.current = head.length + inserted.length
        setDraft(`${head}${inserted}${draft.slice(trigger.start + 1 + trigger.query.length)}`)
        setTrigger(undefined)
        setActive(0)
      }

      const key = (event) => {
        if (composing || trigger === undefined) return
        if (event.key === 'ArrowDown' && candidates.length > 0) {
          event.preventDefault()
          setActive((highlighted + 1) % candidates.length)
          return
        }
        if (event.key === 'ArrowUp' && candidates.length > 0) {
          event.preventDefault()
          setActive((highlighted - 1 + candidates.length) % candidates.length)
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          // The menu owns Enter while it is open: accepting a name must not post the draft.
          event.preventDefault()
          if (candidates.length > 0) accept(candidates[highlighted])
          else setTrigger(undefined)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setTrigger(undefined)
        }
      }

      const submit = async (event) => {
        event.preventDefault()
        const text = draft.trim()
        if (text.length === 0 || busy) return
        setBusy(true)
        try {
          // Only the body is sent: the server derives the audience from the names written in
          // it, so what the composer colors and whom the post wakes are the same set.
          await submitJson(officeRoute('post', officeName), { text, mention_all: wakeAll })
          setDraft('')
          setTrigger(undefined)
          setFailure(undefined)
          await onPosted()
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const segments = []
      let cursor = 0
      for (const span of spans) {
        if (span.start > cursor) segments.push(draft.slice(cursor, span.start))
        segments.push(h('span', { key: `m${String(span.start)}`, style: mentionText }, draft.slice(span.start, span.end)))
        cursor = span.end
      }
      segments.push(draft.slice(cursor))

      return h('form', { style: composerRow, onSubmit: submit },
        h('div', { style: { ...composerField, borderColor: focused ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)' } },
          h('input', {
            ref: inputRef,
            style: { ...composerInput, color: composing ? 'var(--dsw-alias-label-primary)' : 'transparent' },
            value: draft,
            'aria-label': 'Post to general',
            onChange: change,
            onKeyDown: key,
            onFocus: () => { setFocused(true) },
            onBlur: () => { setFocused(false); setTrigger(undefined) },
            onScroll: event => { if (overlayRef.current !== null) overlayRef.current.scrollLeft = event.target.scrollLeft },
            onCompositionStart: () => { setComposing(true) },
            onCompositionEnd: () => { setComposing(false) },
          }),
          // Above the input, not behind it: the caret and the selection band belong to the
          // input, and the colored text has to stay legible over both.
          h('div', {
            ref: overlayRef,
            style: { ...composerOverlay, zIndex: 1, visibility: composing ? 'hidden' : 'visible' },
            'aria-hidden': true,
          }, draft.length === 0
            ? h('span', { style: placeholderText }, `Post to ${officeName} #general — type @ to wake a colleague`)
            : segments),
          trigger === undefined || candidates.length === 0 ? null : h('div', { style: mentionMenu, role: 'listbox' },
            candidates.map((name, index) => h('button', {
              key: name,
              type: 'button',
              role: 'option',
              'aria-selected': index === highlighted,
              style: index === highlighted
                ? { ...mentionRow, background: 'var(--dsw-alias-interactive-bg-hover)' }
                : mentionRow,
              onMouseDown: (event) => { event.preventDefault(); accept(name) },
            }, name))),
        ),
        h('label', { style: toggle, title: 'Uncheck to wake only the colleagues the message names with @' },
          h('input', {
            type: 'checkbox',
            checked: wakeAll,
            onChange: event => setWakeAll(event.target.checked),
          }),
          'Wake everyone',
        ),
        h('button', { style: button, type: 'submit', disabled: busy }, busy ? 'Posting…' : 'Post'),
      )
    }

    /** Fetch JSON from one office route and surface its error field. */
    async function requestJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `${response.status} ${response.statusText}`)
      return payload
    }

    /** POST one JSON body to an office route and surface its error field. */
    async function submitJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(payload?.error ?? `${response.status}`)
      return payload
    }

    /**
     * Every office mounted in this Host, as `{ id, name }`, oldest mount first.
     *
     * An empty list is a real answer, not a failure: the host row serves this route and
     * outlives every office, so the panel can list nothing and still create the first one.
     * Only a dropped request keeps the previous list, because a failed refresh must not
     * blank a list that already resolved.
     * @returns the office list, a reload callback, and a reader that reports the fresh list.
     */
    function useOffices() {
      const [offices, setOffices] = useState([])
      /** Fetch and publish the list; rejects so a caller can tell a failure from an answer. */
      const read = useCallback(async () => {
        const payload = await requestJson(OFFICES_ROUTE)
        const next = (payload?.offices ?? [])
          .filter(office => typeof office?.name === 'string' && office.name.length > 0)
          .map(office => ({
            id: typeof office.id === 'string' && office.id.length > 0 ? office.id : office.name,
            name: office.name,
          }))
        setOffices(next)
        return next
      }, [])
      const reloadOffices = useCallback(async () => {
        try {
          await read()
        } catch {
          // Keep the previous list; the panel is still usable while the host restarts.
        }
      }, [read])
      useEffect(() => {
        void reloadOffices()
        const timer = setInterval(() => { void reloadOffices() }, POLL_MS)
        return () => { clearInterval(timer) }
      }, [reloadOffices])
      return { offices, reloadOffices, read }
    }

    /**
     * One panel feed: the newest page from the snapshot, plus the older pages a reader unfolded.
     *
     * The snapshot polls every few seconds and carries only the newest messages, so the unfolded
     * pages live beside it rather than in it: a poll replaces the newest page and never discards
     * what the reader opened. The server owns the page size, so the request carries no limit —
     * the host's own ceiling is what one unfold costs.
     * @param props.officeName - the office the feed belongs to.
     * @param props.channel - `general` or `mailbox`.
     * @param props.newest - the newest page, from the snapshot.
     * @param props.total - how many messages the channel holds in all, from the snapshot.
     * @returns the combined messages, how many are still folded, the loader, and its failure.
     */
    function useFeedHistory({ officeName, channel, newest, total }) {
      const [older, setOlder] = useState([])
      const [failure, setFailure] = useState(undefined)
      const loading = useRef(false)
      const previousTotal = useRef(undefined)
      const oldest = older.at(0)?.seq ?? newest.at(0)?.seq

      // Another office, or another channel of the same one, invalidates what was unfolded: the
      // page is a range of one channel's sequence numbers.
      useEffect(() => {
        setOlder([])
        setFailure(undefined)
      }, [officeName, channel])

      // A channel that shrank lost messages the reader had unfolded — a compacted range replaces
      // them with one summary — so the whole page is dropped rather than shown above messages that
      // no longer exist. Which of them went is not knowable here; one click unfolds what remains.
      useEffect(() => {
        const shrank = previousTotal.current !== undefined && total < previousTotal.current
        previousTotal.current = total
        if (shrank) setOlder([])
      }, [total])

      const load = useCallback(async () => {
        if (loading.current || oldest === undefined) return
        loading.current = true
        try {
          const page = await requestJson(`${officeRoute('history', officeName)}&channel=${channel}&before=${oldest}`)
          setOlder(current => [...(page?.messages ?? []), ...current])
          setFailure(undefined)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          loading.current = false
        }
      }, [officeName, channel, oldest])

      const messages = [...older, ...newest]
      return { messages, folded: Math.max(0, total - messages.length), load, failure }
    }

    /**
     * The row that keeps an old channel from pushing the newest message off the screen.
     *
     * A feed renders the newest page and folds everything older behind this one row, the way the
     * conversation view folds the history it has not loaded: one click opens the next page in
     * place, and the row stays while anything older remains.
     * @param props.folded - how many messages the feed is not showing.
     * @param props.onUnfold - loads the next older page.
     * @returns the row, or null when the feed is complete.
     */
    function FoldedRow(props) {
      const { folded, onUnfold } = props
      if (folded <= 0) return null
      return h('div', { style: foldedRow },
        h('button', { type: 'button', style: smallButton, onClick: onUnfold },
          `${String(folded)} earlier ${folded === 1 ? 'message' : 'messages'}`))
    }

    /**
     * One message as a feed draws it, shared by the public channel and the mailbox.
     * @param message - one message, from the snapshot or from an unfolded page.
     * @param colleagues - the roster, whose names are the mention candidates besides the user.
     * @param userName - the user's name, which a body may also address.
     * @returns the rendered message.
     */
    function messageNode(message, colleagues, userName) {
      const names = [...colleagues.map(colleague => colleague.name), userName]
        .filter(name => typeof name === 'string')
      return h('div', {
        key: message.messageId,
        style: message.kind === 'summary' ? summaryBubble : bubble,
      },
      h('div', { style: bubbleHead }, message.kind === 'summary'
        ? `Summary of ${String(message.covers[0])}–${String(message.covers[1])} by ${message.senderName} · ${new Date(message.createdAt).toLocaleString()}`
        : `${message.senderName} · ${new Date(message.createdAt).toLocaleString()}`
          + `${message.origin === undefined ? '' : ` · also in #${message.origin.channelId} as ${message.origin.messageId}`}`),
      h('div', null, renderMentions(message.text, names, message.mentions)),
      )
    }

    /**
     * One office's snapshot: colleagues, channels, newest public messages, hire options.
     *
     * The panel owns this, not the view, because the hire dialog needs the same snapshot and
     * two pollers would double every request.
     * @param officeName - the office to read, or undefined while none is mounted.
     * @returns the snapshot, its error, and a refresh callback.
     */
    function useOffice(officeName) {
      const [snapshot, setSnapshot] = useState(undefined)
      const [error, setError] = useState(undefined)
      useEffect(() => { setSnapshot(undefined); setError(undefined) }, [officeName])
      const refresh = useCallback(async () => {
        if (officeName === undefined) return
        try {
          setSnapshot(await requestJson(officeRoute('state', officeName)))
          setError(undefined)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [officeName])
      useEffect(() => {
        void refresh()
        const timer = setInterval(() => { void refresh() }, POLL_MS)
        return () => { clearInterval(timer) }
      }, [refresh])
      return { snapshot, error, refresh }
    }

    /**
     * The hire dialog: name, role, description, workspace, preset, and an optional model route.
     *
     * Hiring is a deliberate act with several choices, so it lives in a dialog rather than in
     * the rail, which keeps the roster visible while the choice is made. The dialog stays open
     * with its error while a hire is refused, and closes only once the colleague exists.
     */
    function HireDialog(props) {
      const { open, onClose, officeName, snapshot, onHired } = props
      const [name, setName] = useState('')
      const [role, setRole] = useState(DEFAULT_ROLE)
      const [description, setDescription] = useState('')
      const [workspaceId, setWorkspaceId] = useState('')
      const [presetId, setPresetId] = useState('')
      const [route, setRoute] = useState('')
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(undefined)

      const roles = snapshot?.roles ?? FALLBACK_ROLES
      const workspaces = snapshot?.workspaces ?? []
      const presets = snapshot?.presets ?? []
      const models = snapshot?.models ?? []

      const hire = async () => {
        const trimmed = name.trim()
        if (trimmed.length === 0 || busy) return
        setBusy(true)
        try {
          const [provider, model] = route.split(ROUTE_SEPARATOR)
          await submitJson(officeRoute('hire', officeName), {
            name: trimmed,
            role,
            ...(description.trim().length === 0 ? {} : { description: description.trim() }),
            ...(workspaceId === '' ? {} : { workspace_id: workspaceId }),
            ...(presetId === '' ? {} : { agent_preset: presetId }),
            ...(provider === undefined || model === undefined ? {} : { provider, model }),
          })
          setName('')
          setRole(DEFAULT_ROLE)
          setDescription('')
          setFailure(undefined)
          await onHired()
          onClose()
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const enter = (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        void hire()
      }

      return h(Modal, {
        open,
        onClose,
        title: `Hire a colleague into ${officeName}`,
        closeLabel: 'Close',
        description: 'A colleague is an ordinary session, titled with the name below and added to the roster. '
          + 'Its role decides the office tools it holds and the session permission it runs under.',
        footer: h('div', { style: dialogActions },
          h('button', { type: 'button', style: smallButton, onClick: onClose }, 'Cancel'),
          h('button', { type: 'button', style: button, disabled: busy, onClick: () => { void hire() } }, busy ? 'Hiring…' : 'Hire')),
      },
      h('input', {
        style: field,
        value: name,
        placeholder: 'Session title',
        'aria-label': 'New colleague session title',
        onChange: event => setName(event.target.value),
        onKeyDown: enter,
      }),
      colleagueFields({ roles, role, onRole: setRole, description, onDescription: setDescription, onEnter: enter }),
      h('select', {
        style: field,
        value: workspaceId,
        'aria-label': 'Workspace',
        onChange: event => setWorkspaceId(event.target.value),
      },
      h('option', { value: '' }, 'Default workspace'),
      workspaces.map(workspace => h('option', { key: workspace.id, value: workspace.id }, workspace.title))),
      h('select', {
        style: field,
        value: presetId,
        'aria-label': 'Agent preset',
        onChange: event => setPresetId(event.target.value),
      },
      h('option', { value: '' }, 'Default preset'),
      presets.map(preset => h('option', { key: preset.id, value: preset.id }, preset.name))),
      h('select', {
        style: field,
        value: route,
        'aria-label': 'Model',
        onChange: event => setRoute(event.target.value),
      },
      h('option', { value: '' }, 'Default model'),
      models.map(entry => h(
        'option',
        {
          key: `${entry.provider}${ROUTE_SEPARATOR}${entry.model}`,
          value: `${entry.provider}${ROUTE_SEPARATOR}${entry.model}`,
        },
        entry.name,
      ))),
      failure === undefined ? null : h('p', { style: dialogFailure }, failure))
    }

    /**
     * The colleague dialog: the role and the description of one colleague already on the roster.
     *
     * The two fields are the ones the office lets a boss or a leader change without touching the
     * colleague's membership, so this is how the user sets them from the panel. It opens on what
     * the colleague is now, stays open with its error while the office refuses the change, and
     * closes only once the office accepted it.
     */
    function ColleagueDialog(props) {
      const { open, onClose, officeName, colleague, snapshot, onSaved } = props
      const [role, setRole] = useState(DEFAULT_ROLE)
      const [description, setDescription] = useState('')
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(undefined)

      const roles = snapshot?.roles ?? FALLBACK_ROLES
      const sessionId = colleague?.sessionId

      // Seed the fields from the colleague the dialog was opened on, not from the polled snapshot:
      // a roster refresh while the dialog is open must not type over what the user chose.
      useEffect(() => {
        if (!open) return
        setRole(colleague?.role ?? DEFAULT_ROLE)
        setDescription(colleague?.description ?? '')
        setFailure(undefined)
      }, [open, sessionId])

      const save = async () => {
        if (busy) return
        setBusy(true)
        try {
          await submitJson(officeRoute('configure', officeName), {
            name: colleague.name,
            role,
            description: description.trim(),
          })
          setFailure(undefined)
          await onSaved()
          onClose()
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const enter = (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        void save()
      }

      return h(Modal, {
        open,
        onClose,
        title: `Edit ${colleague?.name ?? 'colleague'}`,
        closeLabel: 'Close',
        description: 'The role decides the office tools this colleague holds and the session permission '
          + 'the office row maps that role to. An empty description removes it.',
        footer: h('div', { style: dialogActions },
          h('button', { type: 'button', style: smallButton, onClick: onClose }, 'Cancel'),
          h('button', { type: 'button', style: button, disabled: busy, onClick: () => { void save() } }, busy ? 'Saving…' : 'Save')),
      },
      colleagueFields({ roles, role, onRole: setRole, description, onDescription: setDescription, onEnter: enter }),
      failure === undefined ? null : h('p', { style: dialogFailure }, failure))
    }

    /**
     * The Offices dialog: add, rename, and remove offices without leaving the panel.
     *
     * Every edit here writes the profile patch, and the Loader is what mounts or unmounts the
     * row afterwards — so each edit waits for the mounted list to show the result, and reports
     * a Loader that did not catch up instead of leaving the panel showing a list that is wrong.
     * Renaming and deleting happen on the row itself, so no dialog opens on top of a dialog.
     */
    function OfficesDialog(props) {
      const { open, onClose, offices, active, onSelect, settle } = props
      const [draft, setDraft] = useState('')
      const [renaming, setRenaming] = useState(undefined)
      const [confirming, setConfirming] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState(undefined)
      const [failure, setFailure] = useState(undefined)

      /**
       * Run one edit and wait for the mounted list to catch up.
       * @param request - the route call that writes the patch.
       * @param expect - which name must appear, disappear, or neither.
       * @param waiting - what the dialog says while the Loader applies the write.
       * @returns whether the list reached the expected state.
       */
      const run = async (request, expect, waiting) => {
        setBusy(true)
        setFailure(undefined)
        setStatus(waiting)
        try {
          await request()
          const settled = await settle(expect)
          setStatus(undefined)
          if (!settled) {
            setFailure('The profile patch was written, but the running Host has not reported the change yet, so '
              + 'this list may be stale. An added or removed office mounts when the profile reloads; check the '
              + 'Host log for a reconcile warning if it never does.')
          }
          return settled
        } catch (error) {
          setStatus(undefined)
          setFailure(error instanceof Error ? error.message : String(error))
          return false
        } finally {
          setBusy(false)
        }
      }

      const create = async () => {
        const name = draft.trim()
        if (name.length === 0 || busy) return
        if (await run(() => submitJson(CREATE_OFFICE_ROUTE, { name }), { present: name }, `Adding ${name}…`)) {
          setDraft('')
          onSelect(name)
        }
      }

      const rename = async (office) => {
        const next = (renaming?.value ?? '').trim()
        if (next.length === 0 || next === office || busy) { setRenaming(undefined); return }
        if (await run(() => submitJson(RENAME_OFFICE_ROUTE, { office, name: next }), {}, `Renaming ${office}…`)) {
          setRenaming(undefined)
          if (active === office) onSelect(next)
        }
      }

      const remove = async (office) => {
        if (await run(() => submitJson(DELETE_OFFICE_ROUTE, { office }), { absent: office }, `Removing ${office}…`)) {
          setConfirming(undefined)
          if (active === office) onSelect(undefined)
        }
      }

      const row = (office) => {
        if (renaming !== undefined && renaming.office === office.name) {
          return h('div', { key: office.id, style: dialogRow },
            h('input', {
              style: { ...field, marginBottom: 0, flex: 1 },
              value: renaming.value,
              'aria-label': `New name for ${office.name}`,
              autoFocus: true,
              onChange: event => setRenaming({ office: office.name, value: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Enter') { event.preventDefault(); void rename(office.name) }
                if (event.key === 'Escape') { event.preventDefault(); setRenaming(undefined) }
              },
            }),
            h('button', { type: 'button', style: smallButton, disabled: busy, onClick: () => { void rename(office.name) } }, 'Save'),
            h('button', { type: 'button', style: smallButton, disabled: busy, onClick: () => { setRenaming(undefined) } }, 'Cancel'))
        }
        if (confirming === office.name) {
          return h('div', { key: office.id, style: dialogRow },
            h('span', { style: dialogRowName },
              `Delete ${office.name}? Its colleagues, channels, and every message go with it.`),
            h('button', {
              type: 'button',
              style: { ...smallButton, color: 'var(--dsw-alias-state-error-primary)' },
              disabled: busy,
              onClick: () => { void remove(office.name) },
            }, 'Delete'),
            h('button', { type: 'button', style: smallButton, disabled: busy, onClick: () => { setConfirming(undefined) } }, 'Cancel'))
        }
        return h('div', { key: office.id, style: dialogRow },
          h('span', { style: dialogRowName }, office.name),
          office.name === active ? h('span', { style: dialogTag }, 'shown') : null,
          h('button', {
            type: 'button',
            style: smallButton,
            disabled: busy,
            onClick: () => { setConfirming(undefined); setRenaming({ office: office.name, value: office.name }) },
          }, 'Rename'),
          h('button', {
            type: 'button',
            style: { ...smallButton, color: 'var(--dsw-alias-state-error-primary)' },
            disabled: busy,
            onClick: () => { setRenaming(undefined); setConfirming(office.name) },
          }, 'Delete'))
      }

      return h(Modal, {
        open,
        onClose,
        title: 'Offices',
        closeLabel: 'Close',
        description: 'Each office keeps its own storage, roster, and channel. Adding one writes a row into this '
          + 'profile, and the Loader mounts it a moment later.',
        footer: h('div', { style: dialogActions },
          h('button', { type: 'button', style: smallButton, onClick: onClose }, 'Done')),
      },
      h('div', { style: dialogList },
        offices.length === 0
          ? h('p', { style: muted }, 'No office is mounted. Add one below.')
          : offices.map(row)),
      h('div', { style: { ...dialogRow, marginTop: '10px' } },
        h('input', {
          style: { ...field, marginBottom: 0, flex: 1 },
          value: draft,
          placeholder: 'New office name',
          'aria-label': 'New office name',
          onChange: event => setDraft(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void create() } },
        }),
        h('button', { type: 'button', style: smallButton, disabled: busy, onClick: () => { void create() } }, 'Add')),
      status === undefined ? null : h('p', { style: dialogNotice }, status),
      failure === undefined ? null : h('p', { style: dialogFailure }, failure))
    }

    /**
     * The office switcher: a dropdown of every mounted office, matching the composer's
     * own select controls (an anchor button plus the shared Menu).
     */
    function OfficeSwitcher(props) {
      const { offices, active, onSelect } = props
      const [open, setOpen] = useState(false)
      const items = offices.map(office => ({ id: office.name, label: office.name }))

      return h(Menu, {
        open,
        items,
        selectedId: active,
        onSelect: (id) => { onSelect(id); setOpen(false) },
        onClose: () => { setOpen(false) },
        side: 'bottom',
        align: 'start',
        anchor: h(Button, {
          variant: 'outline',
          size: 'sm',
          'aria-label': `Office: ${active ?? 'none'}`,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          disabled: offices.length === 0,
          onClick: () => { setOpen(!open) },
        },
        h('span', { style: switcherLabel }, active ?? 'No office'),
        h('span', { style: switcherChevron, 'aria-hidden': true }, h(IconChevronDownOutlineRegular))),
      })
    }

    /**
     * The panel with no office mounted.
     *
     * This state is reachable on purpose — deleting the last office lands here — so it
     * explains itself and offers the one action that resolves it, rather than reporting a
     * failure to reach an office that does not exist.
     */
    function OfficeEmptyState(props) {
      return h('div', { style: emptyState },
        h('h2', { style: emptyTitle }, 'No office yet'),
        h('p', { style: emptyBody },
          'An office holds a roster, channels, and messages. Create one, or declare another '
          + '`dsh-office` row with an `officeName` to mount one at startup.'),
        h('button', { type: 'button', style: button, onClick: props.onManage }, 'New office'),
      )
    }

    /**
     * One office: its roster rail, its public channel, and — when opened — the mailbox sidebar.
     *
     * Both side columns are opened from the panel header, which the panel owns, so whether each
     * is open arrives here as a prop instead of living in this view: this view is keyed by office,
     * and the choices are meant to outlive a switch between offices.
     */
    function OfficeView(props) {
      const {
        officeName, snapshot, error, refresh, onEdit, railShown, mailboxShown,
        onToggleRail, onToggleMailbox,
      } = props
      const [postError, setPostError] = useState(undefined)
      const [pendingDismiss, setPendingDismiss] = useState(undefined)
      const feedRef = useRef(null)
      /** This mount's follow intent, which outlives every re-render and every poll. */
      const followRef = useRef(null)
      /** The pending reader sample, which also marks reader input as not yet settled. */
      const sampleTimerRef = useRef(null)
      /** Whether this mount has already put the saved position, or the tail, back. */
      const restoredRef = useRef(false)
      /** The feed's last content height, which is how a prepend is told from a reader's scroll. */
      const heightRef = useRef(undefined)
      const scrollKey = `feed:${officeName}`
      if (followRef.current === null) {
        // A feed with no stored position has never been scrolled away from the tail, so it starts
        // following the newest message — the same default the conversation view uses.
        const saved = panelState.get(scrollKey, undefined)
        followRef.current = new FeedFollow(saved === undefined || saved === null, FEED_FOLLOW_THRESHOLD)
      }

      /** Two-step removal: the first click arms the button, the second performs it. */
      const removeColleague = async (name) => {
        if (pendingDismiss !== name) {
          setPendingDismiss(name)
          setPostError(undefined)
          return
        }
        setPendingDismiss(undefined)
        try {
          await submitJson(officeRoute('dismiss', officeName), { name })
          await refresh()
        } catch (failure) {
          setPostError(failure instanceof Error ? failure.message : String(failure))
        }
      }

      const colleagues = snapshot?.colleagues ?? []
      const userName = snapshot?.user?.name
      const mailboxTotal = snapshot?.mailboxTotal ?? 0
      const general = useFeedHistory({
        officeName,
        channel: 'general',
        newest: snapshot?.messages ?? [],
        total: snapshot?.messagesTotal ?? 0,
      })
      const mailbox = useFeedHistory({
        officeName,
        channel: 'mailbox',
        newest: snapshot?.mailbox ?? [],
        total: mailboxTotal,
      })
      const messages = general.messages
      /** The sidebar's own scrollport, and whether new mail should keep it at the newest message. */
      const mailboxRef = useRef(null)
      const mailboxFollowRef = useRef(true)

      /**
       * Write what the reader is doing: following the tail, or reading at this offset.
       *
       * Following the tail is stored as `null` rather than as an offset, so it keeps meaning "the
       * newest message" after the channel grows; the conversation view stores it the same way.
       */
      const rememberPosition = useCallback((node) => {
        panelState.set(scrollKey, followRef.current.following ? null : node.scrollTop)
      }, [scrollKey])

      /**
       * Read the settled position into follow intent and store it.
       *
       * This runs while the reader is still on the page, never when the panel goes away: React
       * removes the feed from the document before it runs this component's cleanup, and a detached
       * element reports `scrollTop` 0, so reading it there would store a position meaning "top".
       */
      const sampleFeed = useCallback(() => {
        sampleTimerRef.current = null
        const node = feedRef.current
        if (node === null) return
        followRef.current.sample(followRef.current.metrics(node))
        rememberPosition(node)
      }, [rememberPosition])

      // One drag delivers many scroll events, and following the tail mid-drag would fight the
      // drag. Reader input is therefore sampled once the movement has settled.
      const onFeedScroll = useCallback(() => {
        if (sampleTimerRef.current !== null) window.clearTimeout(sampleTimerRef.current)
        sampleTimerRef.current = window.setTimeout(sampleFeed, FEED_SAMPLE_MS)
      }, [sampleFeed])

      useEffect(() => {
        // A browser that reports `scrollend` settles the sample immediately; one that does not
        // falls back to the timer alone.
        const node = feedRef.current
        if (node === null) return undefined
        node.addEventListener('scrollend', sampleFeed)
        return () => {
          node.removeEventListener('scrollend', sampleFeed)
          if (sampleTimerRef.current !== null) window.clearTimeout(sampleTimerRef.current)
        }
      }, [sampleFeed])

      // Put the saved position back once the channel has messages to scroll, then keep the newest
      // message in view whenever the feed changes while the reader is following it.
      useEffect(() => {
        const node = feedRef.current
        if (node === null || messages.length === 0) return
        const follow = followRef.current
        if (!restoredRef.current) {
          restoredRef.current = true
          const saved = panelState.get(scrollKey, undefined)
          if (typeof saved === 'number') follow.jump(node, follow.metrics(node), saved)
          else follow.toBottom(node, follow.metrics(node))
          rememberPosition(node)
          return
        }
        // Unsettled reader input owns the feed: a message that arrives mid-scroll must not pull it.
        if (sampleTimerRef.current !== null) return
        if (follow.following) follow.toBottom(node, follow.metrics(node))
      }, [scrollKey, snapshot, messages.length, mailboxShown, rememberPosition])

      /**
       * Hold the reader's place while the feed's content height changes.
       *
       * Unfolding older messages grows the feed upward, and a poll can append, prepend, or shrink
       * it; by scroll offset alone the reader would be dragged to different content each time. A
       * reader who is following the tail is handled above, and reader input that has not settled
       * owns the feed, so this only moves the offset by the height the content gained or lost.
       * Opening or closing the sidebar rewraps the channel at a new width, which is the same
       * problem from the side rather than from above, so the toggle is a dependency too.
       */
      useEffect(() => {
        const node = feedRef.current
        if (node === null) return
        const previous = heightRef.current
        heightRef.current = node.scrollHeight
        if (previous === undefined || followRef.current.following) return
        if (sampleTimerRef.current !== null) return
        node.scrollTop += node.scrollHeight - previous
        rememberPosition(node)
      }, [messages.length, snapshot, mailboxShown, rememberPosition])

      /**
       * Keep the mailbox at its newest message while the reader has not scrolled away from it.
       *
       * A sidebar the operator is not watching must still show what arrived: it opens at the tail
       * and a poll that appends follows it, while a reader who scrolled up keeps the place they
       * chose. It has no stored position, unlike the channel, because it is a place to look rather
       * than the record being read.
       */
      const onMailboxScroll = useCallback(() => {
        const node = mailboxRef.current
        if (node === null) return
        mailboxFollowRef.current = node.scrollHeight - node.clientHeight - node.scrollTop
          <= FEED_FOLLOW_THRESHOLD
      }, [])

      useEffect(() => {
        const node = mailboxRef.current
        if (node === null || !mailboxFollowRef.current) return
        node.scrollTop = node.scrollHeight
      }, [mailbox.messages.length])

      return h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        error === undefined ? null : h('p', { style: notice }, `Cannot reach office "${officeName}": ${error}`),
        h('div', { style: body },
          railShown
            ? h('div', { id: RAIL_PANEL_ID, style: rail },
              h('div', { style: sideHead },
                h('span', { style: columnTitle }, 'Colleagues'),
                h('button', {
                  type: 'button',
                  style: columnClose,
                  title: 'Close the roster',
                  'aria-label': 'Close the roster',
                  onClick: onToggleRail,
                }, '✕'),
              ),
              h('div', { style: railBody },
                colleagues.length === 0
                  ? h('p', { style: muted }, 'None yet. Use “Hire a colleague” above.')
                  : colleagues.map(colleague => h('div', { key: colleague.sessionId, style: person },
                    h('div', { style: personHead },
                      h('div', { style: personName }, colleague.name),
                      h('button', {
                        type: 'button',
                        style: dismissButton,
                        title: "Change this colleague's role and description",
                        onClick: () => { onEdit(colleague) },
                      }, 'Edit'),
                      h('button', {
                        type: 'button',
                        style: dismissButton,
                        title: 'Remove from the roster; the session itself is kept',
                        onClick: () => { void removeColleague(colleague.name) },
                      }, pendingDismiss === colleague.name ? 'Confirm' : 'Dismiss'),
                    ),
                    h('div', { style: muted },
                      `${colleague.role ?? 'member'} · ${colleague.status ?? 'unknown'}`
                      + `${colleague.permission === undefined ? '' : ` · ${colleague.permission}`}`
                      + `${colleague.pending === undefined || colleague.pending === 0
                        ? ''
                        : ` · ${String(colleague.pending)} held`}`),
                    colleague.description === undefined
                      ? null
                      : h('div', { style: personNote }, colleague.description),
                  )),
              ),
            )
            : null,
          h('div', { style: channel },
            h('div', { style: columnHead }, '#general'),
            h('div', { ref: feedRef, style: feed, onScroll: onFeedScroll, 'data-channel': 'general' },
              h(FoldedRow, { folded: general.folded, onUnfold: () => { void general.load() } }),
              messages.length === 0
                ? h('p', { style: muted }, '#general has no messages yet.')
                : messages.map(message => messageNode(message, colleagues, userName)),
            ),
            postError === undefined && general.failure === undefined
              ? null
              : h('p', { style: notice }, postError ?? general.failure),
            h(Composer, { officeName, colleagues, userName, onPosted: refresh }),
          ),
          mailboxShown
            ? h('div', { id: MAILBOX_PANEL_ID, style: mailboxSide },
              h('div', { style: sideHead },
                h('span', { style: columnTitle },
                  userName === undefined ? 'Mailbox' : `Mailbox · @${userName}`),
                h('button', {
                  type: 'button',
                  style: columnClose,
                  title: 'Close the mailbox',
                  'aria-label': 'Close the mailbox',
                  onClick: onToggleMailbox,
                }, '✕'),
              ),
              h('div', {
                ref: mailboxRef,
                style: mailboxFeed,
                onScroll: onMailboxScroll,
                'data-channel': 'mailbox',
              },
                h(FoldedRow, { folded: mailbox.folded, onUnfold: () => { void mailbox.load() } }),
                mailbox.messages.length === 0
                  ? h('p', { style: muted }, 'No message has been addressed to the user yet.')
                  : mailbox.messages.map(message => messageNode(message, colleagues, userName)),
              ),
              mailbox.failure === undefined ? null : h('p', { style: notice }, mailbox.failure),
            )
            : null,
        ),
      )
    }

    function OfficePanel() {
      const { offices, reloadOffices, read } = useOffices()
      // Which office the page shows is part of the panel's state, not of one visit: reopening
      // the page returns to the office the operator was working in.
      const [selected, setSelected] = useStoredState('office', undefined)
      const [dialog, setDialog] = useState(undefined)
      /** The colleague the edit dialog was opened on, or undefined while it is closed. */
      const [editing, setEditing] = useState(undefined)
      const active = offices.some(office => office.name === selected) ? selected : offices[0]?.name
      const { snapshot, error, refresh } = useOffice(active)
      // Which side columns are open is a standing preference, like the draft and the office being
      // read. The roster starts open because it is the office's state at a glance; the mailbox
      // starts closed because it is a place to look when its count on the toggle says to.
      const [railShown, setRailShown] = useStoredState(RAIL_STATE_KEY, true)
      const [mailboxShown, setMailboxShown] = useStoredState(MAILBOX_STATE_KEY, false)

      /**
       * Wait until the mounted list shows what an office edit just asked for.
       *
       * The management routes write the profile patch and the Loader applies it afterwards, so
       * an added office appears — and a removed one goes — a moment after the request resolves.
       * Waiting is what keeps the panel from showing a list that is already wrong, and a
       * timeout is reported instead of hidden.
       * @param expect - the name that must be present or absent.
       * @returns whether the list reached that state before the timeout.
       */
      const settle = useCallback(async (expect) => {
        const deadline = Date.now() + SETTLE_TIMEOUT_MS
        for (;;) {
          let next
          try {
            next = await read()
          } catch {
            next = undefined
          }
          if (next !== undefined
            && (expect.present === undefined || next.some(office => office.name === expect.present))
            && (expect.absent === undefined || !next.some(office => office.name === expect.absent))) return true
          if (Date.now() >= deadline) return false
          await new Promise(resolve => { setTimeout(resolve, POLL_MS) })
        }
      }, [read])

      // The edit dialog belongs to one colleague of one office, so switching offices closes it:
      // its route takes the active office, and a colleague that office does not hold would be a
      // refusal the user did not ask for.
      useEffect(() => { setEditing(undefined) }, [active])

      return h('div', { style: page },
        h('div', { style: header },
          h('h1', { style: title }, 'Office'),
          h(OfficeSwitcher, { offices, active, onSelect: setSelected }),
          h('div', { style: headerForms },
            active === undefined
              ? null
              : h(React.Fragment, null,
                h(ColumnToggle, {
                  label: 'Colleagues',
                  count: snapshot?.colleagues?.length,
                  open: railShown,
                  controls: RAIL_PANEL_ID,
                  onToggle: () => { setRailShown(current => !current) },
                }),
                h(ColumnToggle, {
                  label: 'Mailbox',
                  count: snapshot?.mailboxTotal,
                  open: mailboxShown,
                  controls: MAILBOX_PANEL_ID,
                  onToggle: () => { setMailboxShown(current => !current) },
                }),
                h('button', {
                  type: 'button',
                  style: smallButton,
                  onClick: () => { setDialog('hire') },
                }, 'Hire a colleague'),
              ),
            h('button', {
              type: 'button',
              style: smallButton,
              onClick: () => { setDialog('offices') },
            }, 'Offices'),
          ),
        ),
        offices.length === 0
          ? h(OfficeEmptyState, { onManage: () => { setDialog('offices') } })
          : h(OfficeView, {
            key: active,
            officeName: active,
            snapshot,
            error,
            refresh,
            onEdit: setEditing,
            railShown,
            mailboxShown,
            onToggleRail: () => { setRailShown(false) },
            onToggleMailbox: () => { setMailboxShown(false) },
          }),
        offices.length === 0
          ? null
          : h(HireDialog, {
            open: dialog === 'hire',
            onClose: () => { setDialog(undefined) },
            officeName: active,
            snapshot,
            onHired: refresh,
          }),
        offices.length === 0
          ? null
          : h(ColleagueDialog, {
            open: editing !== undefined,
            onClose: () => { setEditing(undefined) },
            officeName: active,
            colleague: editing,
            snapshot,
            onSaved: refresh,
          }),
        h(OfficesDialog, {
          open: dialog === 'offices',
          onClose: () => { setDialog(undefined) },
          offices,
          active,
          onSelect: setSelected,
          settle,
        }),
      )
    }
    /** Sidebar panel icon; the sidebar supplies `size` and `active`. */
    function OfficeIcon(props) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: props.size,
        height: props.size,
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('rect', {
        x: 3, y: 4, width: 18, height: 16, rx: 2,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: props.active ? 2 : 1.5,
      }),
      h('path', {
        d: 'M3 9h18M8 9v11',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: props.active ? 2 : 1.5,
      }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'office' }, OfficePanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'office',
          order: 5,
          label: 'Office',
        }, OfficeIcon))
      },
    }
  },
})
