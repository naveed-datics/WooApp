/**
 * Centralized Store Pricing Engine
 *
 * Supports:
 * 1. Product fixed selling-price override
 * 2. Product custom markup % override
 * 3. Store price-range rules (deterministic boundaries: min < cost <= max, with 0 <= cost <= max for 0-min)
 * 4. Store fallback markup % (for price range gaps)
 * 5. Store legacy markup % override (e.g. Store 4 +177%)
 * 6. Super-admin global default markup %
 * 7. Fallback to cost (sell = cost)
 */

export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function round2(value) {
  if (value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100) / 100
}

export function formatMoney(value) {
  const n = toNumber(value)
  if (n === null) return '-'
  return `£${n.toFixed(2)}`
}

export function parsePriceRuleInput(value) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) {
    throw new Error('Price rule percent must be a number')
  }
  return n
}

/**
 * Resolves raw supplier cost from a product/variation record or CSV row.
 * Cost is regular_price ?? price.
 *
 * @param {{ regular_price?: any, price?: any }|null|undefined} row
 * @returns {number|null}
 */
export function resolveCostPrice(row) {
  if (!row) return null
  const regular = toNumber(row.regular_price)
  if (regular !== null) return regular
  return toNumber(row.price)
}

/**
 * Sorts pricing rules deterministically by numeric min_cost ascending,
 * ensuring calculation accuracy regardless of UI sort order.
 *
 * @param {Array<object>} rules
 * @returns {Array<object>}
 */
export function sortPricingRules(rules) {
  if (!Array.isArray(rules)) return []
  return [...rules].sort((a, b) => {
    const minA = toNumber(a.min_cost) ?? 0
    const minB = toNumber(b.min_cost) ?? 0
    if (minA !== minB) return minA - minB

    const maxA = a.max_cost !== null && a.max_cost !== undefined ? toNumber(a.max_cost) : Infinity
    const maxB = b.max_cost !== null && b.max_cost !== undefined ? toNumber(b.max_cost) : Infinity
    return maxA - maxB
  })
}

/**
 * Validates an array of price range rules.
 *
 * Checks:
 * - Negative minimum cost
 * - Negative markup percentage
 * - Invalid numbers
 * - max_cost <= min_cost
 * - Multiple open-ended rules
 * - Rules configured after an open-ended rule
 * - Overlapping boundaries
 * - Detects gaps between ranges
 *
 * @param {Array<object>} rules
 * @param {{ fallbackMarkup?: number|null, requireContinuous?: boolean }} [options]
 * @returns {{ valid: boolean, errors: string[], sortedRules: Array<object>, hasGaps: boolean, gaps: Array<{ from: number, to: number }> }}
 */
export function validatePricingRules(rules, options = {}) {
  const errors = []
  if (!Array.isArray(rules) || rules.length === 0) {
    return { valid: true, errors: [], sortedRules: [], hasGaps: false, gaps: [] }
  }

  const sortedRules = sortPricingRules(rules)
  let openEndedFound = false
  const gaps = []

  for (let i = 0; i < sortedRules.length; i++) {
    const rule = sortedRules[i]
    const min = toNumber(rule.min_cost)
    const max = rule.max_cost !== null && rule.max_cost !== undefined && rule.max_cost !== '' ? toNumber(rule.max_cost) : null
    const markup = toNumber(rule.markup_percent)

    if (min === null || min < 0) {
      errors.push(`Rule #${i + 1}: Minimum cost must be a non-negative number.`)
    }

    if (markup === null || markup < 0) {
      errors.push(`Rule #${i + 1}: Markup percent must be a non-negative number.`)
    }

    if (max !== null) {
      if (min !== null && max <= min) {
        errors.push(`Rule #${i + 1}: Maximum cost (£${max}) must be greater than minimum cost (£${min}).`)
      }
    } else {
      if (openEndedFound) {
        errors.push(`Rule #${i + 1}: Only one open-ended rule (with no upper limit) is allowed.`)
      }
      openEndedFound = true
    }

    if (openEndedFound && i < sortedRules.length - 1) {
      errors.push(`Rule #${i + 2}: Cannot configure additional rules after an open-ended rule.`)
    }

    // Check overlap & gaps with subsequent rule
    if (i < sortedRules.length - 1) {
      const nextRule = sortedRules[i + 1]
      const nextMin = toNumber(nextRule.min_cost)

      if (max !== null && nextMin !== null) {
        if (nextMin < max) {
          errors.push(
            `Overlapping ranges detected: Rule [£${min} to £${max}] overlaps with next rule starting at £${nextMin}.`
          )
        } else if (nextMin > max) {
          gaps.push({ from: max, to: nextMin })
        }
      }
    }
  }

  const hasGaps = gaps.length > 0
  if (hasGaps && options.requireContinuous && (options.fallbackMarkup === null || options.fallbackMarkup === undefined)) {
    errors.push(
      `Price ranges have gaps (${gaps.map((g) => `£${g.from}–£${g.to}`).join(', ')}). A fallback markup % is required.`
    )
  }

  return {
    valid: errors.length === 0,
    errors,
    sortedRules,
    hasGaps,
    gaps,
  }
}

