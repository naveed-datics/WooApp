import { requireAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'
import { redirect } from 'next/navigation'
import ProductReview from '../../../../components/product-review'

export default async function ProductsPage({ params, searchParams }) {
  const session = await requireAdmin()
  const { id } = await params
  const resolvedSearchParams = await searchParams
  const storeId = parseInt(id)
  const status = resolvedSearchParams?.status || 'pending'
  const page = parseInt(resolvedSearchParams?.page || '1')
  const limit = parseInt(resolvedSearchParams?.limit || '50')
  const offset = (page - 1) * limit

  // Check if admin has access to this store
  if (session.user.role !== 'super_admin') {
    const accessCheck = await db.query(
      'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
      [session.user.id, storeId]
    )

    if (accessCheck.rows.length === 0) {
      redirect('/unauthorized')
    }
  }

  // Get store info
  const storeResult = await db.query(
    'SELECT id, name FROM stores WHERE id = $1',
    [storeId]
  )

  if (storeResult.rows.length === 0) {
    redirect('/dashboard')
  }

  const store = storeResult.rows[0]

  // Get products based on status
  const whereClause = status === 'all' 
    ? 'WHERE store_id = $1' 
    : 'WHERE store_id = $1 AND status = $2'

  const queryParams = status === 'all' ? [storeId, limit, offset] : [storeId, status, limit, offset]

  const productsResult = await db.query(
    `SELECT id, sku, name, price, regular_price, sale_price, stock_quantity, 
            status, created_at, reviewed_at, woo_product_id
     FROM products 
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${status === 'all' ? '2' : '3'} OFFSET $${status === 'all' ? '3' : '4'}`,
    queryParams
  )

  // Get approved products count for sync button
  const approvedCountResult = await db.query(
    "SELECT COUNT(*) as count FROM products WHERE store_id = $1 AND status = 'approved'",
    [storeId]
  )
  const approvedProductsCount = parseInt(approvedCountResult.rows[0].count)

  const countResult = await db.query(
    `SELECT COUNT(*) as total FROM products ${whereClause}`,
    status === 'all' ? [storeId] : [storeId, status]
  )

  const total = parseInt(countResult.rows[0].total)
  const totalPages = Math.ceil(total / limit)

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Review Products</h1>
        <p className="text-gray-600 mt-1">Store: {store.name}</p>
      </div>
      <ProductReview 
        storeId={storeId}
        products={productsResult.rows}
        status={status}
        currentPage={page}
        totalPages={totalPages}
        total={total}
        limit={limit}
        approvedProductsCount={approvedProductsCount}
      />
    </div>
  )
}


