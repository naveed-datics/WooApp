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
    'SELECT id, name FROM stores WHERE id = $1',
    [storeId]
  )

  if (storeResult.rows.length === 0) {
    redirect('/dashboard')
  }

  const store = storeResult.rows[0]

  // Get products based on status and search
  // Build WHERE clause and parameters dynamically
  let whereParts = ['store_id = $1']
  let queryParams = [storeId]
  let paramIndex = 2
  
  if (status !== 'all') {
    whereParts.push(`status = $${paramIndex}`)
    queryParams.push(status)
    paramIndex++
  }
  
  if (search && search.trim()) {
    whereParts.push(`(LOWER(name) LIKE LOWER($${paramIndex}) OR LOWER(sku) LIKE LOWER($${paramIndex}))`)
    queryParams.push(`%${search.trim()}%`)
    paramIndex++
  }
  
  const whereClause = `WHERE ${whereParts.join(' AND ')}`
  
  // Add limit and offset
  queryParams.push(limit)
  const limitIndex = paramIndex
  paramIndex++
  
  queryParams.push(offset)
  const offsetIndex = paramIndex

  const productsResult = await db.query(
    `SELECT p.id, p.sku, p.name, p.price, p.regular_price, p.sale_price, p.stock_quantity, 
            p.status, p.created_at, p.reviewed_at, p.woo_product_id,
            COALESCE(v.variant_count, 0) as variant_count
     FROM products p
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
    "SELECT COUNT(*) as count FROM products WHERE store_id = $1 AND status = 'approved'",
    [storeId]
  )
  const approvedProductsCount = parseInt(approvedCountResult.rows[0].count)

  // Count query with same filters (reuse whereClause and build params)
  const countParams = [storeId]
  let countParamIndex = 2
  
  if (status !== 'all') {
    countParams.push(status)
    countParamIndex++
  }
  
  if (search && search.trim()) {
    countParams.push(`%${search.trim()}%`)
  }
  
  const countResult = await db.query(
    `SELECT COUNT(*) as total FROM products ${whereClause}`,
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


