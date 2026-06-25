#!/usr/bin/env node

'use strict';

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────

const cfg = {
  email:        process.env.TS_EMAIL,
  password:     process.env.TS_PASSWORD,
  eventUrl:     process.env.TS_EVENT_URL,
  maxPrice:     parseFloat(process.env.TS_MAX_PRICE)    || Infinity,
  quantity:     parseInt(process.env.TS_QUANTITY, 10)   || 1,
  pollInterval: parseInt(process.env.TS_POLL_INTERVAL, 10) || 2000,
  headless:     process.env.HEADLESS !== 'false',
  sessionFile:  path.join(__dirname, '.session.json'),
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function log(msg)  { console.log(`[${timestamp()}] ${msg}`); }
function warn(msg) { console.warn(`[${timestamp()}] ⚠  ${msg}`); }
function ok(msg)   { console.log(`[${timestamp()}] ✓  ${msg}`); }
function err(msg)  { console.error(`[${timestamp()}] ✗  ${msg}`); }
function timestamp() { return new Date().toLocaleTimeString(); }

function validateConfig() {
  const missing = ['email', 'password', 'eventUrl'].filter(k => !cfg[k]);
  if (missing.length) {
    err(`Missing required env vars: ${missing.map(k => `TS_${k.toUpperCase()}`).join(', ')}`);
    err('Copy .env.example to .env and fill in your details.');
    process.exit(1);
  }
}

// ─── Browser ───────────────────────────────────────────────────────────────

async function launchBrowser() {
  const launchOpts = {
    headless: cfg.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  };

  // Use the pre-installed Chromium when available
  if (fs.existsSync('/opt/pw-browsers/chromium')) {
    launchOpts.executablePath = '/opt/pw-browsers/chromium';
  }

  return chromium.launch(launchOpts);
}

async function buildContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: [
      'Mozilla/5.0 (X11; Linux x86_64)',
      'AppleWebKit/537.36 (KHTML, like Gecko)',
      'Chrome/124.0.0.0 Safari/537.36',
    ].join(' '),
    locale: 'en-US',
    timezoneId: 'Europe/Amsterdam',
  });

  // Restore saved session cookies if present
  if (fs.existsSync(cfg.sessionFile)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cfg.sessionFile, 'utf8'));
      await context.addCookies(cookies);
      log('Restored saved session.');
    } catch {
      // Ignore corrupt session file
    }
  }

  // Remove navigator.webdriver flag so TicketSwap doesn't flag us easily
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return context;
}

// ─── Login ─────────────────────────────────────────────────────────────────

