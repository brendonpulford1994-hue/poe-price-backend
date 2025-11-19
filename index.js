// index.js - PoE price backend
// Express server that takes an item payload and queries the official PoE Trade API.

// Install deps in this folder:
//   npm install express cors axios

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Base URLs for PoE trade
const POE_TRADE_API_BASE_URL = 'https://www.pathofexile.com/api/trade';
const POE_TRADE_SITE_URL = 'https://www.pathofexile.com/trade';

// Helper: wait
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Build a PoE trade search query JSON from a PoEItem object.
 * This is the backend equivalent of what we had in the frontend.
 */
function buildSearchQuery(item) {
  const query = {
    query: {
      status: { option: 'online' },
      filters: {
        type_filters: { filters: {} },
        misc_filters: { filters: {} }
      },
      stats: [
        {
          type: 'and',
          filters: []
        }
      ]
    },
    sort: { price: 'asc' }
  };

  const q = query.query;

  // Name / type logic
  if (item.rarity === 'Unique' && item.name) {
    // For uniques, prefer both name and type
    q.name = item.name;
    if (item.baseType) {
      q.type = item.baseType;
    }
  } else if (item.baseType) {
    q.type = item.baseType;
  }

  // Rarity filter (simple mapping)
  if (item.rarity) {
    const rarityMap = {
      Normal: 'normal',
      Magic: 'magic',
      Rare: 'rare',
      Unique: 'unique'
    };
    const mapped = rarityMap[item.rarity] || item.rarity.toLowerCase();
    q.filters.type_filters.filters.rarity = { option: mapped };
  }

  // Item level
  if (item.itemLevel) {
    q.filters.misc_filters.filters.ilvl = { min: item.itemLevel };
  }

  // Links
  if (item.links && item.links > 0) {
    q.filters.socket_filters = {
      filters: {
        links: { min: item.links }
      }
    };
  }

  // Stat filters: combine implicits and explicits.
  // We rely on the frontend (Gemini + Awakened DB) to send correct trade stat IDs.
  const allMods = [...(item.implicits || []), ...(item.explicits || [])];
  const seen = new Set();

  for (const mod of allMods) {
    const id = mod && mod.statId;
    if (!id || typeof id !== 'string') continue;

    // Very basic sanity: want something like "explicit.xxx" or "pseudo.xxx", etc.
    if (!/^[a-z]+\./i.test(id)) continue;

    if (seen.has(id)) continue;
    seen.add(id);

    q.stats[0].filters.push({
      id,
      disabled: false
    });
  }

  // If we ended up with no stats, remove the stats block entirely.
  if (q.stats[0].filters.length === 0) {
    delete q.stats;
  }

  return query;
}

/**
 * Parse a listing into our Price shape.
 */
function parsePrice(listing) {
  const price = listing?.listing?.price;
  if (!price) return null;

  const { amount, currency } = price;
  if (currency !== 'chaos' && currency !== 'divine') return null;

  return { amount, currency };
}

/**
 * Calculate "lowest" style stats – picks min/median/max for the cheapest currency.
 */
function calculatePriceStatsLowest(prices) {
  if (!prices || prices.length === 0) {
    return { min: null, median: null, max: null, results: [] };
  }

  // Sort by currency then amount
  const sorted = prices.slice().sort((a, b) => {
    if (a.currency === b.currency) return a.amount - b.amount;
    if (a.currency === 'chaos') return -1;
    if (b.currency === 'chaos') return 1;
    return a.currency.localeCompare(b.currency);
  });

  const min = sorted[0];
  const sameCurrency = sorted.filter((p) => p.currency === min.currency);
  const amounts = sameCurrency.map((p) => p.amount).sort((a, b) => a - b);

  const max = { amount: amounts[amounts.length - 1], currency: min.currency };

  const mid = Math.floor(amounts.length / 2);
  const medianAmount =
    amounts.length % 2 === 0 && mid > 0
      ? (amounts[mid - 1] + amounts[mid]) / 2
      : amounts[mid];

  const median = { amount: Math.round(medianAmount), currency: min.currency };

  return {
    min,
    median,
    max,
    results: prices
  };
}

/**
 * "Realistic median" stats – choose dominant currency, trim 10% extremes.
 */