/**
 * Pure Centralized Pricing Resolver.
 *
 * Priority Hierarchy:
 * 1. Product fixed selling-price override
 * 2. Product custom markup % override
 * 3. Store price-range rules (when pricing_mode === 'range_rules')
 * 4. Store fallback markup % (when pricing_mode === 'range_rules' and cost falls in a gap)
 * 5. Store legacy markup % override (stores.price_rule_percent)
 * 6. Super-admin default markup % (app_settings.default_price_rule_percent)
 * 7. Cost price fallback (sell = cost)
 *
 * @param {number|string|null|undefined} rawCost - Raw supplier cost (e.g. 8.00)
 * @param {object} [storeContext] - { pricing_mode, price_rule_percent, fallback_markup_percent, default_price_rule_percent, defaultPercent }
 * @param {Array<object>} [rangeRules] - Active store_pricing_rules records
 * @param {object|null} [productOverride] - { override_type, custom_markup_percent, fixed_price }
 * @returns {{ sellingPrice: number|null, source: string, appliedMarkup: number|null, matchedRuleId: number|string|null, cost: number|null }}
 */
export function resolveItemPrice(rawCost, storeContext = {}, rangeRules = [], productOverride = null) {
  const cost = toNumber(rawCost)
  if (cost === null) {
    return {
      sellingPrice: null,
      source: 'none',
      appliedMarkup: null,
      matchedRuleId: null,
      cost: null,
    }
  }

  // ── Priority 1: Product Fixed Selling-Price Override ─────────────────────
  if (productOverride && productOverride.override_type === 'fixed_price') {
    const fixed = toNumber(productOverride.fixed_price)
    if (fixed !== null && fixed >= 0) {
      return {
        sellingPrice: round2(fixed),
        source: 'product_fixed',
        appliedMarkup: null,
        matchedRuleId: null,
        cost,
      }
    }
  }

  // ── Priority 2: Product Custom Markup % Override ────────────────────────
  if (productOverride && productOverride.override_type === 'custom_markup') {
    const customMarkup = toNumber(productOverride.custom_markup_percent)
    if (customMarkup !== null && customMarkup >= 0) {
      return {
        sellingPrice: round2(cost * (1 + customMarkup / 100)),
        source: 'product_custom_markup',
        appliedMarkup: customMarkup,
        matchedRuleId: null,
        cost,
      }
    }
  }

  // ── Priority 3: Store Price-Range Rules ──────────────────────────────────
  const pricingMode = storeContext.pricing_mode || 'legacy_markup'
  if (pricingMode === 'range_rules' && Array.isArray(rangeRules) && rangeRules.length > 0) {
    const activeRules = rangeRules.filter((r) => r.active !== false)
    const sorted = sortPricingRules(activeRules)

    const matchedRule = sorted.find((rule) => {
      const min = toNumber(rule.min_cost) ?? 0
      const max = rule.max_cost !== null && rule.max_cost !== undefined && rule.max_cost !== ''
        ? toNumber(rule.max_cost)
        : null

      // Boundary Model:
      // Lowest tier starting at 0: 0 <= cost <= max (or open-ended)
      // Higher tiers: min < cost <= max (or cost > min for open-ended)
      if (min === 0) {
        return max === null ? cost >= 0 : cost >= 0 && cost <= max
      }
      return max === null ? cost > min : cost > min && cost <= max
    })

    if (matchedRule) {
      const markup = toNumber(matchedRule.markup_percent) ?? 0
      return {
        sellingPrice: round2(cost * (1 + markup / 100)),
        source: 'range_rule',
        appliedMarkup: markup,
        matchedRuleId: matchedRule.id ?? null,
        cost,
      }
    }

    // ── Priority 4: Store Fallback Markup % (Gap Fallback) ─────────────────
    const fallback = toNumber(storeContext.fallback_markup_percent)
    if (fallback !== null && fallback >= 0) {
      return {
        sellingPrice: round2(cost * (1 + fallback / 100)),
        source: 'store_fallback_markup',
        appliedMarkup: fallback,
        matchedRuleId: null,
        cost,
      }
    }
  }

  // ── Priority 5: Store Legacy Markup % Override ──────────────────────────
  const storeLegacy = toNumber(storeContext.price_rule_percent ?? storeContext.override)
  if (storeLegacy !== null && storeLegacy >= 0) {
    return {
      sellingPrice: round2(cost * (1 + storeLegacy / 100)),
      source: 'store_legacy_override',
      appliedMarkup: storeLegacy,
      matchedRuleId: null,
      cost,
    }
  }

  // ── Priority 6: Super-Admin Global Default Markup % ──────────────────────
  const superDefault = toNumber(
    storeContext.default_price_rule_percent ?? storeContext.defaultPercent
  )
  if (superDefault !== null && superDefault >= 0) {
    return {
      sellingPrice: round2(cost * (1 + superDefault / 100)),
      source: 'super_admin_default',
      appliedMarkup: superDefault,
      matchedRuleId: null,
      cost,
    }
  }

  // ── Priority 7: Raw Cost Price Fallback ──────────────────────────────────
  return {
    sellingPrice: round2(cost),
    source: 'cost_price',
    appliedMarkup: 0,
    matchedRuleId: null,
    cost,
  }
}

