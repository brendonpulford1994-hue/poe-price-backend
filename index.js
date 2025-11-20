function buildSearchQuery(item) {
  const query = {
    query: {
      status: { option: 'online' },
      filters: {
        type_filters: { filters: {} },
        misc_filters: { filters: {} }
      },
      // we'll fill stats below
      stats: [
        {
          type: 'and',
          filters: []
        }
      ]
    },
    sort: { price: 'asc' }
  };

  const filters = query.query.filters;
  const statGroup = query.query.stats[0];
  const statFilters = statGroup.filters;

  // ---------- BASIC FILTERS (what you already had) ----------

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
    if (Object.keys(infFilters).length > 0) {
      filters.misc_filters.filters.influences = infFilters;
    }
  }

  if (typeof item.itemLevel === 'number') {
    filters.misc_filters.filters.ilvl = { min: item.itemLevel };
  }

  if (item.links && item.links > 1) {
    query.query.filters.socket_filters = {
      filters: { links: { min: item.links } }
    };
  }

  // ---------- NEW: STAT FILTERS FROM statId ----------

  // helper to avoid duplicate stat IDs
  const seenStatIds = new Set();

  function addStatFromMod(mod) {
    if (!mod || !mod.statId) return;
    const id = String(mod.statId);
    if (!id || seenStatIds.has(id)) return;

    seenStatIds.add(id);

    statFilters.push({
      id,
      type: 'and',          // 👈 REQUIRED so PoE actually uses this filter
      disabled: false,
      // no min/max: "has this mod with any roll"
      value: {
        min: null,
        max: null
      }
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

  // if we somehow didn't add any stats, keep an empty AND group
  // (PoE trade expects stats to exist, but an empty filters array is fine)
  if (statFilters.length === 0) {
    query.query.stats = [
      {
        type: 'and',
        filters: []
      }
    ];
  }

  return query;
}
