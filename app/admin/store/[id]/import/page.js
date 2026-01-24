import { requireAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'
import { redirect } from 'next/navigation'
import CSVUploader from '../../../../components/csv-uploader'

export default async function ImportPage({ params }) {
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
    'SELECT id, name FROM stores WHERE id = $1',
    [storeId]
  )

  if (storeResult.rows.length === 0) {
    redirect('/dashboard')
  }

  const store = storeResult.rows[0]

  // Get all active vendors (not just those linked to this store)
  const vendorsResult = await db.query(
    `SELECT v.id, v.name 
     FROM vendors v
     WHERE v.status = 'active'
     ORDER BY v.name`
  )

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Import CSV</h1>
        <p className="text-gray-600 mt-1">Store: {store.name}</p>
      </div>
      <CSVUploader storeId={storeId} vendors={vendorsResult.rows} />
    </div>
  )
}


