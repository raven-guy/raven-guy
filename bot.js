#!/usr/bin/env node

'use strict';

require('dotenv').config();
const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');

// ─── Config ────────────────────────────────────────────────────────────────

const cfg = {
  token:        process.env.TS_TOKEN,
  pollInterval: parseInt(process.env.TS_POLL_INTERVAL, 10) || 3000,
  eventsFile:   path.join(__dirname, 'events.json'),
  debug:        process.env.TS_DEBUG === '1',
  logFile:      path.join(__dirname, 'debug.log'),
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function ts()           { return new Date().toLocaleTimeString(); }
function log(lbl, msg)  { console.log(`[${ts()}] [${lbl}] ${msg}`); }
function warn(lbl, msg) { console.warn(`[${ts()}] [${lbl}] ⚠  ${msg}`); }
function ok(lbl, msg)   { console.log(`[${ts()}] [${lbl}] ✓  ${msg}`); }
function sleep(ms)      { return new Promise(r => setTimeout(r, ms)); }

function dbg(label, tag, data) {
  if (!cfg.debug) return;
  const line = `[${new Date().toISOString()}] [${label}] [${tag}] ${JSON.stringify(data, null, 2)}\n`;
  fs.appendFileSync(cfg.logFile, line);
}

// ─── Notifications (macOS) ─────────────────────────────────────────────────

function notify(label, message) {
  try {
    execSync(
      `osascript -e 'display notification "${message.replace(/"/g, '\\"')}" with title "TicketSwap Bot [${label}]" sound name "Glass"'`,
      { timeout: 3000 }
    );
  } catch { /* not macOS or osascript not available */ }
  // also ring terminal bell
  process.stdout.write('\x07');
}

// ─── Validate / Load ───────────────────────────────────────────────────────

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
  'Sec-Fetch-Dest':  'document',
  'Sec-Fetch-Mode':  'navigate',
  'Sec-Fetch-Site':  'none',
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
    headers: authHeaders({
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'Origin':       'https://www.ticketswap.com',
      'Referer':      'https://www.ticketswap.com/',
    }),
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  return res.json();
}

// ─── URL helpers ───────────────────────────────────────────────────────────

function slugFromUrl(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  return parts[parts.length - 1].split('?')[0];
}

// The last segment after the final '-' is TicketSwap's hash ID
// e.g. "che-amsterdam-melkweg-2026-07-05-CZNajspa2KAZkXcyWtuDy" → "CZNajspa2KAZkXcyWtuDy"
function hashFromUrl(url) {
  const slug = slugFromUrl(url);
  const parts = slug.split('-');
  return parts[parts.length - 1];
}

// ─── __NEXT_DATA__ parsing ─────────────────────────────────────────────────

function parseNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function isListingNode(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.__typename && obj.__typename !== 'Listing') return false;
  const hasPrice = obj.price != null;
  const hasId    = obj.id || obj.publicId || obj.listingId;
  const isAvail  = !obj.status ||
                   obj.status === 'available' || obj.status === 'AVAILABLE' ||
                   obj.isAvailable === true;
  return hasPrice && hasId && isAvail;
}

function extractListingsFromNextData(data, label) {
  if (!data) return [];
  const listings = [];
  const seen = new Set();

  function add(obj) {
    const key = obj.id || obj.publicId || JSON.stringify(obj).slice(0, 80);
    if (!seen.has(key)) { seen.add(key); listings.push(obj); }
  }

  function walk(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 30) return;
    if (isListingNode(obj)) { add(obj); return; }

    if (Array.isArray(obj.edges)) {
      obj.edges.forEach(e => { if (e) { walk(e.node || e, depth + 1); } });
      return;
    }

    if (Array.isArray(obj)) {
      obj.forEach(item => walk(item, depth + 1));
    } else {
      Object.values(obj).forEach(v => walk(v, depth + 1));
    }
  }

  const pp = data.props?.pageProps;
  if (!pp) return listings;

  // Standard Next.js pageProps data
  walk(pp, 0);

  // React Query dehydrated state
  const queries = pp.dehydratedState?.queries;
  if (Array.isArray(queries)) {
    dbg(label, 'rq-query-keys', queries.map(q => q.queryKey));
    queries.forEach(q => walk(q?.state?.data, 0));
  }

  // Apollo Client cache
  const apollo = pp.apolloState || pp.initialApolloState;
  if (apollo) {
    dbg(label, 'apollo-keys', Object.keys(apollo).slice(0, 30));
    walk(apollo, 0);
  }

  return listings;
}

