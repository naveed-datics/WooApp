const db = require('./db')

/**
 * Authenticates a server-to-server export request (used by the WordPress
 * "WooApp Connector" plugin, which pulls product data from WooApp rather
 * than WooApp pushing into WooCommerce - this avoids WooApp needing to
 * reach a WooCommerce REST API that may not be publicly reachable, e.g.
 * a local Local-by-Flywheel site).
 *
 * The caller must supply:
 *   - `store_id` as a query parameter
 *   - `x-api-key` header matching that store's `export_api_key` column
 *
 * @param {Request} request
 * @returns {Promise<{ ok: true, store: { id: number, name: string } } | { ok: false, status: number, error: string }>}
 */
async function authenticateExportRequest(request) {
  const { searchParams } = new URL(request.url)
  const storeId = searchParams.get('store_id')
  const apiKey = request.headers.get('x-api-key')

  if (!storeId) {
    return { ok: false, status: 400, error: 'Missing required query parameter: store_id' }
  }

  if (!apiKey) {
    return { ok: false, status: 401, error: 'Missing required header: x-api-key' }
  }

  const result = await db.query(
    'SELECT id, name, export_api_key, price_rule_percent FROM stores WHERE id = $1 LIMIT 1',
    [storeId]
  )

  if (result.rows.length === 0) {
    return { ok: false, status: 404, error: `Store ${storeId} not found` }
  }

  const store = result.rows[0]

  if (!store.export_api_key || store.export_api_key !== apiKey) {
    return { ok: false, status: 401, error: 'Invalid API key for this store' }
  }

  return {
    ok: true,
    store: {
      id: store.id,
      name: store.name,
      price_rule_percent: store.price_rule_percent,
    },
  }
}

module.exports = { authenticateExportRequest }