function calculatePriceStatsMedian(prices) {
  if (!prices || prices.length === 0) {
    return { min: null, median: null, max: null, results: [] };
  }

  const chaos = prices
    .filter((p) => p.currency === 'chaos')
    .map((p) => p.amount)
    .sort((a, b) => a - b);
  const divine = prices
    .filter((p) => p.currency === 'divine')
    .map((p) => p.amount)
    .sort((a, b) => a - b);

  let dominant = 'chaos';
  if (divine.length > chaos.length && divine.length > 0) {
    dominant = 'divine';
  }

  let base = dominant === 'chaos' ? chaos : divine;
  if (base.length === 0) {
    // fallback to lowest stats if we don't have dominant currency
    return calculatePriceStatsLowest(prices);
  }

  let trimmed = base;
  if (base.length > 10) {
    const start = Math.floor(base.length * 0.1);
    const end = Math.ceil(base.length * 0.9);
    trimmed = base.slice(start, end);
  }

  const min = { amount: trimmed[0], currency: dominant };
  const max = { amount: trimmed[trimmed.length - 1], currency: dominant };

  const mid = Math.floor(trimmed.length / 2);
  const medianAmount =
    trimmed.length % 2 === 0 && mid > 0
      ? (trimmed[mid - 1] + trimmed[mid]) / 2
      : trimmed[mid];

  const median = { amount: Math.round(medianAmount), currency: dominant };

  return {
    min,
    median,
    max,
    results: prices
  };
}

/**
 * Perform the trade search with retries and some basic error handling.
 */
async function performSearchWithRetries(league, query, maxAttempts = 5) {
  const url = `${POE_TRADE_API_BASE_URL}/search/${encodeURIComponent(league)}`;

  let strippedStats = false;
  let strippedFilters = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await axios.post(url, query, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          // IMPORTANT: set a user agent with contact info (you should change this email)
          'User-Agent': 'poe-ai-pricer/1.0 (contact: your-email@example.com)'
        },
        // Slight timeout so we don't hang forever
        timeout: 15000
      });

      if (res.data && !res.data.error) {
        return res.data;
      }

      const apiError = res.data && res.data.error && res.data.error.message;
      if (apiError) {
        throw new Error(apiError);
      } else {
        throw new Error(`Search returned error with unknown format`);
      }
    } catch (err) {
      const resp = err.response;
      const status = resp ? resp.status : null;
      const message =
        resp?.data?.error?.message || err.message || `HTTP ${status || 'unknown'}`;

      console.warn('[PoE API] Search error:', status, message);

      // Rate limiting
      if (
        status === 429 ||
        /rate limit exceeded/i.test(message)
      ) {
        const wait = 1000 * (attempt + 1);
        console.warn(`[PoE API] Rate limit. Retrying in ${wait}ms...`);
        await delay(wait);
        continue;
      }

      // Access forbidden (403) – usually needs GGG whitelisting / permission
      if (status === 403) {
        throw new Error('[PoE API] Search failed: Request failed with status code 403');
      }

      // Invalid query: try stripping stats, then ilvl/links
      if (status === 400 && /invalid query/i.test(message)) {
        const q = query.query;

        if (!strippedStats && q.stats) {
          console.warn('[PoE API] Invalid query. Stripping all stats and retrying...');
          delete q.stats;
          strippedStats = true;
          await delay(500);
          continue;
        }

        if (!strippedFilters) {
          console.warn(
            '[PoE API] Invalid query. Stripping ilvl/links filters and retrying...'
          );
          if (q.filters?.misc_filters?.filters?.ilvl) {
            delete q.filters.misc_filters.filters.ilvl;
          }
          if (q.filters?.socket_filters) {
            delete q.filters.socket_filters;
          }
          strippedFilters = true;
          await delay(500);
          continue;
        }
      }

      // For other 4xx or 5xx, bail out with error
      throw new Error(`[PoE API] Search failed: ${message}`);
    }
  }

  throw new Error('[PoE API] Max search retries reached');
}

/**
 * Fetch listings for given result IDs.
 * If we get a 400 "Invalid query", we treat it as "no listings" instead of crashing.
 */
