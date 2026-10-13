// Access control: FAIL CLOSED, and never trust a QQ nickname.
//
// The stock QQ plugin treats an empty allowlist as `['*']` (allow everyone) --
// a dangerous default for a private system. This module deliberately does the
// opposite: an empty allowlist denies every OpenID, and there is no wildcard
// unless the operator writes `*` on purpose.

/**
 * @typedef {object} AccessOptions
 * @property {string[]} allowOpenIds  exact OpenIDs allowed to talk to the bridge
 * @property {boolean} allowGroups    whether group messages are served at all
 * @property {string[]} [allowGroupIds] exact group OpenIDs allowed (when allowGroups)
 */

/**
 * @param {{allowOpenIds?: string[], allowGroups?: boolean, allowGroupIds?: string[]}} options
 */
export function createAccess(options = {}) {
  const allow = new Set(
    (options.allowOpenIds ?? [])
      .map(value => String(value ?? '').trim())
      .filter(Boolean),
  )
  const groupAllow = new Set(
    (options.allowGroupIds ?? [])
      .map(value => String(value ?? '').trim())
      .filter(Boolean),
  )
  const allowGroups = options.allowGroups === true
  /** True only when the operator explicitly opted into serving anyone. */
  const wildcard = allow.has('*')

  /**
   * Decide whether one inbound message may reach a DS Bot.
   * @param {{scope?: string, openId?: string, groupOpenId?: string}} message
   * @returns {{allowed: boolean, reason: string}}
   */
  const check = message => {
    const scope = message?.scope === 'group' ? 'group' : 'c2c'
    const openId = String(message?.openId ?? '')
    if (openId === '') return { allowed: false, reason: 'no-openid' }
    if (scope === 'group') {
      if (!allowGroups) return { allowed: false, reason: 'groups-disabled' }
      const groupId = String(message?.groupOpenId ?? '')
      if (groupAllow.has('*') || (groupId !== '' && groupAllow.has(groupId))) {
        // Even inside an allowed group, the speaker must be a known OpenID:
        // a group is not a way around the private allowlist.
        return allow.has(openId) || wildcard
          ? { allowed: true, reason: 'group-allow' }
          : { allowed: false, reason: 'sender-not-allowed' }
      }
      return { allowed: false, reason: 'group-not-allowed' }
    }
    if (wildcard || allow.has(openId)) return { allowed: true, reason: 'c2c-allow' }
    return { allowed: false, reason: allow.size === 0 ? 'allowlist-empty' : 'not-allowed' }
  }

  return {
    check,
    /** Number of configured OpenIDs (`*` counts as one). */
    get size() {
      return allow.size
    },
    get groupsEnabled() {
      return allowGroups
    },
    /** A one-line description safe to log or show the operator. */
    describe() {
      if (allow.size === 0) return 'no OpenIDs configured (all QQ access denied)'
      if (wildcard) return 'WILDCARD: any QQ OpenID is accepted'
      return `${allow.size} OpenID(s) allowed${allowGroups ? ', groups enabled' : ', groups disabled'}`
    },
  }
}
