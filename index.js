// poe-price-backend/index.js
// Simple PoE Trade backend: POST /price { league, item } -> { priceInfo, searchUrl }

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// PoE trade base URLs
const POE_TRADE_API_BASE_URL = 'https://www.pathofexile.com/api/trade';
const POE_TRADE_SITE_URL = 'https://www.pathofexile.com/trade';

// Express setup
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Small helper
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Build a PoE trade search query.
 * Uses:
 *  - baseType (type)
 *  - rarity
 *  - ilvl (min)
 *  - links (min)
 *  - influences
 *  - implicits/explicits via statId -> stat filters
 */
function buildSearchQuery(item) {
  const query = {
    query: {
      status: { option: 'online' },
      filters: {
        type_filters: { filters: {} },
        misc_filters: { filters: {} },
      },
      // we’ll fill stat filters below
      stats: [
        {
          type: 'and',
          filters: [],
        },
      ],
    },
    sort: { price: 'asc' },
  };

  const filters = query.query.filters;
  const statGroup = query.query.stats[0];
  const statFilters = statGroup.filters;

  // ---------- BASIC FILTERS ----------

  if (item.baseType) {
    query.query.type = item.baseType;
  }

  if (item.rarity) {
    filters.type_filters.filters.rarity = {
      option: String(item.rarity).toLowerCase(),
    };
  }

  if (Array.isArray(item.influences) && item.influences.length > 0) {
    const influenceMap = {
      Shaper: 'shaper_item',
      Elder: 'elder_item',
      Crusader: 'crusader_item',
      Redeemer: 'redeemer_item',
      Hunter: 'hunter_item',
      Warlord: 'warlord_item',
    };
    const infFilters = {};
    for (const inf of item.influences) {
      const key = influenceMap[inf];
      if (key) {
        infFilters[key] = { option: true };
      }
    }
    if (Object.keys(infFilters).length > 0) {
      // attach influence flags directly under misc_filters.filters
      Object.assign(filters.misc_filters.filters, infFilters);
    }
  }

  if (typeof item.itemLevel === 'number') {
    filters.misc_filters.filters.ilvl = { min: item.itemLevel };
  }

  if (item.links && item.links > 1) {
    query.query.filters.socket_filters = {
      filters: { links: { min: item.links } },
    };
  }

  // ---------- STAT FILTERS FROM statId ----------

  const seenStatIds = new Set();

  function addStatFromMod(mod) {
    if (!mod || !mod.statId) return;
    const id = String(mod.statId);
    if (!id || seenStatIds.has(id)) return;

    seenStatIds.add(id);

    statFilters.push({
      id,
      type: 'and', // REQUIRED by PoE trade for each stat filter
      disabled: false,
      value: {
        min: null,
        max: null,
      },
    });
  }

  if (Array.isArray(item.implicits)) {
    for (const mod of item.implicits) {
      addStatFromMod(mod);
    }
  }

  if (Array.isArray(item.explicits)) {
    for (const mod of item.explicits) {
      addStatFromMod(mod);
    }
  }

  // If no stats were added, keep an empty AND group (valid but no stat filters)
  if (statFilters.length === 0) {
    query.query.stats = [
      {
        type: 'and',
        filters: [],
      },
    ];
  }

  return query;
}

/**
 * Parse listing price into { amount, currency }.
 */
function parsePrice(listing) {
  const price = listing?.listing?.price;
  if (!price) return null;

  const amount = Number(price.amount);
  const currency = String(price.currency || '').trim();

  if (!currency || Number.isNaN(amount)) return null;

  return { amount, currency };
}

/**
 * Search PoE trade with retries.
 */
