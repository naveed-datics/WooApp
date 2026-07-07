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
  const search = resolvedSearchParams?.search || ''
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
    'SELECT id, name, connection_method FROM stores WHERE id = $1',
    [storeId]
  )

  if (storeResult.rows.length === 0) {
    redirect('/dashboard')
  }

  const store = storeResult.rows[0]

  // Get products based on status and search
  // Build WHERE clause and parameters dynamically
  let whereParts = []
  let queryParams = [storeId]
  let paramIndex = 2

  if (status !== 'all') {
    whereParts.push(`ps.status = $${paramIndex}`)
    queryParams.push(status)
    paramIndex++
  }

  if (search && search.trim()) {
    whereParts.push(`(LOWER(p.name) LIKE LOWER($${paramIndex}) OR LOWER(p.sku) LIKE LOWER($${paramIndex}))`)
    queryParams.push(`%${search.trim()}%`)
    paramIndex++
  }

  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''

  // Add limit and offset
  queryParams.push(limit)
  const limitIndex = paramIndex
  paramIndex++

  queryParams.push(offset)
  const offsetIndex = paramIndex

  const productsResult = await db.query(
    `SELECT p.id, p.sku, p.name, p.price, p.regular_price, p.sale_price, p.stock_quantity,
            ps.status, p.created_at, ps.reviewed_at, ps.woo_product_id,
            COALESCE(v.variant_count, 0) as variant_count
     FROM products p
     INNER JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $1
     LEFT JOIN (
       SELECT product_id, COUNT(*) as variant_count
       FROM product_variations
       GROUP BY product_id
     ) v ON v.product_id = p.id
     ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    queryParams
  )

  // Get approved products count for sync button
  const approvedCountResult = await db.query(
    "SELECT COUNT(*) as count FROM product_stores WHERE store_id = $1 AND status = 'approved'",
    [storeId]
  )
  const approvedProductsCount = parseInt(approvedCountResult.rows[0].count)

  // Count query with same filters (reuse whereClause and build params)
  const countParams = [storeId]

  if (status !== 'all') {
    countParams.push(status)
  }

  if (search && search.trim()) {
    countParams.push(`%${search.trim()}%`)
  }

  const countResult = await db.query(
    `SELECT COUNT(*) as total
     FROM products p
     INNER JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $1
     ${whereClause}`,
    countParams
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
        connectionMethod={store.connection_method}
        products={productsResult.rows}
        status={status}
        currentPage={page}
        totalPages={totalPages}
        total={total}
        limit={limit}
        search={search}
        approvedProductsCount={approvedProductsCount}
      />
    </div>
  )
}
