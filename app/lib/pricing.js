/**
 * Store price rule helpers.
 *
 * Markup: store_price = cost × (1 + price_rule_percent / 100)
 * e.g. 40 → ×1.40. If percent is null/empty, return cost unchanged.
 */

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/**
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
 * Cost is Ralawise/CSV: regular_price ?? price.
 *
 * @param {{ regular_price?: any, price?: any }} row
 * @returns {number|null}
 */
export function resolveCostPrice(row) {
  const regular = toNumber(row?.regular_price)
  if (regular !== null) return regular
  return toNumber(row?.price)
}

/**
 * Store price applies the store's markup rule, or falls back to cost.
 *
 * @param {{ regular_price?: any, price?: any }} row
 * @param {{ price_rule_percent?: any }|null|undefined} store
 * @returns {number|null}
 */
export function resolveStorePrice(row, store) {
  const cost = resolveCostPrice(row)
  return applyPriceRule(cost, store?.price_rule_percent)
}

export function formatMoney(value) {
  const n = toNumber(value)
  if (n === null) return '-'
  return `£${n.toFixed(2)}`
}
