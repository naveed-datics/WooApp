import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'

export async function GET(request, { params }) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const productId = parseInt(id)

    // Get product to verify it exists and user has access
    const productResult = await db.query(
      `SELECT id, store_id FROM products WHERE id = $1`,
      [productId]
    )

    if (productResult.rows.length === 0) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    const product = productResult.rows[0]

    // Check if admin has access to this store
    if (session.user.role !== 'super_admin') {
      const accessCheck = await db.query(
        'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
        [session.user.id, product.store_id]
      )

      if (accessCheck.rows.length === 0) {
        return NextResponse.json(
          { error: 'Unauthorized access to this store' },
          { status: 403 }
        )
      }
    }

    // Get variations
    const variationsResult = await db.query(
      `SELECT id, sku, attributes, size, color, price, regular_price, sale_price, 
              stock_quantity, stock_status, tax_class, image, images, status
       FROM product_variations
       WHERE product_id = $1
       ORDER BY created_at DESC`,
      [productId]
    )

    return NextResponse.json({
      success: true,
      variations: variationsResult.rows,
    })
  } catch (error) {
    console.error('Error fetching variations:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch variations' },
      { status: 500 }
    )
  }
}
