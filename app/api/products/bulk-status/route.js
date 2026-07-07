import { NextResponse } from 'next/server'
import { requireAdmin } from '../../../lib/auth'
import db from '../../../lib/db'
import { auth } from '../../auth/[...nextauth]/route'

export async function PUT(request) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { productIds, status, store_id: storeId } = body

    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return NextResponse.json(
        { error: 'Product IDs are required' },
        { status: 400 }
      )
    }

    if (!storeId) {
      return NextResponse.json(
        { error: 'store_id is required' },
        { status: 400 }
      )
    }

    if (!['approved', 'rejected'].includes(status)) {
      return NextResponse.json(
        { error: 'Invalid status' },
        { status: 400 }
      )
    }

    // Placeholders start at $4 - $1..$3 are status/reviewed_by/store_id.
    const placeholders = productIds.map((_, i) => `$${i + 4}`).join(',')

    const result = await db.query(
      `UPDATE product_stores
       SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE store_id = $3 AND product_id IN (${placeholders}) AND status = 'pending'
       RETURNING product_id`,
      [status, session.user.id, storeId, ...productIds]
    )

    // If products are being approved, also approve all associated variations
    // (variation status stays global, not per-store).
    let variationsApproved = 0
    if (status === 'approved' && result.rows.length > 0) {
      const approvedProductIds = result.rows.map((r) => r.product_id)
      const productIdsPlaceholders = approvedProductIds.map((_, i) => `$${i + 1}`).join(',')
      const variationsResult = await db.query(
        `UPDATE product_variations
         SET status = 'approved', updated_at = CURRENT_TIMESTAMP
         WHERE product_id IN (${productIdsPlaceholders}) AND status = 'pending'
         RETURNING id`,
        approvedProductIds
      )
      variationsApproved = variationsResult.rows.length
      console.log(`Approved ${variationsApproved} variations for ${result.rows.length} products`)
    }

    return NextResponse.json({
      message: `Updated ${result.rows.length} products${variationsApproved > 0 ? ` and ${variationsApproved} variations` : ''}`,
      count: result.rows.length,
      variationsApproved: variationsApproved,
    })
  } catch (error) {
    console.error('Error updating products:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}
