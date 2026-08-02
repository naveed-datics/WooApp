import { NextResponse } from 'next/server'
import { authenticateExportRequest } from '../../../lib/export-auth'
import db from '../../../lib/db'

/**
 * Lightweight connectivity/diagnostics check for the WordPress "WooApp
 * Connector" plugin's "Test Connection" button. Verifies the store_id +
 * x-api-key pair is valid and reports how many products are currently
 * available to import, without transferring the full product payload.
 *
 * Counts are scoped to vendors assigned to the authenticated store.
 */
export async function GET(request) {
  try {
    const auth = await authenticateExportRequest(request)

    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const counts = await db.query(
      `SELECT
        COUNT(*) FILTER (WHERE p.status = 'approved') AS exportable_products,
        COUNT(*) AS total_products
       FROM products p
       INNER JOIN vendor_stores vs ON vs.vendor_id = p.vendor_id AND vs.store_id = $1`,
      [auth.store.id]
    )

    return NextResponse.json({
      ok: true,
      store: auth.store,
      exportable_products: parseInt(counts.rows[0].exportable_products, 10),
      total_products: parseInt(counts.rows[0].total_products, 10),
      server_time: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Error in export ping:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
