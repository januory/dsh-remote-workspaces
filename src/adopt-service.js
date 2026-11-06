/**
 * Bind a routing provider to a harness service name, tolerating a stock
 * provider that is (or is about to be) registered.
 *
 * The bundle patch (`cordis.patch.yml`) normally disables the stock provider
 * rows (`fs-sandbox`, `bash-sandbox`, `pwsh-sandbox`) before this plugin
 * mounts, so `ctx.provide` owns the name. Some installation paths apply the
 * plugin row WITHOUT that patch layer — the plugin marketplace hot-mounts the
 * row, the row was added to the profile patch by hand, or an older installer
 * shipped the package as a plain plugin — and the stock provider stays in the
 * composition. Whichever side registers `fs`/`shell` first, the other one
 * throws `service "fs" has been registered at <...>` and the host fails to
 * boot (the stock row is the loser when it waits on its dependencies, so the
 * message can name either fiber).
 *
 * This module resolves that without taking the stock row out of the
 * composition:
 *   - no live stock row (the normal, patch-applied path) → provide;
 *   - stock row already registered → adopt the live instance;
 *   - stock row scheduled but still pending → wait for it, then adopt.
 *
 * Adoption overlays this implementation's public methods and accessors onto
 * the registered service object, so every consumer that already resolved
 * `ctx.fs`/`ctx.shell` keeps the object it holds while calls route through this
 * plugin. The overlay is removed with the plugin's fiber, restoring the stock
 * surface.
 *
 * @module dsh-remote-workspaces/adopt-service
 */

/**
 * @typedef {object} StockRow A composition row that provides a service when it
 * is not disabled.
 * @property {string} id - loader row id in the stock composition.
 * @property {string} name - package name the row mounts.
 */

/** The stock providers this plugin stands in for, by service name. */
export const STOCK_PROVIDERS = {
  fs: [{ id: 'fs-sandbox', name: '@deepseek-ai/dsh-fs-sandbox' }],
  shell: [
    { id: 'bash-sandbox', name: '@deepseek-ai/dsh-bash-sandbox' },
    { id: 'pwsh-sandbox', name: '@deepseek-ai/dsh-pwsh-sandbox' },
  ],
}

/**
 * The public surface of a routing implementation: every own/prototype method
 * and accessor, nearest definition first. Data properties are skipped — the
 * bound methods keep pointing at this implementation's own state.
 * @param implementation - the routing provider instance to copy.
 * @returns `[key, descriptor]` pairs in application order.
 */
function surfaceEntries(implementation) {
  const entries = new Map()
  for (let node = implementation; node !== null && node !== Object.prototype; node = Object.getPrototypeOf(node)) {
    for (const key of Object.getOwnPropertyNames(node)) {
      if (key === 'constructor' || entries.has(key)) continue
      entries.set(key, Object.getOwnPropertyDescriptor(node, key))
    }
  }
  return [...entries]
}

/**
 * Overlay `implementation`'s surface onto an already-registered service object.
 * Each overlay is an own property of `target`, so the stock prototype stays
 * untouched and the original descriptors are put back when `ctx.effect`'s
 * disposer runs (plugin unload).
 * @param ctx - host context; supplies the effect lifetime.
 * @param target - the service object another plugin registered.
 * @param implementation - the routing provider whose surface wins.
 */
export function adoptService(ctx, target, implementation) {
  const restore = []
  for (const [key, descriptor] of surfaceEntries(implementation)) {
    const original = Object.getOwnPropertyDescriptor(target, key)
    if (typeof descriptor.value === 'function') {
      Object.defineProperty(target, key, {
        configurable: true, enumerable: false, writable: true, value: descriptor.value.bind(implementation),
      })
    } else if (typeof descriptor.get === 'function') {
      Object.defineProperty(target, key, {
        configurable: true, enumerable: false, get: descriptor.get.bind(implementation),
      })
    } else {
      continue
    }
    restore.push([key, original])
  }
  ctx.effect(() => () => {
    for (const [key, original] of restore.reverse()) {
      if (original === undefined) delete target[key]
      else Object.defineProperty(target, key, original)
    }
  })
}

/**
 * Whether the composition still carries an enabled stock row for `service`.
 *
 * Reads the loader's own tree, the same surface the plugin manager and the
 * marketplace toggle rows through. A row's `disabled` may be an `!!js`
 * expression, so the read itself can throw; an unreadable row is reported as
 * unknown (`undefined`) and the caller falls back to the service lookup.
 * @param ctx - host context.
 * @param rows - stock rows that provide this service.
 * @returns `true`/`false` when the tree was readable, `undefined` otherwise.
 */
export function stockRowEnabled(ctx, rows) {
  let loader
  try {
    loader = ctx.get('loader')
  } catch {
    return undefined
  }
  if (loader === null || loader === undefined || typeof loader.entries !== 'function') return undefined
  let known = false
  try {
    for (const entry of loader.entries()) {
      const options = entry?.options ?? {}
      if (!rows.some(row => row.id === options.id || row.name === options.name)) continue
      let disabled
      try {
        disabled = entry.disabled ?? options.disabled
      } catch {
        continue
      }
      known = true
      if (!disabled) return true
    }
  } catch {
    return undefined
  }
  return known ? false : undefined
}

/**
 * Provide `implementation` under `name`, or adopt the instance that provides it.
 *
 * Order matters: a stock row that is still activating must win the name first,
 * otherwise `ctx.provide` takes it and the stock provider aborts the boot when
 * it registers.
 * @param ctx - host context.
 * @param name - service name (`fs`, `shell`).
 * @param implementation - the routing provider to publish.
 * @param rows - stock providers for this service, from {@link STOCK_PROVIDERS}.
 * @returns whether an existing or pending registration was adopted.
 */
export function bindService(ctx, name, implementation, rows = STOCK_PROVIDERS[name] ?? []) {
  const scheduled = stockRowEnabled(ctx, rows)
  const registered = ctx.get(name, false)
  if (registered !== undefined && registered !== null) {
    adoptService(ctx, registered, implementation)
    warnAdopted(ctx, name)
    return true
  }
  if (scheduled === true) {
    // The stock provider won the composition but has not registered yet (its
    // own dependencies are still settling). Wait for it and adopt, rather than
    // race it with a `provide` that would make it throw.
    ctx.inject([name], (scope) => {
      const live = scope.get(name)
      if (live !== undefined && live !== null) {
        adoptService(ctx, live, implementation)
        warnAdopted(ctx, name)
      }
    })
    return true
  }
  ctx.provide(name, implementation)
  return false
}

/**
 * Say once, on the plugin's logger, why the stock object is being reused.
 * @param ctx - host context.
 * @param name - adopted service name.
 */
function warnAdopted(ctx, name) {
  try {
    ctx.logger?.warn?.(
      `dsh-remote-workspaces: service "${name}" is provided by the stock harness plugin; routing through it. `
      + 'The bundle patch that disables the stock provider did not apply — reinstall the package with '
      + '"dsh plugin --profile <name> add <package>" so it loads as a bundle layer.',
    )
  } catch { /* logging is best effort */ }
}
