// index.js
// Node + Express backend to proxy PoE trade API.
// POST /price  { league, item }  ->  { priceInfo, searchUrl }

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3001;

const POE_TRADE_API_BASE_URL = 'https://www.pathofexile.com/api/trade';
const POE_TRADE_SITE_URL = 'https://www.pathofexile.com/trade';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function buildSearchQuery(item) {
  const query = {
    query: {
      status: { option: 'online' },
      filters: {
        type_filters: { filters: {} },
        misc_filters: { filters: {} }
      }
    },
    sort: { price: 'asc' }
  };

  const filters = query.query.filters;

  if (item.baseType) {
    query.query.type = item.baseType;
  }

  if (item.rarity) {
    filters.type_filters.filters.rarity = {
      option: String(item.rarity).toLowerCase()
    };
  }

  if (Array.isArray(item.influences) && item.influences.length > 0) {
    const influenceMap = {
      Shaper: 'shaper_item',
      Elder: 'elder_item',
      Crusader: 'crusader_item',
      Redeemer: 'redeemer_item',
      Hunter: 'hunter_item',
      Warlord: 'warlord_item'
    };
    const infFilters = {};
    for (const inf of item.influences) {
      const key = influenceMap[inf];
      if (key) infFilters[key] = { option: true };
    }
    Object.assign(filters.misc_filters.filters, infFilters);
  }

  if (item.itemLevel) {
    filters.misc_filters.filters.ilvl = { min: item.itemLevel };
  }

  if (item.links && item.links > 1) {
    query.query.filters.socket_filters = {
      filters: { links: { min: item.links } }
    };
  }

  return query;
}

function parsePrice(listing) {
  const price = listing?.listing?.price;
  if (!price) return null;

  const amount = Number(price.amount);
  const currency = String(price.currency || '').trim();
  if (!currency || Number.isNaN(amount)) return null;

  return { amount, currency };
}

async function performSearchWithRetries(league, query, maxAttempts = 5) {
  const url = `${POE_TRADE_API_BASE_URL}/search/${encodeURIComponent(league)}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await axios.post(url, query, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      });

      console.log('[PoE API] Search OK. total =', res.data.total);
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      const msg =
        body?.error?.message ||
        err.message ||
        String(err);

      console.warn('[PoE API] Search error:', status, msg);

      if (msg.includes('Rate limit exceeded') || status === 429) {
        console.warn(
          `[PoE API] Rate limited on search. Waiting 60s (attempt ${attempt + 1})`
        );
        await delay(60000);
        continue;
      }

      if (msg.includes('Unknown item')) {
        if (query.query?.filters?.type_filters?.filters?.rarity) {
          console.warn(
            '[PoE API] Unknown item. Removing rarity filter and retrying once...'
          );
          delete query.query.filters.type_filters.filters.rarity;
          await delay(500);
          continue;
        }
      }

      if (msg.includes('Invalid query')) {
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

      throw new Error(`[PoE API] Search failed: ${msg}`);
    }
  }

  throw new Error('[PoE API] Max search retries reached');
}

async function fetchListingsWithRetries(fetchUrlWithQuery, fetchUrlNoQuery, maxAttempts = 3) {
  let currentUrl = fetchUrlWithQuery;
  let triedWithoutQuery = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await axios.get(currentUrl, {
        headers: { Accept: 'application/json' }
      });
      console.log('[PoE API] Fetch OK. results =', res.data.result?.length || 0);
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const text = JSON.stringify(err.response?.data || '');
      console.warn(
        `[PoE API] Fetch listings failed (status ${status}) body: ${text.slice(
          0,
          200
        )}`
      );

      if (
        !triedWithoutQuery &&
        status === 400 &&
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

      if (text.includes('Rate limit exceeded') || status === 429 || status >= 500) {
        const waitMs = 1000 * (attempt + 1);
        console.warn(
          `[PoE API] Temporary fetch error. Retrying in ${waitMs}ms... (attempt ${
            attempt + 1
          })`
        );
        await delay(waitMs);
        continue;
      }

      if (status >= 400 && status < 500) {
        console.warn('[PoE API] Treating fetch error as no listings.');
        return { result: [] };
      }

      throw new Error('[PoE API] Failed to fetch listings');
    }
  }

  throw new Error('[PoE API] Failed to fetch listings after retries');
}

function calculatePriceStats(prices) {
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
    results: prices
  };
}

app.post('/price', async (req, res) => {
  try {
    const { league, item } = req.body || {};

    if (!league || !item) {
      return res
        .status(400)
        .json({ error: 'Missing league or item in request body.' });
    }

    const query = buildSearchQuery(item);
    console.log('[PoE API] Built query:', JSON.stringify(query, null, 2));

    const searchData = await performSearchWithRetries(league, query);

    if (!searchData?.result) {
      return res.status(500).json({ error: 'Invalid search response from PoE API.' });
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
          results: []
        },
        searchUrl
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

    const prices = rawResults
      .map(parsePrice)
      .filter((p) => p !== null);

    console.log('[PoE API] Parsed prices:', prices);

    const stats = calculatePriceStats(prices);

    return res.json({
      priceInfo: {
        ...stats,
        totalResults: searchData.total ?? 0
      },
      searchUrl
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
