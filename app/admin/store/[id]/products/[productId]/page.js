import { requireAdmin } from '../../../../../lib/auth'
import db from '../../../../../lib/db'
import { redirect } from 'next/navigation'
import ProductDetail from '../../../../../components/product-detail'

export default async function ProductDetailPage({ params }) {
  const session = await requireAdmin()
  const { id, productId: productIdParam } = await params
  const storeId = parseInt(id)
  const productId = parseInt(productIdParam)

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

  // Get product
  const productResult = await db.query(
    `SELECT id, sku, name, description, short_description, price, regular_price, 
            sale_price, stock_quantity, manage_stock, stock_status, categories, 
            tags, images, attributes, status, created_at, reviewed_at
     FROM products 
     WHERE id = $1 AND store_id = $2`,
    [productId, storeId]
  )

  if (productResult.rows.length === 0) {
    redirect(`/admin/store/${storeId}/products`)
  }

  const product = productResult.rows[0]

  // Get variations
  const variationsResult = await db.query(
    `SELECT id, sku, attributes, price, regular_price, sale_price, 
            stock_quantity, stock_status, status
     FROM product_variations
     WHERE product_id = $1
     ORDER BY created_at DESC`,
    [productId]
  )

  return (
    <div>
      <div className="mb-6">
        <a
          href={`/admin/store/${storeId}/products`}
          className="text-indigo-600 hover:text-indigo-800 mb-2 inline-block"
        >
          ← Back to Products
        </a>
        <h1 className="text-3xl font-bold text-gray-900 mt-2">{product.name}</h1>
      </div>
      <ProductDetail 
        storeId={storeId}
        product={product}
        variations={variationsResult.rows}
      />
    </div>
  )
}