async function performSearchWithRetries(league, query, maxAttempts = 5) {
  const url = `${POE_TRADE_API_BASE_URL}/search/${encodeURIComponent(league)}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(query),
    });

    if (res.ok) {
      const json = await res.json();
      console.log('[PoE API] Search OK. total =', json.total);
      return json;
    }

    const text = await res.text().catch(() => '');
    let errorBody;
    try {
      errorBody = JSON.parse(text);
    } catch {
      errorBody = null;
    }

    const errMsg = errorBody?.error?.message || text || '';
    console.warn('[PoE API] Search error:', errMsg || res.status);

    if (errMsg.includes('Rate limit exceeded') || res.status === 429) {
      console.warn(
        `[PoE API] Rate limited on search. Waiting 60s (attempt ${attempt + 1})`
      );
      await delay(60000);
      continue;
    }

    if (errMsg.includes('Unknown item')) {
      if (query.query?.filters?.type_filters?.filters?.rarity) {
        console.warn(
          '[PoE API] Unknown item. Removing rarity filter and retrying once...'
        );
        delete query.query.filters.type_filters.filters.rarity;
        await delay(500);
        continue;
      }
    }

    if (errMsg.includes('Invalid query')) {
      if (query.query?.filters?.misc_filters?.filters?.ilvl) {
        console.warn(
          '[PoE API] Invalid query. Removing ilvl and socket filters and retrying once...'
        );
        delete query.query.filters.misc_filters.filters.ilvl;
      }
      if (query.query?.filters?.socket_filters) {
        delete query.query.filters.socket_filters;
      }
      if (attempt === 0) {
        await delay(500);
        continue;
      }
    }

    throw new Error(`[PoE API] Search failed: ${errMsg || res.status}`);
  }

  throw new Error('[PoE API] Max search retries reached');
}

/**
 * Fetch listings with retry.
 */
async function fetchListingsWithRetries(
  fetchUrlWithQuery,
  fetchUrlNoQuery,
  maxAttempts = 3
) {
  let currentUrl = fetchUrlWithQuery;
  let triedWithoutQuery = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(currentUrl, {
      headers: { Accept: 'application/json' },
    });

    if (res.ok) {
      const json = await res.json();
      console.log('[PoE API] Fetch OK. results =', json.result?.length || 0);
      return json;
    }

    const text = await res.text().catch(() => '');
    console.warn(
      `[PoE API] Fetch listings failed (status ${res.status}) body: ${text.slice(
        0,
        200
      )}`
    );

    if (
      !triedWithoutQuery &&
      res.status === 400 &&
      text.includes('Invalid query') &&
      currentUrl === fetchUrlWithQuery
    ) {
      console.warn(
        '[PoE API] Fetch invalid query with ?query=. Retrying once without query param...'
      );
      currentUrl = fetchUrlNoQuery;
      triedWithoutQuery = true;
      await delay(300);
      continue;
    }

    if (
      text.includes('Rate limit exceeded') ||
      res.status === 429 ||
      res.status >= 500
    ) {
      const waitMs = 1000 * (attempt + 1);
      console.warn(
        `[PoE API] Temporary fetch error. Retrying in ${waitMs}ms... (attempt ${
          attempt + 1
        })`
      );
      await delay(waitMs);
      continue;
    }

    if (res.status >= 400 && res.status < 500) {
      console.warn('[PoE API] Treating fetch error as no listings.');
      return { result: [] };
    }

    throw new Error('[PoE API] Failed to fetch listings');
  }

  throw new Error('[PoE API] Failed to fetch listings after retries');
}

/**
 * Lowest-price stats using dominant currency.
 */
function calculatePriceStatsLowest(prices) {
  if (prices.length === 0) {
    return { min: null, median: null, max: null, results: [] };
  }

  const counts = new Map();
  for (const p of prices) {
    counts.set(p.currency, (counts.get(p.currency) || 0) + 1);
  }

  let dominant = prices[0].currency;
  let bestCount = 0;
  for (const [cur, cnt] of counts.entries()) {
    if (cnt > bestCount) {
      bestCount = cnt;
      dominant = cur;
    }
  }

  const sameCurrency = prices
    .filter((p) => p.currency === dominant)
    .sort((a, b) => a.amount - b.amount);

  const min = sameCurrency[0];
  const max = sameCurrency[sameCurrency.length - 1];

  const amounts = sameCurrency.map((p) => p.amount);
  const mid = Math.floor(amounts.length / 2);
  const medianAmount =
    amounts.length % 2 === 0 && mid > 0
      ? (amounts[mid - 1] + amounts[mid]) / 2
      : amounts[mid];

  const median = { amount: Math.round(medianAmount), currency: dominant };

  return {
    min,
    median,
    max,
    results: prices,
  };
}

/**
 * Realistic median: dominant currency + trim 10% lowest & highest.
 */
function calculatePriceStatsMedian(prices) {
  if (prices.length === 0) {
    return { min: null, median: null, max: null, results: [] };
  }

  const buckets = new Map();
  for (const p of prices) {
    if (!buckets.has(p.currency)) buckets.set(p.currency, []);
    buckets.get(p.currency).push(p.amount);
  }

  let dominant = '';
  let best = 0;
  for (const [cur, arr] of buckets.entries()) {
    if (arr.length > best) {
      best = arr.length;
      dominant = cur;
    }
  }

  let amounts = buckets.get(dominant).slice().sort((a, b) => a - b);

  if (amounts.length > 10) {
    const start = Math.floor(amounts.length * 0.1);
    const end = Math.ceil(amounts.length * 0.9);
    amounts = amounts.slice(start, end);
  }

  const min = { amount: amounts[0], currency: dominant };
  const max = { amount: amounts[amounts.length - 1], currency: dominant };

  const mid = Math.floor(amounts.length / 2);
  const medianAmount =
    amounts.length % 2 === 0 && mid > 0
      ? (amounts[mid - 1] + amounts[mid]) / 2
      : amounts[mid];

  const median = { amount: Math.round(medianAmount), currency: dominant };

  return {
    min,
    median,
    max,
    results: prices,
  };
}

/**
 * POST /price
 * Body: { league: string, item: PoEItem-like }
 */
app.post('/price', async (req, res) => {
  try {
    const { league, item, mode } = req.body || {};

    if (!league || !item) {
      return res
        .status(400)
        .json({ error: 'Missing league or item in request body.' });
    }

    const query = buildSearchQuery(item);
    console.log('[PoE API] Built query:', JSON.stringify(query, null, 2));

    const searchData = await performSearchWithRetries(league, query);

    if (!searchData?.result) {
      return res
        .status(500)
        .json({ error: 'Invalid search response from PoE API.' });
    }

    const resultIds = searchData.result.slice(0, 20);
    const searchUrl = `${POE_TRADE_SITE_URL}/search/${encodeURIComponent(
      league
    )}/${searchData.id}`;

    if (resultIds.length === 0) {
      return res.json({
        priceInfo: {
          totalResults: 0,
          min: null,
          median: null,
          max: null,
          results: [],
        },
        searchUrl,
      });
    }

    const baseFetch = `${POE_TRADE_API_BASE_URL}/fetch/${resultIds.join(',')}`;
    const fetchUrlWithQuery = `${baseFetch}?query=${searchData.id}`;
    const fetchUrlNoQuery = baseFetch;

    const fetchData = await fetchListingsWithRetries(
      fetchUrlWithQuery,
      fetchUrlNoQuery
    );

    const rawResults = fetchData?.result || [];
    console.log('[PoE API] Fetched listings count:', rawResults.length);

    const prices = rawResults.map(parsePrice).filter((p) => p !== null);

    console.log('[PoE API] Parsed prices:', prices);

    const stats =
      mode === 'lowest'
        ? calculatePriceStatsLowest(prices)
        : calculatePriceStatsMedian(prices);

    return res.json({
      priceInfo: {
        ...stats,
        totalResults: searchData.total ?? 0,
      },
      searchUrl,
    });
  } catch (err) {
    console.error('[Backend] Error in /price:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/', (_req, res) => {
  res.send('PoE Price Backend is running.');
});

app.listen(PORT, () => {
  console.log(`PoE Price Backend listening on port ${PORT}`);
});