/**
 * Backward-compatible helper: applies a flat percentage markup on a cost.
 *
 * @param {number|string|null|undefined} cost
 * @param {number|string|null|undefined} percent
 * @returns {number|null}
 */
export function applyPriceRule(cost, percent) {
  const c = toNumber(cost)
  if (c === null) return null

  const pct = toNumber(percent)
  if (pct === null) return c

  return round2(c * (1 + pct / 100))
}

/**
 * Backward-compatible helper: resolves effective flat percentage.
 *
 * @param {{ price_rule_percent?: any }|null|undefined} store
 * @param {number|string|null|undefined} defaultPercent
 * @returns {number|null}
 */
export function resolveEffectivePercent(store, defaultPercent = null) {
  const override = toNumber(store?.price_rule_percent)
  if (override !== null) return override
  return toNumber(defaultPercent)
}

/**
 * Main backward-compatible entry point used throughout WooApp.
 * Computes selling price for any product or variation row.
 *
 * @param {{ regular_price?: any, price?: any }} row
 * @param {object|null|undefined} store
 * @param {number|string|null|undefined} [defaultPercent]
 * @param {object|null} [productOverride]
 * @param {Array<object>} [rangeRules]
 * @returns {number|null}
 */
export function resolveStorePrice(
  row,
  store = {},
  defaultPercent = null,
  productOverride = null,
  rangeRules = []
) {
  const cost = resolveCostPrice(row)
  if (cost === null) return null

  const storeContext = {
    pricing_mode: store?.pricing_mode || 'legacy_markup',
    price_rule_percent: store?.price_rule_percent,
    fallback_markup_percent: store?.fallback_markup_percent,
    default_price_rule_percent: defaultPercent ?? store?.default_price_rule_percent,
    defaultPercent: defaultPercent ?? store?.defaultPercent,
  }

  const result = resolveItemPrice(cost, storeContext, rangeRules, productOverride)
  return result.sellingPrice
}