async function fetchListingsWithRetries(queryId, resultIds, maxAttempts = 3) {
  if (!resultIds || resultIds.length === 0) {
    return { result: [] };
  }

  const baseUrl = `${POE_TRADE_API_BASE_URL}/fetch/${resultIds.join(',')}`;
  let url = `${baseUrl}?query=${queryId}`;
  let triedWithoutQueryParam = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'poe-ai-pricer/1.0 (contact: your-email@example.com)'
        },
        timeout: 15000
      });

      if (res.data && !res.data.error) {
        return res.data;
      }
      const apiError = res.data && res.data.error && res.data.error.message;
      throw new Error(apiError || 'Unknown fetch error');
    } catch (err) {
      const resp = err.response;
      const status = resp ? resp.status : null;
      const message =
        resp?.data?.error?.message || err.message || `HTTP ${status || 'unknown'}`;

      console.warn('[PoE API] Fetch listings error:', status, message);

      if (
        status === 429 ||
        /rate limit exceeded/i.test(message)
      ) {
        const wait = 1000 * (attempt + 1);
        console.warn(`[PoE API] Fetch rate limit. Retrying in ${wait}ms...`);
        await delay(wait);
        continue;
      }

      // Some weird "Invalid query" responses on fetch: try without ?query= param, then treat as no listings
      if (status === 400 && /invalid query/i.test(message)) {
        if (!triedWithoutQueryParam) {
          console.warn(
            '[PoE API] Fetch invalid query with ?query=. Retrying once without query param...'
          );
          url = baseUrl; // drop ?query
          triedWithoutQueryParam = true;
          await delay(500);
          continue;
        }

        console.warn('[PoE API] Treating fetch error as no listings.');
        return { result: [] };
      }

      // Any other 4xx: treat as no listings instead of crashing
      if (status && status >= 400 && status < 500) {
        console.warn('[PoE API] 4xx on fetch. Treating as no listings.');
        return { result: [] };
      }

      // 5xx: retry a couple of times, then bail
      if (status && status >= 500) {
        const wait = 1000 * (attempt + 1);
        console.warn(
          `[PoE API] Server error on fetch. Retrying in ${wait}ms...`
        );
        await delay(wait);
        continue;
      }

      throw new Error(`[PoE API] Fetch failed: ${message}`);
    }
  }

  throw new Error('[PoE API] Failed to fetch listings after retries');
}

/**
 * Main helper: full price flow.
 * mode: 'median' (default) or 'lowest'
 */
async function fetchPriceData(league, item, mode = 'median') {
  const query = buildSearchQuery(item);
  console.log('[PoE API] Built query:', JSON.stringify(query, null, 2));

  const searchData = await performSearchWithRetries(league, query);

  if (!searchData || !Array.isArray(searchData.result)) {
    throw new Error('[PoE API] Invalid search response');
  }

  const resultIds = searchData.result.slice(0, 20);
  const searchUrl = `${POE_TRADE_SITE_URL}/search/${encodeURIComponent(
    league
  )}/${searchData.id}`;

  if (resultIds.length === 0) {
    return {
      priceInfo: {
        totalResults: searchData.total || 0,
        min: null,
        median: null,
        max: null,
        results: []
      },
      searchUrl
    };
  }

  const fetchData = await fetchListingsWithRetries(searchData.id, resultIds);

  if (!fetchData || !Array.isArray(fetchData.result)) {
    return {
      priceInfo: {
        totalResults: searchData.total || 0,
        min: null,
        median: null,
        max: null,
        results: []
      },
      searchUrl
    };
  }

  const prices = fetchData.result
    .map(parsePrice)
    .filter((p) => p !== null);

  console.log('[PoE API] Fetched listings count:', fetchData.result.length);
  console.log('[PoE API] Parsed prices:', prices);

  const stats =
    mode === 'lowest'
      ? calculatePriceStatsLowest(prices)
      : calculatePriceStatsMedian(prices);

  return {
    priceInfo: {
      ...stats,
      totalResults: searchData.total
    },
    searchUrl
  };
}

/**
 * HTTP endpoint: POST /price
 * Body example:
 * {
 *   "league": "Standard",
 *   "mode": "median",
 *   "item": { ...PoEItem from frontend... }
 * }
 */
app.post('/price', async (req, res) => {
  try {
    const { league, mode, item } = req.body || {};

    if (!league || !item) {
      return res
        .status(400)
        .json({ error: 'Missing league or item in request body.' });
    }

    console.log('[Backend] /price called with:', {
      league,
      mode,
      itemSummary: {
        rarity: item.rarity,
        name: item.name,
        baseType: item.baseType
      }
    });

    const result = await fetchPriceData(league, item, mode || 'median');
    return res.json(result);
  } catch (err) {
    console.error('[Backend] /price error:', err.message || err);
    return res
      .status(500)
      .json({ error: err.message || 'Unexpected backend error.' });
  }
});

// Basic health check
app.get('/', (req, res) => {
  res.send('PoE price backend is running.');
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`PoE price backend listening on port ${PORT}`);
});
