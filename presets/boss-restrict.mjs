/**
 * Office Boss preset row: hide every GLOBAL tool, leaving this preset's own shell and the
 * office host's per-agent tools as the only ones a boss holds.
 *
 * Why a deny list rather than `allow: []`: the shell this preset mounts registers into the
 * preset's standing scope, which for an agent is an ANCESTOR layer rather than the agent's
 * own. A restriction filters what a scope INHERITS and never what its own layer registers,
 * so an empty allow list admits none of the inherited names and would hide the shell along
 * with the globals.
 *
 * Naming the shell in an allow list is not an alternative: `restrict()` validates every
 * name against the pre-restriction inherited set, and a scoped registration is not in it,
 * so `allow: ['bash']` is refused with `names unknown global tool "bash"`. Denying the
 * global names removes exactly the globals and leaves the scoped shell standing.
 *
 * The office tools survive either way. The office host registers them through `agent.ctx`,
 * so they sit in the agent's OWN layer, which no restriction filters.
 */
export const name = 'office-boss-restrict'

export const inject = ['tools']

/**
 * Hide every global tool from this preset's agents.
 * @param ctx - the preset's standing scope.
 */
export function apply(ctx) {
  // No argument means the GLOBAL view, which is the same name universe `restrict()`
  // validates against from this row's scope. The shell's own name is excluded because a
  // restriction matches by name, not by the layer that registered it: denying "bash" would
  // hide this preset's shell as well as any global one.
  const globals = ctx.tools
    .schemas()
    .map(schema => schema.name)
    .filter(name => name !== 'bash')
  // An empty filter is a no-op, and restrict() rejects a filter naming nothing.
  if (globals.length === 0) return
  ctx.effect(
    () => ctx.tools.restrict({ deny: globals }),
    'office-boss.globals-hidden()',
  )
}
