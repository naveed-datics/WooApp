import { NextResponse } from 'next/server'
import { requireAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'

export async function PUT(request, { params }) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const body = await request.json()
    const { status, store_id: storeId } = body

    if (!storeId) {
      return NextResponse.json(
        { error: 'store_id is required' },
        { status: 400 }
      )
    }

    if (!['pending', 'approved', 'rejected', 'synced'].includes(status)) {
      return NextResponse.json(
        { error: 'Invalid status' },
        { status: 400 }
      )
    }

    const result = await db.query(
      `UPDATE product_stores
       SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE product_id = $3 AND store_id = $4
       RETURNING *`,
      [status, session.user.id, id, storeId]
    )

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Product not found for this store' },
        { status: 404 }
      )
    }

    // If product is being approved, also approve all associated variations
    // (variation status/woo_variation_id stay global, not per-store - see
    // scripts/migrate-product-store-links.js for why).
    if (status === 'approved') {
      const variationsResult = await db.query(
        `UPDATE product_variations
         SET status = 'approved', updated_at = CURRENT_TIMESTAMP
         WHERE product_id = $1 AND status = 'pending'
         RETURNING id`,
        [id]
      )

      console.log(`Approved ${variationsResult.rows.length} variations for product ${id}`)
    }

    return NextResponse.json({
      ...result.rows[0],
      variationsApproved: status === 'approved' ? (await db.query(
        `SELECT COUNT(*) as count FROM product_variations WHERE product_id = $1 AND status = 'approved'`,
        [id]
      )).rows[0].count : 0
    })
  } catch (error) {
    console.error('Error updating product status:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}
