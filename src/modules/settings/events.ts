/** Outbox events for X.3. */
export const SETTINGS_EVENTS = {
  /**
   * ⚖ A policy changed. Carries the EFFECTIVE value, not just the patch — anything
   * reacting to this needs to know what the system will now use, and a diff of two of six
   * fields does not say that.
   */
  policyChanged: 'settings.policy.changed',
  roleGranted: 'settings.role.granted',
  roleRevoked: 'settings.role.revoked',
  lineScopeSet: 'settings.role.line_scope_set',
  moduleToggled: 'settings.module.toggled',
} as const

export type SettingsEventName = (typeof SETTINGS_EVENTS)[keyof typeof SETTINGS_EVENTS]
