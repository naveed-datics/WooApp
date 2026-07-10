'use client'

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function ProductReview({ storeId, connectionMethod, products, status, currentPage, totalPages, total, limit = 50, search = '', approvedProductsCount = 0, canApprove = true, canSync = true }) {
  const isPluginStore = connectionMethod === 'plugin'
  const router = useRouter()
  const [loading, setLoading] = useState(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [pageInput, setPageInput] = useState(currentPage.toString())
  const [searchInput, setSearchInput] = useState(search)
  const [expandedProducts, setExpandedProducts] = useState(new Set())
  const [variantsData, setVariantsData] = useState({})

  const handlePageChange = (newPage) => {
    if (newPage >= 1 && newPage <= totalPages) {
      const searchParam = search ? `&search=${encodeURIComponent(search)}` : ''
      router.push(`/admin/store/${storeId}/products?status=${status}&page=${newPage}&limit=${limit}${searchParam}`)
    }
  }

  const handleLimitChange = (newLimit) => {
    const searchParam = search ? `&search=${encodeURIComponent(search)}` : ''
    router.push(`/admin/store/${storeId}/products?status=${status}&page=1&limit=${newLimit}${searchParam}`)
  }

  const handleSearchSubmit = (e) => {
    e.preventDefault()
    const searchParam = searchInput.trim() ? `&search=${encodeURIComponent(searchInput.trim())}` : ''
    router.push(`/admin/store/${storeId}/products?status=${status}&page=1&limit=${limit}${searchParam}`)
  }

  const handleSearchClear = () => {
    setSearchInput('')
    router.push(`/admin/store/${storeId}/products?status=${status}&page=1&limit=${limit}`)
  }

  const handlePageInputSubmit = (e) => {
    e.preventDefault()
    const pageNum = parseInt(pageInput)
    if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= totalPages) {
      handlePageChange(pageNum)
    } else {
      setPageInput(currentPage.toString())
    }
  }

  // Calculate visible page range
  const getVisiblePages = () => {
    const delta = 2 // Show 2 pages on each side of current
    const range = []
    const rangeWithDots = []

    for (let i = Math.max(2, currentPage - delta); 
         i <= Math.min(totalPages - 1, currentPage + delta); 
         i++) {
      range.push(i)
    }

    if (currentPage - delta > 2) {
      rangeWithDots.push(1, '...')
    } else {
      rangeWithDots.push(1)
    }

    rangeWithDots.push(...range)

    if (currentPage + delta < totalPages - 1) {
      rangeWithDots.push('...', totalPages)
    } else if (totalPages > 1) {
      rangeWithDots.push(totalPages)
    }

    return rangeWithDots
  }

  const startItem = total === 0 ? 0 : (currentPage - 1) * limit + 1
  const endItem = Math.min(currentPage * limit, total)

  const getStatusBadge = (productStatus) => {
    const colors = {
      pending: 'bg-yellow-100 text-yellow-800',
      approved: 'bg-green-100 text-green-800',
      rejected: 'bg-red-100 text-red-800',
      synced: 'bg-blue-100 text-blue-800',
    }
    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[productStatus] || colors.pending}`}>
        {productStatus}
      </span>
    )
  }

  const handleStatusChange = async (productId, newStatus) => {
    setLoading(productId)
    setError('')

    try {
      const response = await fetch(`/api/products/${productId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, store_id: storeId }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to update product status')
      }

      router.refresh()
    } catch (err) {
      setError(err.message)
      setLoading(null)
    }
  }

  const handleBulkAction = async (action) => {
    const selectedProducts = products.filter((p) => p.status === 'pending')
    
    if (selectedProducts.length === 0) {
      alert('No pending products to update')
      return
    }

    if (!confirm(`Are you sure you want to ${action} ${selectedProducts.length} products?`)) {
      return
    }

    setLoading('bulk')
    setError('')
    setSuccess('')

    try {
      const response = await fetch('/api/products/bulk-status', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productIds: selectedProducts.map((p) => p.id),
          status: action === 'approve' ? 'approved' : 'rejected',
          store_id: storeId,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to update products')
      }

      router.refresh()
    } catch (err) {
      setError(err.message)
      setLoading(null)
    }
  }

  const handleSyncAll = async () => {
    if (approvedProductsCount === 0) {
      alert('No approved products to sync')
      return
    }

    if (!confirm(`Are you sure you want to sync ${approvedProductsCount} approved products to WooCommerce? This may take a while.`)) {
      return
    }

    setLoading('sync-all')
    setError('')
    setSuccess('')

    try {
      const response = await fetch('/api/sync/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_id: storeId,
          sync_type: 'products',
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to sync products')
      }

      setSuccess(`Sync completed! ${data.succeeded} succeeded, ${data.failed} failed.`)
      setLoading(null)
      
      // Refresh page after a delay to show updated statuses
      setTimeout(() => {
        router.refresh()
      }, 2000)
    } catch (err) {
      setError(err.message)
      setLoading(null)
    }
  }

  const handleTriggerImport = async () => {
    if (approvedProductsCount === 0) {
      alert('No approved products to pull in')
      return
    }

    setLoading('sync-all')
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
      setSuccess(`Import triggered! ${progress.created ?? 0} created, ${progress.updated ?? 0} updated, ${data.syncedCount ?? 0} marked synced.`)
      setLoading(null)

      setTimeout(() => {
        router.refresh()
      }, 2000)
    } catch (err) {
      setError(err.message)
      setLoading(null)
    }
  }

  const handleSyncProduct = async (productId) => {
    setLoading(productId)
    setError('')
    setSuccess('')

    try {
      const response = await fetch(`/api/sync/product/${productId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_id: storeId,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to sync product')
      }

      setSuccess('Product synced successfully!')
      setLoading(null)
      
      // Refresh page after a delay to show updated status
      setTimeout(() => {
        router.refresh()
      }, 1000)
    } catch (err) {
      setError(err.message)
      setLoading(null)
    }
  }

  const toggleVariants = async (productId) => {
    const newExpanded = new Set(expandedProducts)
    
    if (newExpanded.has(productId)) {
      // Collapse
      newExpanded.delete(productId)
    } else {
      // Expand - fetch variants if not already loaded
      newExpanded.add(productId)
      if (!variantsData[productId]) {
        try {
          const response = await fetch(`/api/products/${productId}/variations?store_id=${storeId}`)
          if (response.ok) {
            const data = await response.json()
            setVariantsData(prev => ({
              ...prev,
              [productId]: data.variations || []
            }))
          }
        } catch (err) {
          console.error('Error fetching variants:', err)
        }
      }
    }
    
    setExpandedProducts(newExpanded)
  }

  return (
    <div>
      <div className="mb-4 flex justify-between items-center">
        <div className="flex space-x-2">
          <Link
            href={`/admin/store/${storeId}/products?status=all&limit=${limit}${search ? `&search=${encodeURIComponent(search)}` : ''}`}
            className={`px-4 py-2 rounded-md text-sm font-medium ${
              status === 'all'
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            All ({total})
          </Link>
          <Link
            href={`/admin/store/${storeId}/products?status=pending&limit=${limit}${search ? `&search=${encodeURIComponent(search)}` : ''}`}
            className={`px-4 py-2 rounded-md text-sm font-medium ${
              status === 'pending'
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Pending
          </Link>
          <Link
            href={`/admin/store/${storeId}/products?status=approved&limit=${limit}${search ? `&search=${encodeURIComponent(search)}` : ''}`}
            className={`px-4 py-2 rounded-md text-sm font-medium ${
              status === 'approved'
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Approved
          </Link>
          <Link
            href={`/admin/store/${storeId}/products?status=synced&limit=${limit}${search ? `&search=${encodeURIComponent(search)}` : ''}`}
            className={`px-4 py-2 rounded-md text-sm font-medium ${
              status === 'synced'
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Synced
          </Link>
        </div>
        {status === 'pending' && canApprove && (
          <div className="flex space-x-2">
            <button
              onClick={() => handleBulkAction('approve')}
              disabled={loading === 'bulk'}
              className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
            >
              {loading === 'bulk' ? 'Processing...' : 'Approve All Pending'}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-400 text-green-700 px-4 py-3 rounded mb-4">
          {success}
        </div>
      )}

      {/* Search Input - Above Table */}
      <div className="mb-4 flex justify-between items-center gap-4">
        <form onSubmit={handleSearchSubmit} className="flex-1 max-w-md">
          <div className="relative">
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by name or SKU..."
              className="w-full px-4 py-2 pl-10 pr-10 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            {searchInput && (
              <button
                type="button"
                onClick={handleSearchClear}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </form>
        
        {/* Sync All Button */}
        {approvedProductsCount > 0 && canSync && (
          isPluginStore ? (
            <button
              onClick={handleTriggerImport}
              disabled={loading === 'sync-all'}
              className="px-6 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
            >
              {loading === 'sync-all' ? 'Triggering...' : `Trigger Import Now (${approvedProductsCount} approved)`}
            </button>
          ) : (
            <button
              onClick={handleSyncAll}
              disabled={loading === 'sync-all'}
              className="px-6 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
            >
              {loading === 'sync-all' ? 'Syncing...' : `Sync All (${approvedProductsCount} approved products)`}
            </button>
          )
        )}
      </div>

      {search && (
        <div className="mb-4 text-sm text-gray-600">
          Showing results for: <span className="font-medium">"{search}"</span>
        </div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                SKU
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Vendor
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Variants
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {products.length === 0 ? (
              <tr>
                <td colSpan="6" className="px-6 py-4 text-center text-gray-500">
                  No products found.
                </td>
              </tr>
            ) : (
              products.map((product) => {
                const isExpanded = expandedProducts.has(product.id)
                const variants = variantsData[product.id] || []
                const variantCount = parseInt(product.variant_count) || 0
                
                return (
                  <React.Fragment key={product.id}>
                    <tr className={isExpanded ? 'bg-gray-50' : ''}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {product.sku || '-'}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        <Link
                          href={`/admin/store/${storeId}/products/${product.id}`}
                          className="text-indigo-600 hover:text-indigo-800"
                        >
                          {product.name}
                        </Link>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {product.vendor_name || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {variantCount > 0 ? (
                          <button
                            onClick={() => toggleVariants(product.id)}
                            className="flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-medium"
                          >
                            <span>{variantCount}</span>
                            <svg
                              className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>
                        ) : (
                          <span className="text-gray-400">0</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {getStatusBadge(product.status)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                        <div className="flex items-center gap-2">
                          {product.status === 'pending' && canApprove && (
                            <>
                              <button
                                onClick={() => handleStatusChange(product.id, 'approved')}
                                disabled={loading === product.id}
                                className="text-green-600 hover:text-green-900 disabled:opacity-50"
                              >
                                {loading === product.id ? 'Processing...' : 'Approve'}
                              </button>
                              <button
                                onClick={() => handleStatusChange(product.id, 'rejected')}
                                disabled={loading === product.id}
                                className="text-red-600 hover:text-red-900 disabled:opacity-50"
                              >
                                {loading === product.id ? 'Processing...' : 'Reject'}
                              </button>
                            </>
                          )}
                          {product.status === 'approved' && canSync && (
                            isPluginStore ? (
                              <span className="text-gray-500 text-xs italic">Pulled by plugin</span>
                            ) : (
                              <button
                                onClick={() => handleSyncProduct(product.id)}
                                disabled={loading === product.id}
                                className="text-indigo-600 hover:text-indigo-900 disabled:opacity-50 font-medium"
                              >
                                {loading === product.id ? 'Syncing...' : 'Sync with Store'}
                              </button>
                            )
                          )}
                          {product.status === 'synced' && (
                            <span className="text-gray-500 text-xs">
                              Synced {product.woo_product_id ? `(ID: ${product.woo_product_id})` : ''}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isExpanded && variantCount > 0 && (
                      <tr key={`${product.id}-variants`}>
                        <td colSpan="5" className="px-6 py-4 bg-gray-50">
                          <div className="ml-8">
                            <h4 className="text-sm font-semibold text-gray-700 mb-3">Variants ({variants.length})</h4>
                            {variants.length === 0 ? (
                              <p className="text-sm text-gray-500">Loading variants...</p>
                            ) : (
                              <div className="overflow-x-auto">
                                <table className="min-w-full divide-y divide-gray-200 border border-gray-200 rounded-lg">
                                  <thead className="bg-gray-100">
                                    <tr>
                                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">SKU</th>
                                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">Size</th>
                                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">Color</th>
                                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">Price</th>
                                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">Stock</th>
                                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">Status</th>
                                    </tr>
                                  </thead>
                                  <tbody className="bg-white divide-y divide-gray-200">
                                    {variants.map((variant) => (
                                      <tr key={variant.id}>
                                        <td className="px-4 py-2 text-sm text-gray-900">{variant.sku || '-'}</td>
                                        <td className="px-4 py-2 text-sm text-gray-500">{variant.size || '-'}</td>
                                        <td className="px-4 py-2 text-sm text-gray-500">{variant.color || '-'}</td>
                                        <td className="px-4 py-2 text-sm text-gray-500">
                                          ${variant.price || variant.regular_price || '0.00'}
                                        </td>
                                        <td className="px-4 py-2 text-sm text-gray-500">
                                          {variant.stock_status || '-'}
                                        </td>
                                        <td className="px-4 py-2 text-sm">
                                          {getStatusBadge(variant.status)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Info and Controls */}
      <div className="mt-6 flex flex-col sm:flex-row justify-between items-center gap-4">
        <div className="flex items-center gap-4">
          <div className="text-sm text-gray-700">
            Showing <span className="font-medium">{startItem}</span> to <span className="font-medium">{endItem}</span> of{' '}
            <span className="font-medium">{total}</span> products
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="limit-select" className="text-sm text-gray-700">
              Per page:
            </label>
            <select
              id="limit-select"
              value={limit}
              onChange={(e) => handleLimitChange(parseInt(e.target.value))}
              className="px-3 py-1 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </div>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            {/* First Page */}
            <button
              onClick={() => handlePageChange(1)}
              disabled={currentPage === 1}
              className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              First
            </button>

            {/* Previous Page */}
            <button
              onClick={() => handlePageChange(currentPage - 1)}
              disabled={currentPage === 1}
              className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>

            {/* Page Numbers */}
            <div className="flex items-center gap-1">
              {getVisiblePages().map((page, index) => {
                if (page === '...') {
                  return (
                    <span key={`ellipsis-${index}`} className="px-2 py-1 text-gray-500">
                      ...
                    </span>
                  )
                }
                return (
                  <button
                    key={page}
                    onClick={() => handlePageChange(page)}
                    className={`px-3 py-1 text-sm font-medium rounded-md ${
                      page === currentPage
                        ? 'bg-indigo-600 text-white'
                        : 'text-gray-700 bg-white border border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {page}
                  </button>
                )
              })}
            </div>

            {/* Next Page */}
            <button
              onClick={() => handlePageChange(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>

            {/* Last Page */}
            <button
              onClick={() => handlePageChange(totalPages)}
              disabled={currentPage === totalPages}
              className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Last
            </button>

            {/* Page Input */}
            <form onSubmit={handlePageInputSubmit} className="flex items-center gap-2 ml-2">
              <span className="text-sm text-gray-700">Go to:</span>
              <input
                type="number"
                min="1"
                max={totalPages}
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value)}
                className="w-16 px-2 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                type="submit"
                className="px-3 py-1 text-sm font-medium text-indigo-600 bg-white border border-indigo-300 rounded-md hover:bg-indigo-50"
              >
                Go
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}




