#!/usr/bin/env node

'use strict';

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────

const cfg = {
  email:        process.env.TS_EMAIL,
  pollInterval: parseInt(process.env.TS_POLL_INTERVAL, 10) || 2000,
  headless:     process.env.HEADLESS !== 'false',
  sessionFile:  path.join(__dirname, '.session.json'),
  eventsFile:   path.join(__dirname, 'events.json'),
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function log(label, msg)  { console.log(`[${ts()}] [${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[${ts()}] [${label}] ⚠  ${msg}`); }
function ok(label, msg)   { console.log(`[${ts()}] [${label}] ✓  ${msg}`); }
function err(label, msg)  { console.error(`[${ts()}] [${label}] ✗  ${msg}`); }
function ts() { return new Date().toLocaleTimeString(); }

function loadEvents() {
  // Prefer events.json for multi-event support
  if (fs.existsSync(cfg.eventsFile)) {
    const events = JSON.parse(fs.readFileSync(cfg.eventsFile, 'utf8'));
    if (!Array.isArray(events) || events.length === 0) {
      console.error('events.json must be a non-empty array. See events.example.json.');
      process.exit(1);
    }
    return events.map((e, i) => ({
      label:    e.label    || `Event ${i + 1}`,
      url:      e.url,
      maxPrice: e.maxPrice != null ? parseFloat(e.maxPrice) : Infinity,
      quantity: e.quantity != null ? parseInt(e.quantity, 10) : 1,
    }));
  }

  // Fallback: single event from env vars
  if (!process.env.TS_EVENT_URL) {
    console.error('No events configured. Either create events.json or set TS_EVENT_URL in .env');
    process.exit(1);
  }
  return [{
    label:    'Event 1',
    url:      process.env.TS_EVENT_URL,
    maxPrice: parseFloat(process.env.TS_MAX_PRICE) || Infinity,
    quantity: parseInt(process.env.TS_QUANTITY, 10) || 1,
  }];
}

function validateConfig() {
  if (!cfg.email) {
    console.error('Missing required env var: TS_EMAIL');
    console.error('Run: echo "TS_EMAIL=your@email.com" > .env');
    process.exit(1);
  }
}

// ─── Browser ───────────────────────────────────────────────────────────────

const MAC_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

// A persistent profile dir makes the browser look like a real returning user
const PROFILE_DIR = path.join(__dirname, '.chrome-profile');

async function launchBrowser() {
  const realChrome = MAC_CHROME_PATHS.find(p => fs.existsSync(p));

  const executablePath = realChrome
    || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

  if (executablePath) console.log(`Using Chrome: ${executablePath}`);

  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
  ];

  // launchPersistentContext keeps cookies, localStorage and fingerprint
  // data between runs — exactly like a real user's browser.
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless:     cfg.headless,
    executablePath,
    args,
    viewport:     { width: 1366, height: 768 },
    userAgent:    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:       'en-US',
    timezoneId:   'Europe/Amsterdam',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  return context;
}

// With persistent context there is no separate browser object to close —
// closing the context closes everything.
async function buildContext() {
  throw new Error('buildContext should not be called with persistent context');
}

// ─── Login ─────────────────────────────────────────────────────────────────

async function isLoggedIn(page) {
  try {
    await page.goto('https://www.ticketswap.com', { waitUntil: 'domcontentloaded', timeout: 15000 });

    // If TicketSwap shows a bot-detection page, we are definitely not logged in
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (bodyText.includes('Unable to verify') || bodyText.includes('Retry')) return false;

    const loginBtn = await page.$('a[href*="/login"], button:has-text("Log in"), a:has-text("Log in")');
    return loginBtn === null;
  } catch {
    return false;
  }
}