async function isLoggedIn(page) {
  try {
    await page.goto('https://www.ticketswap.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Logged-in state: no "Log in" button visible, or user avatar/name is present
    const loginBtn = await page.$('a[href*="/login"], button:has-text("Log in"), a:has-text("Log in")');
    return loginBtn === null;
  } catch {
    return false;
  }
}

async function login(page) {
  log('Navigating to login page...');
  await page.goto('https://www.ticketswap.com/login', { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Accept cookies if the banner appears
  await acceptCookies(page);

  // Fill email
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
  await page.fill('input[type="email"], input[name="email"]', cfg.email);

  // Fill password
  await page.fill('input[type="password"], input[name="password"]', cfg.password);

  // Submit
  await Promise.all([
    page.waitForNavigation({ timeout: 20000, waitUntil: 'domcontentloaded' }),
    page.click('button[type="submit"]'),
  ]);

  // Check for 2FA or CAPTCHA
  const url = page.url();
  if (url.includes('verify') || url.includes('2fa') || url.includes('captcha')) {
    warn('2FA / CAPTCHA detected. Please complete it in the browser window.');
    warn('The bot will continue automatically once you are logged in.');
    await page.waitForURL(u => !u.includes('verify') && !u.includes('2fa') && !u.includes('captcha'), {
      timeout: 120000,
    });
  }

  if (!(await isOnLoggedInPage(page))) {
    throw new Error('Login failed — check your credentials or solve any CAPTCHA/2FA in headed mode.');
  }

  // Persist cookies for future runs
  const cookies = await page.context().cookies();
  fs.writeFileSync(cfg.sessionFile, JSON.stringify(cookies, null, 2));
  ok('Logged in and session saved.');
}

async function isOnLoggedInPage(page) {
  try {
    await page.waitForSelector(
      'a[href*="/logout"], [data-testid="user-menu"], [aria-label*="account"], [aria-label*="Account"]',
      { timeout: 5000 }
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Cookie consent ────────────────────────────────────────────────────────

async function acceptCookies(page) {
  try {
    const btn = await page.waitForSelector(
      'button:has-text("Accept"), button:has-text("Accept all"), button:has-text("Akkoord"), [data-testid="cookie-accept"]',
      { timeout: 4000 }
    );
    if (btn) await btn.click();
  } catch {
    // No cookie banner — fine
  }
}

// ─── Ticket detection ──────────────────────────────────────────────────────

/**
 * Selectors tried in order — TicketSwap uses dynamic class names that change,
 * so we use multiple strategies: data-testid attributes, semantic text, and
 * structural patterns.
 */
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
  'button:has-text("Koop")',    // Dutch
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
  // Try each container selector in turn
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
    } catch {
      // Try next selector
    }
  }
  // Last resort: grab all text and find a number that looks like a price
  try {
    const text = await element.evaluate(el => el.innerText);
    const match = text.match(/€\s*([\d]+[.,]?\d*)/);
    if (match) return parseFloat(match[1].replace(',', '.'));
    // Any number in the element
    const any = text.match(/([\d]+[.,]\d{2})/);
    if (any) return parseFloat(any[1].replace(',', '.'));
  } catch {
    // ignored
  }
  return null;
}

async function findBuyButton(element) {
  for (const sel of BUY_BTN_SELECTORS) {
    try {
      const btn = await element.$(sel);
      if (btn) return btn;
    } catch {
      // Try next
    }
  }
  // Also check the element itself
  try {
    const tag = await element.evaluate(el => el.tagName.toLowerCase());
    if (tag === 'a' || tag === 'button') {
      const text = await element.evaluate(el => el.innerText.toLowerCase());
      if (text.includes('buy') || text.includes('koop')) return element;
    }
  } catch {
    // ignored
  }
  return null;
}

async function findEligibleTicket(page) {
  const listings = await scrapeListings(page);
  if (listings.length === 0) return null;

  log(`Found ${listings.length} listing(s) — checking prices...`);

  for (const listing of listings) {
    const price = await extractPrice(listing);
    if (price === null) continue;

    if (price > cfg.maxPrice) {
      log(`  €${price.toFixed(2)} — too expensive (max €${cfg.maxPrice}), skipping.`);
      continue;
    }

    const btn = await findBuyButton(listing);
    if (!btn) continue;

    const disabled = await btn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
    if (disabled) continue;

    return { listing, btn, price };
  }

  return null;
}

// ─── Purchase flow ─────────────────────────────────────────────────────────

async function buyTicket(page, { listing, btn, price }) {
  ok(`Ticket found at €${price.toFixed(2)}! Starting purchase...`);

  // Click the buy button on the listing
  await btn.click();

  // TicketSwap opens a modal or navigates to a checkout page
  await Promise.race([
    page.waitForURL(u => u.includes('checkout') || u.includes('purchase') || u.includes('order'), { timeout: 10000 }),
    page.waitForSelector('[data-testid*="checkout"], [class*="checkout"], [class*="Checkout"]', { timeout: 10000 }),
    page.waitForTimeout(5000), // fallback — continue regardless
  ]).catch(() => {});

  log(`Current URL: ${page.url()}`);

  // Handle quantity selection if a number input appears
  await selectQuantity(page);

  // Accept terms if a checkbox is shown
  await acceptTerms(page);

  // Click the final confirm / pay button
  const confirmed = await clickConfirmButton(page);
  if (!confirmed) {
    warn('Could not find confirm/pay button — manual action may be required.');
    return false;
  }

  // Wait a moment and check if we landed on a success page
  await page.waitForTimeout(4000);
  const finalUrl = page.url();
  const success = /success|confirm|order|thank/i.test(finalUrl);

  if (success) {
    ok(`Purchase complete! Order page: ${finalUrl}`);
  } else {
    warn(`Purchase outcome unclear. Final URL: ${finalUrl}`);
    warn('Check your TicketSwap account for order confirmation.');
  }

  return success;
}

async function selectQuantity(page) {
  if (cfg.quantity === 1) return;

  try {
    // Some flows show a quantity stepper
    const plus = await page.$('[data-testid*="increase"], button[aria-label*="increase"], button:has-text("+")');
    if (plus) {
      for (let i = 1; i < cfg.quantity; i++) {
        await plus.click();
        await page.waitForTimeout(300);
      }
      return;
    }

    // Or a plain number input
    const input = await page.$('input[type="number"]');
    if (input) {
      await input.fill(String(cfg.quantity));
    }
  } catch {
    warn('Could not set quantity — proceeding with default.');
  }
}

async function acceptTerms(page) {
  try {
    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox) {
      const checked = await checkbox.isChecked();
      if (!checked) await checkbox.click();
    }
  } catch {
    // No checkbox — fine
  }
}

async function clickConfirmButton(page) {
  const candidates = [
    'button:has-text("Confirm")',
    'button:has-text("Pay")',
    'button:has-text("Buy now")',
    'button:has-text("Place order")',
    'button:has-text("Complete")',
    'button:has-text("Bevestig")',
    'button:has-text("Betaal")',
    '[data-testid*="confirm"]',
    '[data-testid*="pay"]',
    'button[type="submit"]',
  ];

  for (const sel of candidates) {
    try {
      const btn = await page.$(sel);
      if (!btn) continue;
      const disabled = await btn.evaluate(el => el.disabled);
      if (disabled) continue;
      await btn.click();
      log(`Clicked confirm button (${sel})`);
      return true;
    } catch {
      // Try next
    }
  }
  return false;
}

// ─── Poller ────────────────────────────────────────────────────────────────

async function pollForTickets(page) {
  let attempt = 0;

  log(`Polling ${cfg.eventUrl} every ${cfg.pollInterval}ms (max price: €${cfg.maxPrice}, qty: ${cfg.quantity})`);
  log('Press Ctrl+C to stop.\n');

  while (true) {
    attempt++;

    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await acceptCookies(page);

      const ticket = await findEligibleTicket(page);

      if (ticket) {
        const bought = await buyTicket(page, ticket);
        if (bought) return true;
        warn('Purchase attempt failed — will retry on next poll.');
      } else {
        process.stdout.write(`\r  [attempt ${attempt}] No eligible tickets yet. Retrying in ${cfg.pollInterval}ms...   `);
      }
    } catch (e) {
      warn(`Poll error (attempt ${attempt}): ${e.message}`);
    }

    await sleep(cfg.pollInterval);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  validateConfig();

  console.log('\n╔══════════════════════════════════╗');
  console.log('║   TicketSwap Auto-Buyer Bot      ║');
  console.log('╚══════════════════════════════════╝\n');

  const browser = await launchBrowser();
  const context = await buildContext(browser);
  const page    = await context.newPage();

  // Intercept and block heavy assets to speed up page loads
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,otf}', route => route.abort());

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await browser.close();
    process.exit(0);
  });

  try {
    // Check if saved session is still valid
    const alreadyIn = await isLoggedIn(page);

    if (alreadyIn) {
      ok('Session still active — skipping login.');
    } else {
      await login(page);
    }

    // Navigate to the target event
    log(`Navigating to event: ${cfg.eventUrl}`);
    await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Start polling
    await pollForTickets(page);

  } catch (e) {
    err(e.message);
    if (cfg.headless) {
      warn('Tip: run with HEADLESS=false to see what the browser is doing.');
    }
  } finally {
    await browser.close();
  }
}

main();
