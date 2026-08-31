import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { remoteWorkspacesRoot } from '../src/mirror.js'
// Dev-only: Playwright resolves from the sibling deepseek-harness checkout;
// the test also needs a running DSH instance (argv[2] url / argv[3] token).
import { chromium } from '../../deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'

const url = process.argv[2] || 'http://127.0.0.1:3090/'
const token = process.argv[3] || ''

// 1. create an orphan mirror (workspace NOT in registry)
const root = remoteWorkspacesRoot()
const machineDir = join(root, '192.168.1.99-testuser')
const orphanDir = join(machineDir, 'orphan--tmp')
mkdirSync(orphanDir, { recursive: true })
writeFileSync(join(orphanDir, '.dsh-remote-meta.json'), JSON.stringify({
  host: '192.168.1.99', port: null, username: 'testuser', remotePath: '/tmp/orphan', createdAt: new Date().toISOString(),
}, null, 2) + '\n', 'utf8')

// 2. browser: settings → 远程工作区 → verify orphan section → click cleanup
const logs = []
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[console.error] ${m.text().slice(0, 200)}`) })
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`))
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`) })
const body = () => page.evaluate(() => (document.body.textContent || '').replace(/\s+/g, ' '))

await page.goto(`${url}?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(9000)
await page.locator('button', { hasText: '设置' }).first().click()
await page.waitForTimeout(2000)
await page.locator('button', { hasText: /远程工作区$/ }).first().click()
await page.waitForTimeout(3000)

let t = await body()
console.log('=== ORPHAN SECTION ===')
console.log('shows 已删除工作区 section:', /已删除工作区（\d+）/.test(t))
console.log('shows orphan remote path /tmp/orphan:', t.includes('/tmp/orphan'))
console.log('has per-row 清理 button:', t.includes('清理'))
console.log('has 全部清理 button:', t.includes('全部清理'))

// click the first per-row 清理 button (alphabetical machine dir order puts
// 192.168.1.99-testuser before any real host, so this is /tmp/orphan's button)
const btn = page.locator('button', { hasText: /^清理$/ }).first()
console.log('per-row 清理 button count:', await btn.count())
if (await btn.count()) {
  await btn.click()
  await page.waitForTimeout(3000)
  t = await body()
  console.log('\n=== AFTER CLEANUP ===')
  console.log('/tmp/orphan gone from UI:', !t.includes('/tmp/orphan'))
  console.log('/tmp/orphan dir removed on disk:', !existsSync(orphanDir))
}

console.log('\n=== ERRORS ===')
logs.forEach((l) => console.log(' ', l))
if (logs.length === 0) console.log(' (none)')

// cleanup machine dir if empty
if (existsSync(machineDir)) { try { rmSync(machineDir, { recursive: true, force: true }) } catch {} }
await browser.close()