async function login(page) {
  console.log(`[${ts()}] Opening browser for login — check your email for the code.`);
  await page.goto('https://www.ticketswap.com/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await acceptCookies(page);

  // Enter email and submit — TicketSwap sends a magic link / OTP to the inbox
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
  await page.fill('input[type="email"], input[name="email"]', cfg.email);

  await Promise.all([
    page.waitForNavigation({ timeout: 20000, waitUntil: 'domcontentloaded' }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);

  // TicketSwap will show an OTP / code input or send a magic link.
  // Either way the user must complete it manually in the browser window.
  console.log(`\n[${ts()}] ⚠  Check your email (${cfg.email}) for a login code or link.`);
  console.log(`[${ts()}] ⚠  Enter it in the browser window. Waiting up to 5 minutes...\n`);

  // Wait until we land on a non-auth page (i.e. login is complete)
  await page.waitForURL(
    url => !url.includes('/login') && !url.includes('/auth') && !url.includes('/verify'),
    { timeout: 300000 }
  ).catch(() => {});

  // Final check
  const loggedIn = await page.$('[data-testid="user-menu"], a[href*="/logout"], [aria-label*="account"], [aria-label*="Account"]').catch(() => null);
  if (!loggedIn) throw new Error('Login timed out or failed. Run with HEADLESS=false and complete the login manually.');

  // Save session so we don't need to log in again next time
  const cookies = await page.context().cookies();
  fs.writeFileSync(cfg.sessionFile, JSON.stringify(cookies, null, 2));
  console.log(`[${ts()}] ✓  Logged in. Session saved — next run will skip login.`);
}

// ─── Cookie consent ────────────────────────────────────────────────────────

async function acceptCookies(page) {
  try {
    const btn = await page.waitForSelector(
      'button:has-text("Accept"), button:has-text("Accept all"), button:has-text("Akkoord"), [data-testid="cookie-accept"]',
      { timeout: 4000 }
    );
    if (btn) await btn.click();
  } catch { /* no banner */ }
}

// ─── Ticket detection ──────────────────────────────────────────────────────

const TICKET_SELECTORS = [
  '[data-testid*="listing"]',
  '[data-testid*="ticket"]',
  'li[class*="Listing"]',
  'li[class*="listing"]',
  'article[class*="listing"]',
  'article[class*="ticket"]',
  '[class*="TicketListing"]',
  '[class*="ticket-listing"]',
];

const BUY_BTN_SELECTORS = [
  'button:has-text("Buy")',
  'a:has-text("Buy")',
  'button:has-text("Koop")',
  'a:has-text("Koop")',
  '[data-testid*="buy"]',
  'button[class*="buy"]',
  'a[class*="buy"]',
  'button[class*="Buy"]',
  'a[class*="Buy"]',
];

const PRICE_SELECTORS = [
  '[data-testid*="price"]',
  '[class*="Price"]',
  '[class*="price"]',
  'span[class*="amount"]',
  'strong',
];

async function scrapeListings(page) {
  for (const sel of TICKET_SELECTORS) {
    const items = await page.$$(sel);
    if (items.length > 0) return items;
  }
  return [];
}

async function extractPrice(element) {
  for (const sel of PRICE_SELECTORS) {
    try {
      const text = await element.$eval(sel, el => el.textContent);
      const match = text.match(/[\d]+[.,]?\d*/);
      if (match) return parseFloat(match[0].replace(',', '.'));
    } catch { /* try next */ }
  }
  try {
    const text = await element.evaluate(el => el.innerText);
    const m1 = text.match(/€\s*([\d]+[.,]?\d*)/);
    if (m1) return parseFloat(m1[1].replace(',', '.'));
    const m2 = text.match(/([\d]+[.,]\d{2})/);
    if (m2) return parseFloat(m2[1].replace(',', '.'));
  } catch { /* ignored */ }
  return null;
}

async function findBuyButton(element) {
  for (const sel of BUY_BTN_SELECTORS) {
    try {
      const btn = await element.$(sel);
      if (btn) return btn;
    } catch { /* try next */ }
  }
  try {
    const tag  = await element.evaluate(el => el.tagName.toLowerCase());
    const text = await element.evaluate(el => el.innerText.toLowerCase());
    if ((tag === 'a' || tag === 'button') && (text.includes('buy') || text.includes('koop'))) {
      return element;
    }
  } catch { /* ignored */ }
  return null;
}

async function findEligibleTicket(page, event) {
  const listings = await scrapeListings(page);
  if (listings.length === 0) return null;

  for (const listing of listings) {
    const price = await extractPrice(listing);
    if (price === null) continue;
    if (price > event.maxPrice) continue;

    const btn = await findBuyButton(listing);
    if (!btn) continue;

    const disabled = await btn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
    if (disabled) continue;

    return { listing, btn, price };
  }
  return null;
}

// ─── Purchase flow ─────────────────────────────────────────────────────────

async function buyTicket(page, event, { btn, price }) {
  ok(event.label, `Ticket at €${price.toFixed(2)}! Buying...`);
  await btn.click();

  await Promise.race([
    page.waitForURL(u => u.includes('checkout') || u.includes('purchase') || u.includes('order'), { timeout: 10000 }),
    page.waitForSelector('[data-testid*="checkout"], [class*="checkout"], [class*="Checkout"]', { timeout: 10000 }),
    page.waitForTimeout(5000),
  ]).catch(() => {});

  await selectQuantity(page, event);
  await acceptTerms(page);

  const confirmed = await clickConfirmButton(page, event.label);
  if (!confirmed) {
    warn(event.label, 'Could not find confirm/pay button — manual action may be required.');
    return false;
  }

  await page.waitForTimeout(4000);
  const finalUrl = page.url();
  const success  = /success|confirm|order|thank/i.test(finalUrl);

  if (success) ok(event.label, `Purchase complete! ${finalUrl}`);
  else warn(event.label, `Outcome unclear — check your TicketSwap account. URL: ${finalUrl}`);

  return success;
}

async function selectQuantity(page, event) {
  if (event.quantity === 1) return;
  try {
    const plus = await page.$('[data-testid*="increase"], button[aria-label*="increase"], button:has-text("+")');
    if (plus) {
      for (let i = 1; i < event.quantity; i++) {
        await plus.click();
        await page.waitForTimeout(300);
      }
      return;
    }
    const input = await page.$('input[type="number"]');
    if (input) await input.fill(String(event.quantity));
  } catch {
    warn(event.label, 'Could not set quantity — proceeding with default.');
  }
}

async function acceptTerms(page) {
  try {
    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox && !(await checkbox.isChecked())) await checkbox.click();
  } catch { /* no checkbox */ }
}

async function clickConfirmButton(page, label) {
  const candidates = [
    'button:has-text("Confirm")', 'button:has-text("Pay")',
    'button:has-text("Buy now")', 'button:has-text("Place order")',
    'button:has-text("Complete")', 'button:has-text("Bevestig")',
    'button:has-text("Betaal")', '[data-testid*="confirm"]',
    '[data-testid*="pay"]', 'button[type="submit"]',
  ];
  for (const sel of candidates) {
    try {
      const btn = await page.$(sel);
      if (!btn) continue;
      if (await btn.evaluate(el => el.disabled)) continue;
      await btn.click();
      return true;
    } catch { /* try next */ }
  }
  return false;
}

// ─── Per-event poller ──────────────────────────────────────────────────────

async function pollEvent(context, event) {
  const page = await context.newPage();

  // Block heavy assets on this page to speed up reloads
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,otf}', r => r.abort());

  log(event.label, `Starting — ${event.url}`);
  log(event.label, `Max price: €${event.maxPrice}  |  Qty: ${event.quantity}`);

  await page.goto(event.url, { waitUntil: 'domcontentloaded', timeout: 20000 });

  let attempt = 0;

  while (true) {
    attempt++;
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await acceptCookies(page);

      const ticket = await findEligibleTicket(page, event);

      if (ticket) {
        const bought = await buyTicket(page, event, ticket);
        if (bought) {
          await page.close();
          return { event, success: true };
        }
        warn(event.label, 'Purchase failed — retrying next poll.');
      } else {
        process.stdout.write(`\r  [${event.label}] attempt ${attempt} — no eligible tickets yet...   `);
      }
    } catch (e) {
      warn(event.label, `Poll error: ${e.message}`);
    }

    await sleep(cfg.pollInterval);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  validateConfig();
  const events = loadEvents();

  console.log('\n╔══════════════════════════════════╗');
  console.log('║   TicketSwap Auto-Buyer Bot      ║');
  console.log('╚══════════════════════════════════╝');
  console.log(`\n  Watching ${events.length} event(s). Press Ctrl+C to stop.\n`);
  events.forEach(e => console.log(`  • [${e.label}] ${e.url}  (max €${e.maxPrice}, qty ${e.quantity})`));
  console.log();

  // launchBrowser() returns the persistent context directly
  const context = await launchBrowser();

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await context.close();
    process.exit(0);
  });

  try {
    // Login once using a temporary page
    const loginPage = await context.newPage();
    const alreadyIn = await isLoggedIn(loginPage);
    if (alreadyIn) {
      console.log(`[${ts()}] ✓  Session still active — skipping login.`);
    } else {
      await login(loginPage);
    }
    await loginPage.close();

    // Poll all events concurrently — each gets its own tab
    await Promise.all(events.map(event => pollEvent(context, event)));

  } catch (e) {
    console.error(`[${ts()}] ✗  ${e.message}`);
    if (cfg.headless) console.warn(`[${ts()}] ⚠  Tip: run with HEADLESS=false to debug.`);
  } finally {
    await context.close();
  }
}

main();
