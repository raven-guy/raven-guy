#!/usr/bin/env node

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────

const cfg = {
  token:        process.env.TS_TOKEN,
  pollInterval: parseInt(process.env.TS_POLL_INTERVAL, 10) || 3000,
  eventsFile:   path.join(__dirname, 'events.json'),
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function ts()             { return new Date().toLocaleTimeString(); }
function log(lbl, msg)    { console.log(`[${ts()}] [${lbl}] ${msg}`); }
function warn(lbl, msg)   { console.warn(`[${ts()}] [${lbl}] ⚠  ${msg}`); }
function ok(lbl, msg)     { console.log(`[${ts()}] [${lbl}] ✓  ${msg}`); }
function sleep(ms)        { return new Promise(r => setTimeout(r, ms)); }

// ─── Validate ──────────────────────────────────────────────────────────────

function validateConfig() {
  if (!cfg.token) {
    console.error('Missing TS_TOKEN in your .env file.');
    console.error('Open ticketswap.com in Chrome → DevTools → Application → Cookies → copy the "token" value.');
    process.exit(1);
  }
}

function loadEvents() {
  if (fs.existsSync(cfg.eventsFile)) {
    const events = JSON.parse(fs.readFileSync(cfg.eventsFile, 'utf8'));
    return events.map((e, i) => ({
      label:    e.label    || `Event ${i + 1}`,
      url:      e.url,
      maxPrice: e.maxPrice != null ? parseFloat(e.maxPrice) : Infinity,
      quantity: e.quantity != null ? parseInt(e.quantity, 10) : 1,
    }));
  }
  if (!process.env.TS_EVENT_URL) {
    console.error('No events configured. Create events.json or set TS_EVENT_URL in .env');
    process.exit(1);
  }
  return [{
    label:    'Event 1',
    url:      process.env.TS_EVENT_URL,
    maxPrice: parseFloat(process.env.TS_MAX_PRICE) || Infinity,
    quantity: parseInt(process.env.TS_QUANTITY, 10) || 1,
  }];
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

const BASE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function authHeaders(extra = {}) {
  return {
    ...BASE_HEADERS,
    'Cookie':        `token=${cfg.token}`,
    'Authorization': `Bearer ${cfg.token}`,
    ...extra,
  };
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function graphql(query, variables = {}) {
  const res = await fetch('https://api.ticketswap.com/graphql/public', {
    method:  'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', 'Accept': 'application/json' }),
    body:    JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  return res.json();
}

// ─── Parse tickets from page HTML ──────────────────────────────────────────

function parseNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function extractListingsFromNextData(data) {
  if (!data) return [];
  const listings = [];

  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    // Look for objects that look like ticket listings
    if (obj.price != null && (obj.id || obj.publicId) &&
        (obj.status === 'available' || obj.status === 'AVAILABLE' || obj.isAvailable)) {
      listings.push(obj);
    }
    // Also catch edges pattern (GraphQL connections)
    if (Array.isArray(obj.edges)) {
      obj.edges.forEach(e => walk(e.node || e));
    }
    if (Array.isArray(obj)) {
      obj.forEach(walk);
    } else {
      Object.values(obj).forEach(walk);
    }
  }

  walk(data.props?.pageProps);
  return listings;
}

function extractPrice(listing) {
  if (listing.price == null) return null;
  if (typeof listing.price === 'number') return listing.price / 100; // cents → euros
  if (typeof listing.price === 'object') {
    const raw = listing.price.amount ?? listing.price.totalPrice ?? listing.price.value;
    if (raw == null) return null;
    // If value looks like cents (> 200), convert; otherwise treat as euros
    return raw > 200 ? raw / 100 : raw;
  }
  return null;
}

// ─── GraphQL ticket search (fallback) ──────────────────────────────────────

// Try to extract event slug/ID from URL for GraphQL query
function slugFromUrl(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  return parts[parts.length - 1].split('?')[0];
}

const LISTINGS_QUERY = `
  query GetListings($slug: String!) {
    event(slug: $slug) {
      id
      title
      listings(first: 20) {
        edges {
          node {
            id
            publicId
            status
            numberOfTickets
            price {
              amount
              currency
            }
          }
        }
      }
    }
  }
`;

async function fetchListingsViaApi(event) {
  try {
    const slug = slugFromUrl(event.url);
    const data = await graphql(LISTINGS_QUERY, { slug });
    const edges = data?.data?.event?.listings?.edges || [];
    return edges
      .map(e => e.node)
      .filter(n => n && (n.status === 'available' || n.status === 'AVAILABLE'));
  } catch {
    return [];
  }
}

// ─── Purchase ──────────────────────────────────────────────────────────────

const RESERVE_MUTATION = `
  mutation ReserveListing($listingId: ID!, $amount: Int!) {
    reserveListing(input: { listingId: $listingId, amount: $amount }) {
      order {
        id
        status
        confirmationUrl
      }
    }
  }
`;

async function purchaseListing(listing, event, label) {
  // Try GraphQL mutation first
  try {
    const result = await graphql(RESERVE_MUTATION, {
      listingId: listing.id || listing.publicId,
      amount:    event.quantity,
    });
    const order = result?.data?.reserveListing?.order;
    if (order) {
      ok(label, `Order created! ID: ${order.id}  Status: ${order.status}`);
      if (order.confirmationUrl) ok(label, `Confirm at: ${order.confirmationUrl}`);
      return true;
    }
    const errors = result?.errors?.map(e => e.message).join(', ');
    warn(label, `Reservation failed: ${errors || 'unknown error'}`);
    return false;
  } catch (e) {
    warn(label, `Purchase API error: ${e.message}`);
    return false;
  }
}

// ─── Poller ────────────────────────────────────────────────────────────────

async function pollEvent(event) {
  log(event.label, `Watching: ${event.url}`);
  log(event.label, `Max price: €${event.maxPrice}  |  Qty: ${event.quantity}`);

  let attempt = 0;

  while (true) {
    attempt++;
    try {
      // Strategy 1: fetch page HTML and parse Next.js data
      let eligible = [];
      try {
        const html = await fetchPage(event.url);
        const nextData = parseNextData(html);
        const allListings = extractListingsFromNextData(nextData);
        eligible = allListings.filter(l => {
          const price = extractPrice(l);
          return price !== null && price <= event.maxPrice;
        });
      } catch { /* fallthrough to strategy 2 */ }

      // Strategy 2: GraphQL API
      if (eligible.length === 0) {
        const apiListings = await fetchListingsViaApi(event);
        eligible = apiListings.filter(l => {
          const price = extractPrice(l);
          return price !== null && price <= event.maxPrice;
        });
      }

      if (eligible.length > 0) {
        const listing = eligible[0];
        const price   = extractPrice(listing);
        ok(event.label, `Ticket found at €${price?.toFixed(2)}! Buying...`);
        const bought = await purchaseListing(listing, event, event.label);
        if (bought) return;
        warn(event.label, 'Purchase failed — will retry.');
      } else {
        process.stdout.write(`\r  [${event.label}] attempt ${attempt} — watching...   `);
      }
    } catch (e) {
      warn(event.label, `Error: ${e.message}`);
    }

    await sleep(cfg.pollInterval);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  validateConfig();
  const events = loadEvents();

  console.log('\n╔══════════════════════════════════╗');
  console.log('║   TicketSwap Auto-Buyer Bot      ║');
  console.log('╚══════════════════════════════════╝');
  console.log(`\n  No browser needed — using your session token directly.`);
  console.log(`  Watching ${events.length} event(s). Press Ctrl+C to stop.\n`);
  events.forEach(e => console.log(`  • [${e.label}] max €${e.maxPrice}, qty ${e.quantity}`));
  console.log();

  process.on('SIGINT', () => { console.log('\nStopped.'); process.exit(0); });

  // Poll all events concurrently
  await Promise.all(events.map(pollEvent));
}

main();
