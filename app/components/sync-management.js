'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDateTime } from '@/app/lib/format-date'

export default function SyncManagement({ storeId, store, approvedProductsCount, syncLogs }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const getStatusBadge = (status) => {
    const colors = {
      pending: 'bg-yellow-100 text-yellow-800',
      running: 'bg-blue-100 text-blue-800',
      completed: 'bg-green-100 text-green-800',
      failed: 'bg-red-100 text-red-800',
    }
    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status] || colors.pending}`}>
        {status}
      </span>
    )
  }

  const formatDate = (date) => {
    if (!date) return '-'
    return formatDateTime(date)
  }

  const handleSync = async (syncType) => {
    if (!confirm(`Are you sure you want to sync ${syncType}? This may take a while.`)) {
      return
    }

    setLoading(true)
    setError('')
    setSuccess('')

    try {
      const response = await fetch(`/api/sync/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_id: storeId,
          sync_type: syncType,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start sync')
      }

      setSuccess(`Sync started successfully! Sync ID: ${data.syncId}`)

      // Refresh page after a delay to show the new sync log
      setTimeout(() => {
        router.refresh()
      }, 2000)
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  const handleTriggerImport = async () => {
    setLoading(true)
    setError('')
    setSuccess('')

    try {
      const response = await fetch(`/api/stores/${storeId}/trigger-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_resync: false }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to trigger import')
      }

      const progress = data.progress || {}
      setSuccess(
        `Import triggered! ${progress.created ?? 0} created, ${progress.updated ?? 0} updated, ` +
        `${data.syncedCount ?? 0} marked synced` +
        (progress.status === 'running' ? ' (large catalog - remaining pages continue via the plugin\'s schedule).' : '.')
      )
      setLoading(false)

      setTimeout(() => {
        router.refresh()
      }, 2000)
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-400 text-green-700 px-4 py-3 rounded">
          {success}
        </div>
      )}

      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-bold text-gray-900 mb-4">Sync Products</h2>
        <div className="mb-4">
          <p className="text-gray-600 mb-2">
            <strong>{approvedProductsCount}</strong> approved products ready to sync
          </p>
          <p className="text-sm text-gray-500">
            Last sync: {store.last_sync_at ? formatDate(store.last_sync_at) : 'Never'}
          </p>
        </div>
        {store.connection_method === 'plugin' ? (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              This store uses the <strong>WooApp Connector</strong> WordPress plugin, which pulls
              approved products itself - WooApp doesn't push to it. Trigger a pull now, or leave it
              to wp-admin → WooApp Connector → Import Now (or its own schedule).
            </p>
            <button
              onClick={handleTriggerImport}
              disabled={loading || approvedProductsCount === 0}
              className="px-6 py-3 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Triggering...' : `Trigger Import Now (${approvedProductsCount} approved)`}
            </button>
            {approvedProductsCount === 0 && (
              <p className="text-sm text-gray-500">No approved products to pull in. Please approve products first.</p>
            )}
          </div>
        ) : (
          <>
            <button
              onClick={() => handleSync('products')}
              disabled={loading || approvedProductsCount === 0}
              className="px-6 py-3 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Starting Sync...' : `Sync ${approvedProductsCount} Products`}
            </button>
            {approvedProductsCount === 0 && (
              <p className="text-sm text-gray-500 mt-2">No approved products to sync. Please approve products first.</p>
            )}
          </>
        )}
      </div>

      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-bold text-gray-900 mb-4">Sync Logs</h2>
        {syncLogs.length === 0 ? (
          <p className="text-gray-500">No sync logs found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Processed</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Succeeded</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Failed</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Started</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Completed</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {syncLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {log.sync_type}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {getStatusBadge(log.status)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {log.items_processed}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-green-600">
                      {log.items_succeeded}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-red-600">
                      {log.items_failed}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatDate(log.started_at)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatDate(log.completed_at)}
                      {log.error_message && (
                        <div className="mt-1 text-xs text-red-600" title={log.error_message}>
                          Error: {log.error_message.substring(0, 50)}...
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}


