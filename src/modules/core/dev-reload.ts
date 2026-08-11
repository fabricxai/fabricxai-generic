/**
 * "Is this a duplicate, or a dev server that just re-evaluated the file?"
 *
 * Several registries in core refuse a second registration under one key, and they are right
 * to: two modules claiming one id, or two handlers claiming one sync operation, are
 * permanent bugs that make "who owns this?" unanswerable. The guards exist for that.
 *
 * A DEV SERVER is not that. Hot reload replaces a module's evaluated instance while the map
 * holding the previous registration — living in a chunk that did not change — survives. Same
 * file, same key, new object, and nothing at the call site can tell it apart from a genuine
 * collision. The symptom is an error overlay after an ordinary edit (`module "marbim" is
 * already registered`, `sync handler "cutting:create_lay" is already registered`) that only a
 * full restart clears — in the exact edit-and-refresh loop the UI runbook asks somebody to
 * spend their day in.
 *
 * So in development a re-registration REPLACES what was there. Production boots once and has
 * no hot reload, so a duplicate there is real and still throws. Tests run under
 * `NODE_ENV=test`, which is deliberately on the throwing side: a guard only tested in the
 * mode where it does nothing is not tested.
 *
 * One function rather than the same conditional in each registry — the next registry to grow
 * this guard should find the reasoning already written down, and the decision should be
 * changeable in one place if it ever turns out to be wrong.
 */
export const isDevReload = (): boolean => process.env.NODE_ENV === 'development'
