import { chromium } from '@playwright/test'
const b = await chromium.launch()
const p = await (await b.newContext({viewport:{width:1440,height:1050}})).newPage()
await p.goto('http://localhost:3000/login',{waitUntil:'networkidle'})
await p.fill('input[type=email]','cutting@testtextile.test'); await p.fill('input[type=password]','fabricxai2026test')
await p.click('button[type=submit]'); await p.waitForURL(u=>!u.pathname.startsWith('/login')&&u.pathname!=='/',{timeout:25000})
await p.goto('http://localhost:3000/cutting/lay',{waitUntil:'networkidle'}); await p.waitForTimeout(900)
// pick the order that has issued rolls
const chip = p.locator('main button, main a').filter({hasText:/4711-88-2044|ST-2610/})
if (await chip.count()) { await chip.first().click(); await p.waitForTimeout(1200) }
const t = await p.evaluate(()=>document.querySelector('main')?.innerText??'')
console.log(t.slice(0,700).replace(/\n+/g,' | '))
