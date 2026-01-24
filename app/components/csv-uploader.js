'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function CSVUploader({ storeId, vendors }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [formData, setFormData] = useState({
    vendor_id: vendors.length > 0 ? vendors[0].id : '',
    file_type: 'products',
  })
  const [file, setFile] = useState(null)
  const [dragActive, setDragActive] = useState(false)

  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0])
    }
  }

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0])
    }
  }

  const handleFile = (selectedFile) => {
    if (!selectedFile.name.endsWith('.csv')) {
      setError('Please select a CSV file')
      return
    }
    setFile(selectedFile)
    setError('')
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSuccess('')

    if (!file) {
      setError('Please select a CSV file')
      return
    }

    if (!formData.vendor_id) {
      setError('Please select a vendor')
      return
    }

    setLoading(true)

    try {
      const uploadFormData = new FormData()
      uploadFormData.append('file', file)
      uploadFormData.append('store_id', storeId)
      uploadFormData.append('vendor_id', formData.vendor_id)
      uploadFormData.append('file_type', formData.file_type)

      const response = await fetch('/api/csv/upload', {
        method: 'POST',
        body: uploadFormData,
      })

      const data = await response.json()

      if (!response.ok) {
        const errorMsg = data.error || 'Failed to upload CSV'
        const details = data.details ? ` Details: ${JSON.stringify(data.details)}` : ''
        throw new Error(errorMsg + details)
      }

      const errorCount = data.errors?.length || 0
      const successMsg = `CSV uploaded successfully! ${data.rowCount} rows processed.`
      const errorMsg = errorCount > 0 ? ` ${errorCount} rows had errors.` : ''
      setSuccess(successMsg + errorMsg)
      
      if (errorCount > 0 && data.errors) {
        console.error('CSV Upload Errors:', data.errors)
      }
      
      setFile(null)
      
      // Reset file input
      const fileInput = document.getElementById('file-input')
      if (fileInput) {
        fileInput.value = ''
      }

      setTimeout(() => {
        router.push(`/admin/store/${storeId}/products`)
      }, 2000)
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  return (
    <div className="bg-white shadow rounded-lg p-6 max-w-2xl">
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
      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label htmlFor="vendor_id" className="block text-sm font-medium text-gray-700">
            Vendor *
          </label>
          <select
            id="vendor_id"
            name="vendor_id"
            required
            value={formData.vendor_id}
            onChange={(e) => setFormData({ ...formData, vendor_id: e.target.value })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          >
            <option value="">Select a vendor...</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="file_type" className="block text-sm font-medium text-gray-700">
            File Type *
          </label>
          <select
            id="file_type"
            name="file_type"
            required
            value={formData.file_type}
            onChange={(e) => setFormData({ ...formData, file_type: e.target.value })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          >
            <option value="products">Products</option>
            <option value="variations">Variations</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            CSV File *
          </label>
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center ${
              dragActive
                ? 'border-indigo-500 bg-indigo-50'
                : 'border-gray-300 hover:border-gray-400'
            }`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            {file ? (
              <div>
                <p className="text-sm text-gray-600 mb-2">{file.name}</p>
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  className="text-sm text-red-600 hover:text-red-800"
                >
                  Remove
                </button>
              </div>
            ) : (
              <div>
                <p className="text-gray-600 mb-2">
                  Drag and drop a CSV file here, or click to select
                </p>
                <label htmlFor="file-input" className="cursor-pointer">
                  <span className="text-indigo-600 hover:text-indigo-800">
                    Select File
                  </span>
                  <input
                    id="file-input"
                    type="file"
                    accept=".csv"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </label>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end space-x-4">
          <button
            type="button"
            onClick={() => router.back()}
            className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !file}
            className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? 'Uploading...' : 'Upload CSV'}
          </button>
        </div>
      </form>
    </div>
  )
}




