import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'

/**
 * Best-effort trigger for a "plugin" connection-method store: calls the
 * WooApp Connector plugin's own REST endpoint so an admin can pull
 * products in immediately instead of switching to wp-admin. Only works
 * when WooApp can reach the store's base URL over HTTP - "Import Now" in
 * wp-admin (or the plugin's own schedule) remains the reliable fallback
 * when it can't, since this plugin is designed around WooApp never
 * needing to reach into WordPress.
 */
export async function POST(request, { params }) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const storeId = parseInt(id)
    const body = await request.json().catch(() => ({}))
    const fullResync = Boolean(body.full_resync)

    if (session.user.role !== 'super_admin') {
      const accessCheck = await db.query(
        'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
        [session.user.id, storeId]
      )

      if (accessCheck.rows.length === 0) {
        return NextResponse.json(
          { error: 'Unauthorized access to this store' },
          { status: 403 }
        )
      }
    }

    const storeResult = await db.query(
      'SELECT id, name, store_url, export_api_key, connection_method FROM stores WHERE id = $1',
      [storeId]
    )

    if (storeResult.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const store = storeResult.rows[0]

    if (store.connection_method !== 'plugin') {
      return NextResponse.json(
        { error: 'This store does not use the WooApp Connector plugin - nothing to trigger.' },
        { status: 400 }
      )
    }

    if (!store.store_url || !store.export_api_key) {
      return NextResponse.json(
        { error: 'This store is missing its base URL or export API key.' },
        { status: 400 }
      )
    }

    const triggerUrl = `${store.store_url.replace(/\/$/, '')}/wp-json/wooapp-connector/v1/trigger-import`

    let response
    try {
      response = await fetch(triggerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': store.export_api_key,
        },
        body: JSON.stringify({ full_resync: fullResync }),
        signal: AbortSignal.timeout(30000),
      })
    } catch (fetchError) {
      return NextResponse.json(
        {
          error: `Could not reach ${store.store_url} (${fetchError.message}). If this store isn't reachable from WooApp, use "Import Now" in that site's wp-admin → WooApp Connector instead.`,
        },
        { status: 502 }
      )
    }

    const data = await response.json().catch(() => null)

    if (!response.ok) {
      return NextResponse.json(
        { error: data?.message || `WordPress rejected the trigger request (HTTP ${response.status}).` },
        { status: response.status }
      )
    }

    await db.query('UPDATE stores SET last_sync_at = CURRENT_TIMESTAMP WHERE id = $1', [storeId])

    // WordPress reports back exactly which SKUs it created/updated this
    // run - mark only those as synced. A product can still legitimately
    // show 'approved' after this if it was already synced in an earlier
    // run and fell outside this run's incremental window.
    const syncedSkus = Array.isArray(data.synced_skus) ? data.synced_skus.filter(Boolean) : []
    if (syncedSkus.length > 0) {
      await db.query(
        `UPDATE product_stores ps
         SET status = 'synced', updated_at = CURRENT_TIMESTAMP
         FROM products p
         WHERE ps.product_id = p.id AND ps.store_id = $1 AND p.sku = ANY($2::text[])`,
        [storeId, syncedSkus]
      )
    }

    return NextResponse.json({ message: 'Import triggered successfully', progress: data, syncedCount: syncedSkus.length })
  } catch (error) {
    console.error('Error triggering import:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to trigger import' },
      { status: 500 }
    )
  }
}
