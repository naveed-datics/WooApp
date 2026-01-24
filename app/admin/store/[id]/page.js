import { requireAdmin } from '../../../lib/auth'
import db from '../../../lib/db'
import { redirect } from 'next/navigation'

export default async function StoreDashboardPage({ params }) {
  const session = await requireAdmin()
  const { id } = await params
  const storeId = parseInt(id)

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
    'SELECT id, name, store_url, status FROM stores WHERE id = $1',
    [storeId]
  )

  if (storeResult.rows.length === 0) {
    return (
      <div className="text-center py-12">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Store not found</h1>
        <a href="/dashboard" className="text-indigo-600 hover:text-indigo-800">
          Back to Dashboard
        </a>
      </div>
    )
  }

  const store = storeResult.rows[0]

  // Get stats
  const [productsResult, ordersResult, csvUploadsResult] = await Promise.all([
    db.query(
      'SELECT COUNT(*) as count FROM products WHERE store_id = $1',
      [storeId]
    ),
    db.query(
      'SELECT COUNT(*) as count FROM orders WHERE store_id = $1',
      [storeId]
    ),
    db.query(
      'SELECT COUNT(*) as count FROM csv_uploads WHERE store_id = $1',
      [storeId]
    ),
  ])

  const stats = {
    products: parseInt(productsResult.rows[0].count),
    orders: parseInt(ordersResult.rows[0].count),
    csvUploads: parseInt(csvUploadsResult.rows[0].count),
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">{store.name}</h1>
        <p className="text-gray-600 mt-1">{store.store_url}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-700 mb-2">Products</h3>
          <p className="text-3xl font-bold text-indigo-600">{stats.products}</p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-700 mb-2">Orders</h3>
          <p className="text-3xl font-bold text-green-600">{stats.orders}</p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-700 mb-2">CSV Uploads</h3>
          <p className="text-3xl font-bold text-blue-600">{stats.csvUploads}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <a
          href={`/admin/store/${storeId}/import`}
          className="bg-white p-6 rounded-lg shadow hover:shadow-lg transition-shadow"
        >
          <h3 className="text-lg font-medium text-gray-900 mb-2">Import CSV</h3>
          <p className="text-gray-600 text-sm">Upload product and variation CSV files</p>
        </a>
        <a
          href={`/admin/store/${storeId}/products`}
          className="bg-white p-6 rounded-lg shadow hover:shadow-lg transition-shadow"
        >
          <h3 className="text-lg font-medium text-gray-900 mb-2">Review Products</h3>
          <p className="text-gray-600 text-sm">Review and approve pending products</p>
        </a>
        <a
          href={`/admin/store/${storeId}/sync`}
          className="bg-white p-6 rounded-lg shadow hover:shadow-lg transition-shadow"
        >
          <h3 className="text-lg font-medium text-gray-900 mb-2">Sync</h3>
          <p className="text-gray-600 text-sm">Sync products with WooCommerce</p>
        </a>
        <a
          href={`/admin/store/${storeId}/orders`}
          className="bg-white p-6 rounded-lg shadow hover:shadow-lg transition-shadow"
        >
          <h3 className="text-lg font-medium text-gray-900 mb-2">Orders</h3>
          <p className="text-gray-600 text-sm">View and manage orders</p>
        </a>
      </div>
    </div>
  )
}


