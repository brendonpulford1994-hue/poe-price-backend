// poe-price-backend/index.js
// Express backend for PoE item pricing with graceful Cloudflare handling.

const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
function log(level, ...args) {
  const levels = { debug: 0, info: 1, error: 2 };
  if (levels[level] >= levels[LOG_LEVEL]) {
    console.log("[Backend]", ...args);
  }
}

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const POE_TRADE_SEARCH = "https://www.pathofexile.com/api/trade/search";
const POE_TRADE_FETCH = "https://www.pathofexile.com/api/trade/fetch";

// -----------------------------
// Helper: extract numbers
// -----------------------------
function extractNumbers(text) {
  if (!text) return null;
  const matches = [...String(text).matchAll(/-?\d+(?:\.\d+)?/g)].map((m) =>
    Number(m[0])
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return { min: matches[0] };
  return { min: matches[0], max: matches[1] };
}

// -----------------------------
// Build PoE Trade Query
// -----------------------------
function buildSearchQuery(item) {
  const query = {
    query: {
      status: { option: "online" },
      filters: {
        type_filters: { filters: {} },
        misc_filters: { filters: {} },
        socket_filters: { filters: {} },
      },
      stats: [],
    },
    sort: { price: "asc" },
  };

  // Name / type selection
  if (item.rarity && item.rarity.toLowerCase() === "unique") {
    if (item.name) query.query.name = item.name;
    if (item.baseType) query.query.type = item.baseType;
  } else {
    if (item.baseType) query.query.type = item.baseType;
    else if (item.name) query.query.type = item.name;
  }

  // Misc filters
  if (item.itemLevel) {
    query.query.filters.misc_filters.filters.ilvl = { min: item.itemLevel };
  }
  if (item.quality) {
    query.query.filters.misc_filters.filters.quality = { min: item.quality };
  }
  if (item.links) {
    query.query.filters.socket_filters.filters.links = { min: item.links };
  }

  // Influences (if present)
  const influenceMap = {
    shaper: "shaper_item",
    elder: "elder_item",
    crusader: "crusader_item",
    redeemer: "redeemer_item",
    hunter: "hunter_item",
    warlord: "warlord_item",
  };
  if (Array.isArray(item.influences)) {
    item.influences.forEach((inf) => {
      const key = influenceMap[String(inf).toLowerCase()];
      if (key) {
        query.query.filters.type_filters.filters[key] = { option: "true" };
      }
    });
  }

  // Stat filters from implicits/explicits
  const statFilters = [];
  const validPrefixes = [
    "explicit.",
    "implicit.",
    "pseudo.",
    "fractured.",
    "crafted.",
    "enchant.",
  ];

  function addMods(mods) {
    if (!Array.isArray(mods)) return;
    mods.forEach((mod) => {
      if (!mod || !mod.statId) return;
      if (!validPrefixes.some((v) => mod.statId.startsWith(v))) return;

      const nums = extractNumbers(mod.text);
      const entry = { id: mod.statId, value: {} };

      if (nums) {
        if (nums.min !== undefined) entry.value.min = nums.min;
        if (nums.max !== undefined) entry.value.max = nums.max;
      }

      statFilters.push(entry);
    });
  }

  addMods(item.implicits);
  addMods(item.explicits);

  if (statFilters.length > 0) {
    query.query.stats.push({ type: "and", filters: statFilters });
  }

  return query;
}

// -----------------------------
// PoE Trade API Helpers
// -----------------------------
async function performSearch(league, query) {
  const url = `${POE_TRADE_SEARCH}/${encodeURIComponent(league)}`;
  try {
    const res = await axios.post(url, query);

    // If we accidentally got an HTML Cloudflare page instead of JSON:
    if (typeof res.data === "string" && res.data.includes("Cloudflare")) {
      log("error", "PoE Search blocked by Cloudflare (HTML response)");
      return null;
    }

    return res.data;
  } catch (err) {
    const data = err.response?.data;

    if (typeof data === "string" && data.includes("Cloudflare")) {
      log("error", "PoE Search blocked by Cloudflare (error response)");
      return null;
    }

    log("error", "PoE Search Error", data || err.message || err);
    return null;
  }
}

async function fetchListings(ids) {
  const CHUNK = 10;
  const listings = [];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const url = `${POE_TRADE_FETCH}/${chunk.join(",")}?query=1`;
    try {
      const res = await axios.get(url);

      if (typeof res.data === "string" && res.data.includes("Cloudflare")) {
        log("error", "PoE Fetch blocked by Cloudflare (HTML)");
        continue;
      }

      if (Array.isArray(res.data.result)) {
        listings.push(...res.data.result);
      }
    } catch (err) {
      const data = err.response?.data;
      if (typeof data === "string" && data.includes("Cloudflare")) {
        log("error", "PoE Fetch blocked by Cloudflare (error response)");
      } else {
        log("error", "PoE Fetch Error", data || err.message || err);
      }
    }
  }

  return listings;
}

// -----------------------------
// Optional: /analyze endpoint
// -----------------------------
app.post("/analyze", (req, res) => {
  try {
    const item = req.body.item || null;
    return res.json({ item });
  } catch (err) {
    log("error", "Analyze Error", err);
    res.status(500).json({ error: "Analyze failed" });
  }
});

// -----------------------------
// /price endpoint with safe fallback
// -----------------------------
app.post("/price", async (req, res) => {
  try {
    const { league, item } = req.body;

    log("info", "/price called with:", { league, itemName: item?.name, baseType: item?.baseType });

    const query = buildSearchQuery(item);
    const search = await performSearch(league, query);

    // If PoE trade API is blocked / fails / returns no usable result
    if (!search || !Array.isArray(search.result)) {
      log("error", "PoE trade search unavailable; returning fallback priceInfo.");

      return res.json({
        priceInfo: {
          min: null,
          median: null,
          max: null,
          results: [],
          totalResults: 0,
        },
        searchUrl: "https://www.pathofexile.com/trade",
      });
    }

    const ids = search.result.slice(0, 40);
    const listings = await fetchListings(ids);

    const prices = listings
      .map((l) => l.listing?.price?.amount)
      .filter((n) => typeof n === "number")
      .sort((a, b) => a - b);

    let min = null;
    let median = null;
    let max = null;

    if (prices.length > 0) {
      min = prices[0];
      max = prices[prices.length - 1];
      median = prices[Math.floor(prices.length / 2)];
    }

    return res.json({
      priceInfo: {
        min,
        median,
        max,
        results: prices,
        totalResults: search.total,
      },
      searchUrl: `https://www.pathofexile.com/trade/search/${league}/${search.id}`,
    });
  } catch (err) {
    log("error", "Price Error", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// -----------------------------
app.listen(PORT, () => {
  log("info", `Backend listening on port ${PORT}`);
});
