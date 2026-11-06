/**
 * Binding fs/shell over a stock provider.
 *
 * The bundle patch normally disables the stock fs/shell providers, so this
 * plugin owns both names. When that patch layer did not apply (marketplace
 * hot-mount, a hand-inserted plugin row), the stock provider is still in the
 * composition and whichever side registers second throws
 * `service "fs" has been registered at <SandboxedFileSystem>`, killing the
 * host. `bindService` must instead adopt the live instance — or wait for a
 * still-pending stock row and adopt that — and restore the stock surface when
 * the plugin unloads.
 */
import { bindService, adoptService, stockRowEnabled, STOCK_PROVIDERS } from '../src/adopt-service.js'

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

/** A stand-in for the host's stock provider (SandboxedFileSystem / bash-sandbox). */
class StockProvider {
  constructor() { this.stockCalls = 0 }
  readText() { this.stockCalls += 1; return 'stock' }
  get sandboxMode() { return 'stock-mode' }
  stockOnly() { return 'stock-only' }
}

/** The plugin's routing implementation. */
class RoutingProvider {
  constructor(label) { this.label = label }
  readText() { return this.label }
  get sandboxMode() { return 'routed-mode' }
  writeText() { return 'routed-write' }
}

/**
 * Minimal host context: provide/get/inject/effect, plus a loader tree whose
 * rows are the given composition entries.
 */
function makeContext(rows = null) {
  const services = new Map()
  const effects = []
  const injections = []
  const ctx = {
    effects,
    injections,
    provided: [],
    get(name) {
      if (name === 'loader') return rows === null ? undefined : { entries: () => rows }
      return services.get(name)
    },
    provide(name, value) {
      if (services.has(name)) throw new Error(`service "${name}" has been registered at <StockProvider>`)
      services.set(name, value)
      this.provided.push(name)
    },
    inject(_names, callback) {
      injections.push(callback)
    },
    /** Simulate another plugin registering a service later. */
    activate(name, value) {
      services.set(name, value)
      for (const callback of injections.splice(0)) callback({ get: () => services.get(name) })
    },
    effect(body) {
      const dispose = body()
      effects.push(dispose)
      return dispose
    },
    disposeAll() {
      while (effects.length > 0) effects.pop()()
    },
  }
  return ctx
}

const [fsRow] = STOCK_PROVIDERS.fs

// ---- no stock row (the normal bundle install): provide and own the name ----
{
  const ctx = makeContext([])
  const routing = new RoutingProvider('routed')
  const adopted = bindService(ctx, 'fs', routing)
  check('absent fs is provided by the plugin', adopted === false)
  check('absent fs returns the routing instance', ctx.get('fs') === routing)
  check('provided names recorded', ctx.provided.length === 1 && ctx.provided[0] === 'fs')
}

// ---- stock row disabled by the bundle patch: provide ----
{
  const ctx = makeContext([{ options: { id: fsRow.id, name: fsRow.name, disabled: true }, disabled: true }])
  check('disabled stock row reads as not enabled', stockRowEnabled(ctx, STOCK_PROVIDERS.fs) === false)
  bindService(ctx, 'fs', new RoutingProvider('routed'))
  check('disabled stock row still allows provide', ctx.provided.includes('fs'))
}

// ---- stock provider already registered: adopt instead of throwing ----
{
  const ctx = makeContext([{ options: { id: fsRow.id, name: fsRow.name } }])
  const stock = new StockProvider()
  ctx.activate('fs', stock)
  const routing = new RoutingProvider('routed')

  check('live stock row reads as enabled', stockRowEnabled(ctx, STOCK_PROVIDERS.fs) === true)
  const adopted = bindService(ctx, 'fs', routing)
  check('registered fs is adopted', adopted === true)
  check('adopted service keeps the stock object', ctx.get('fs') === stock)
  check('adopted readText routes', stock.readText() === 'routed', stock.readText())
  check('adopted accessor routes', stock.sandboxMode === 'routed-mode', stock.sandboxMode)
  check('stock-only method survives', stock.stockOnly() === 'stock-only')
  check('stock method no longer called', stock.stockCalls === 0)

  ctx.disposeAll()
  check('unload restores stock readText', stock.readText() === 'stock', stock.readText())
  check('unload restores stock accessor', stock.sandboxMode === 'stock-mode', stock.sandboxMode)
  check('unload removes the routing-only method', stock.writeText === undefined)

  // Adopting twice (a second plugin instance) must not throw and must still
  // leave the stock surface intact after both unload.
  const second = makeContext([{ options: { id: fsRow.id, name: fsRow.name } }])
  second.activate('fs', stock)
  adoptService(second, stock, new RoutingProvider('second'))
  check('second adoption wins', stock.readText() === 'second', stock.readText())
  second.disposeAll()
  check('second unload restores stock again', stock.readText() === 'stock', stock.readText())
}

// ---- stock row scheduled but not registered yet: wait, then adopt ----
{
  const ctx = makeContext([{ options: { id: fsRow.id, name: fsRow.name } }])
  const routing = new RoutingProvider('routed')
  const adopted = bindService(ctx, 'fs', routing)
  check('pending stock row is not raced with provide', adopted === true)
  check('pending stock row blocks provide', ctx.provided.length === 0)
  check('an injection waits for the stock service', ctx.injections.length === 1)

  const stock = new StockProvider()
  ctx.activate('fs', stock)
  check('service that arrives later is adopted', ctx.get('fs') === stock)
  check('late adoption routes', stock.readText() === 'routed', stock.readText())
  ctx.disposeAll()
  check('late adoption restores on unload', stock.readText() === 'stock', stock.readText())
}

// ---- an unreadable loader falls back to the old lookup ----
{
  const throwing = { entries: () => { throw new Error('boom') } }
  const ctx = makeContext()
  ctx.get = (name) => (name === 'loader' ? throwing : undefined)
  check('unreadable loader is unknown', stockRowEnabled(ctx, STOCK_PROVIDERS.fs) === undefined)
  bindService(ctx, 'fs', new RoutingProvider('routed'))
  check('unknown loader still provides', ctx.provided.includes('fs'))
}

// ---- a disabled row whose expression throws is skipped, not adopted ----
{
  const ctx = makeContext([{
    options: { id: fsRow.id, name: fsRow.name },
    get disabled() { throw new Error('expression failed') },
  }])
  check('throwing disabled expression is unknown', stockRowEnabled(ctx, STOCK_PROVIDERS.fs) === undefined)
}

// ---- a prototype getter is overridden without touching the prototype ----
{
  const stock = new StockProvider()
  const ctx = makeContext([{ options: { id: fsRow.id, name: fsRow.name } }])
  ctx.activate('fs', stock)
  adoptService(ctx, stock, new RoutingProvider('x'))
  check('prototype untouched', Object.getOwnPropertyDescriptor(StockProvider.prototype, 'sandboxMode').get !== undefined)
  check('overlay is an own property', Object.hasOwn(stock, 'sandboxMode'))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
