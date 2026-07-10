import { requireAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'
import { redirect } from 'next/navigation'
import ProductReview from '../../../../components/product-review'
import { VENDOR_STORE_JOIN } from '../../../../lib/vendor-store-filter'

export default async function ProductsPage({ params, searchParams }) {
  const session = await requireAdmin()
  const { id } = await params
  const resolvedSearchParams = await searchParams
  const storeId = parseInt(id)
  const isStoreAdmin = session.user.role === 'admin'
  const status = resolvedSearchParams?.status || (isStoreAdmin ? 'approved' : 'pending')
  const page = parseInt(resolvedSearchParams?.page || '1')
  const limit = parseInt(resolvedSearchParams?.limit || '50')
  const search = resolvedSearchParams?.search || ''
  const offset = (page - 1) * limit

  if (isStoreAdmin) {
    const accessCheck = await db.query(
      'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
      [session.user.id, storeId]
    )

    if (accessCheck.rows.length === 0) {
      redirect('/unauthorized')
    }
  }

  const storeResult = await db.query(
    'SELECT id, name, connection_method FROM stores WHERE id = $1',
    [storeId]
  )

  if (storeResult.rows.length === 0) {
    redirect('/dashboard')
  }

  const store = storeResult.rows[0]
  const vendorJoin = isStoreAdmin ? VENDOR_STORE_JOIN : ''

  function buildFilterParts(startIndex) {
    const parts = []
    const params = []
    let paramIndex = startIndex

    if (isStoreAdmin) {
      parts.push('vs.id IS NOT NULL')
    }

    if (status !== 'all') {
      parts.push(`p.status = $${paramIndex}`)
      params.push(status)
      paramIndex++
    }

    if (search && search.trim()) {
      parts.push(
        `(LOWER(p.name) LIKE LOWER($${paramIndex}) OR LOWER(p.sku) LIKE LOWER($${paramIndex}))`
      )
      params.push(`%${search.trim()}%`)
      paramIndex++
    }

    return { parts, params, nextIndex: paramIndex }
  }

  const listFilters = buildFilterParts(2)
  const whereClause =
    listFilters.parts.length > 0 ? `WHERE ${listFilters.parts.join(' AND ')}` : ''

  const queryParams = [storeId, ...listFilters.params, limit, offset]
  const limitIndex = listFilters.nextIndex
  const offsetIndex = listFilters.nextIndex + 1

  const productsResult = await db.query(
    `SELECT p.id, p.sku, p.name, p.price, p.regular_price, p.sale_price, p.stock_quantity,
            p.status, p.created_at, p.reviewed_at, ps.woo_product_id,
            COALESCE(v.variant_count, 0) as variant_count,
            ven.name AS vendor_name
     FROM products p
     LEFT JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $1
     LEFT JOIN vendors ven ON ven.id = p.vendor_id
     ${vendorJoin}
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

  const approvedCountSql = isStoreAdmin
    ? `SELECT COUNT(*) as count
       FROM products p
       ${VENDOR_STORE_JOIN}
       WHERE p.status = 'approved'`
    : "SELECT COUNT(*) as count FROM products WHERE status = 'approved'"

  const approvedCountResult = await db.query(
    approvedCountSql,
    isStoreAdmin ? [storeId] : []
  )
  const approvedProductsCount = parseInt(approvedCountResult.rows[0].count)

  const countStartIndex = isStoreAdmin ? 2 : 1
  const countFilters = buildFilterParts(countStartIndex)
  const countWhereClause =
    countFilters.parts.length > 0 ? `WHERE ${countFilters.parts.join(' AND ')}` : ''
  const countParams = isStoreAdmin
    ? [storeId, ...countFilters.params]
    : countFilters.params

  const countResult = await db.query(
    `SELECT COUNT(*) as total
     FROM products p
     ${vendorJoin}
     ${countWhereClause}`,
    countParams
  )

  const total = parseInt(countResult.rows[0].total)
  const totalPages = Math.ceil(total / limit)

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">
          {isStoreAdmin ? 'Products' : 'Review Products'}
        </h1>
        <p className="text-gray-600 mt-1">Store: {store.name}</p>
        {isStoreAdmin && (
          <p className="text-sm text-gray-500 mt-1">
            Showing products from vendors assigned to this store.
          </p>
        )}
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
        userRole={session.user.role}
        canApprove={!isStoreAdmin}
        canSync={isStoreAdmin}
      />
    </div>
  )
}