// ─── Price extraction ──────────────────────────────────────────────────────

function extractPrice(listing) {
  if (listing.price == null) return null;
  if (typeof listing.price === 'number') return listing.price / 100;
  if (typeof listing.price === 'object') {
    const raw = listing.price.amount ??
                listing.price.totalPrice ??
                listing.price.value ??
                listing.price.originalPrice;
    if (raw == null) return null;
    return raw > 200 ? raw / 100 : raw;
  }
  return null;
}

// ─── GraphQL queries ───────────────────────────────────────────────────────

// Strategy A: node(id: hash) — hash at end of URL is likely a ListingType ID
const NODE_QUERY = `
  query GetNode($id: ID!) {
    node(id: $id) {
      __typename
      ... on ListingType {
        id
        title
        event { id title }
        listings(first: 30) {
          edges {
            node {
              id
              publicId
              status
              isAvailable
              numberOfTickets
              price { amount currency }
            }
          }
        }
      }
      ... on Event {
        id
        title
        listingTypes(first: 10) {
          edges {
            node {
              id
              title
              listings(first: 30) {
                edges {
                  node {
                    id
                    publicId
                    status
                    isAvailable
                    numberOfTickets
                    price { amount currency }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Strategy B: event(slug) with listingTypes
const EVENT_SLUG_QUERY = `
  query GetEventBySlug($slug: String!) {
    event(slug: $slug) {
      id
      title
      listingTypes(first: 10) {
        edges {
          node {
            id
            title
            listings(first: 30) {
              edges {
                node {
                  id
                  publicId
                  status
                  isAvailable
                  numberOfTickets
                  price { amount currency }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Strategy C: listingType(id: hash) directly
const LISTING_TYPE_QUERY = `
  query GetListingType($id: ID!) {
    listingType(id: $id) {
      id
      title
      event { id title }
      listings(first: 30) {
        edges {
          node {
            id
            publicId
            status
            isAvailable
            numberOfTickets
            price { amount currency }
          }
        }
      }
    }
  }
`;

// Strategy D: search available listings
const SEARCH_LISTINGS_QUERY = `
  query SearchListings($eventId: ID!) {
    availableListings(eventId: $eventId, first: 30) {
      edges {
        node {
          id
          publicId
          status
          numberOfTickets
          price { amount currency }
        }
      }
    }
  }
`;

function collectListingsFromGqlResponse(data, label) {
  const out = [];
  if (!data) return out;

  dbg(label, 'gql-raw', data);

  function fromEdges(edges) {
    if (!Array.isArray(edges)) return;
    edges.forEach(e => {
      const node = e?.node;
      if (!node) return;
      const avail = !node.status ||
                    node.status === 'AVAILABLE' || node.status === 'available' ||
                    node.isAvailable === true;
      if (avail) out.push(node);
    });
  }

  const d = data.data;
  if (!d) return out;

  // node() query
  const n = d.node;
  if (n) {
    if (n.listings?.edges)        fromEdges(n.listings.edges);
    if (n.listingTypes?.edges) {
      n.listingTypes.edges.forEach(lt => fromEdges(lt?.node?.listings?.edges));
    }
  }

  // event() query
  const ev = d.event;
  if (ev?.listingTypes?.edges) {
    ev.listingTypes.edges.forEach(lt => fromEdges(lt?.node?.listings?.edges));
  }
  if (ev?.listings?.edges) fromEdges(ev.listings.edges);

  // listingType() query
  if (d.listingType?.listings?.edges) fromEdges(d.listingType.listings.edges);

  // availableListings() query
  if (d.availableListings?.edges) fromEdges(d.availableListings.edges);

  return out;
}

async function fetchListingsViaApi(event) {
  const hash = hashFromUrl(event.url);
  const slug = slugFromUrl(event.url);

  const results = [];

  // Run all queries in parallel; collect whichever returns data
  const attempts = [
    graphql(NODE_QUERY,         { id: hash })        .then(d => ({ q: 'node',         d })).catch(() => null),
    graphql(LISTING_TYPE_QUERY, { id: hash })        .then(d => ({ q: 'listingType',  d })).catch(() => null),
    graphql(EVENT_SLUG_QUERY,   { slug })             .then(d => ({ q: 'eventSlug',    d })).catch(() => null),
  ];

  const responses = await Promise.all(attempts);

  for (const resp of responses) {
    if (!resp) continue;
    const listings = collectListingsFromGqlResponse(resp.d, event.label);
    dbg(event.label, `gql-${resp.q}-count`, listings.length);
    if (listings.length > 0) results.push(...listings);
  }

  return results;
}

// ─── Purchase ──────────────────────────────────────────────────────────────

const RESERVE_MUTATION = `
  mutation ReserveListing($listingId: ID!, $amount: Int!) {
    reserveListing(input: { listingId: $listingId, amount: $amount }) {
      order {
        id
        status
        confirmationUrl
        paymentUrl
      }
    }
  }
`;

async function purchaseListing(listing, event, label) {
  const listingId = listing.id || listing.publicId;
  log(label, `Attempting reservation of listing ${listingId} (qty: ${event.quantity}) ...`);

  try {
    const result = await graphql(RESERVE_MUTATION, {
      listingId,
      amount: event.quantity,
    });

    dbg(label, 'reserve-result', result);

    const order = result?.data?.reserveListing?.order;
    if (order) {
      ok(label, `Order created! ID: ${order.id}  Status: ${order.status}`);
      if (order.confirmationUrl) ok(label, `Confirm at: ${order.confirmationUrl}`);
      if (order.paymentUrl)      ok(label, `Payment at: ${order.paymentUrl}`);
      notify(label, `BOUGHT! Order ${order.id} — check terminal`);
      return true;
    }

    const errors = result?.errors?.map(e => e.message).join(', ');
    warn(label, `Reservation failed: ${errors || JSON.stringify(result)}`);
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
  log(event.label, `Hash ID: ${hashFromUrl(event.url)}`);

  let attempt = 0;

  while (true) {
    attempt++;
    try {
      let eligible = [];

      // Strategy 1: parse __NEXT_DATA__ from page HTML
      try {
        const html     = await fetchPage(event.url);
        const nextData = parseNextData(html);
        if (nextData) {
          const all = extractListingsFromNextData(nextData, event.label);
          dbg(event.label, 'nextdata-found', all.length);
          eligible = all.filter(l => {
            const p = extractPrice(l);
            return p !== null && p <= event.maxPrice;
          });
        }
      } catch (e) {
        dbg(event.label, 'nextdata-error', e.message);
      }

      // Strategy 2: GraphQL API (multiple queries in parallel)
      if (eligible.length === 0) {
        const apiListings = await fetchListingsViaApi(event);
        eligible = apiListings.filter(l => {
          const p = extractPrice(l);
          return p !== null && p <= event.maxPrice;
        });
      }

      if (eligible.length > 0) {
        const listing = eligible[0];
        const price   = extractPrice(listing);
        const priceStr = price != null ? `€${price.toFixed(2)}` : '(price unknown)';
        ok(event.label, `TICKET FOUND at ${priceStr}! Attempting purchase...`);
        notify(event.label, `Ticket found at ${priceStr}! Buying now...`);
        const bought = await purchaseListing(listing, event, event.label);
        if (bought) return;
        warn(event.label, 'Purchase failed — will retry next poll.');
      } else {
        process.stdout.write(`\r  [${event.label}] attempt ${attempt} — watching...   `);
      }
    } catch (e) {
      warn(event.label, `Poll error: ${e.message}`);
      dbg(event.label, 'poll-error', e.message);
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
  if (cfg.debug) console.log('  DEBUG MODE ON — writing to debug.log');
  console.log(`  Watching ${events.length} event(s). Press Ctrl+C to stop.\n`);
  events.forEach(e => console.log(`  • [${e.label}] max €${e.maxPrice}, qty ${e.quantity}`));
  console.log();

  process.on('SIGINT', () => { console.log('\nStopped.'); process.exit(0); });

  await Promise.all(events.map(pollEvent));
}

main();
