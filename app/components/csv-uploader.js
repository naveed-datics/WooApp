'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Papa from 'papaparse'

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
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 })
  
  // Chunk size for sending data (100 rows per chunk to stay under size limits)
  const CHUNK_SIZE = 100

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
    setUploadProgress({ current: 0, total: 0 })
  }

  const parseCSVFile = (file) => {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => {
          // Normalize header names - convert to lowercase and remove spaces
          return header.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
        },
        complete: (results) => {
          resolve(results.data)
        },
        error: (error) => {
          reject(error)
        },
      })
    })
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
    setUploadProgress({ current: 0, total: 0 })

    try {
      // Step 1: Parse CSV file on client side
      setSuccess('Parsing CSV file...')
      const csvData = await parseCSVFile(file)
      
      if (csvData.length === 0) {
        throw new Error('CSV file is empty')
      }

      // Step 2: Initialize upload
      setSuccess(`Initializing upload for ${csvData.length} rows...`)
      const initResponse = await fetch('/api/csv/init-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeId,
          vendorId: formData.vendor_id,
          fileType: formData.file_type,
          fileName: file.name,
          totalRows: csvData.length,
        }),
      })

      if (!initResponse.ok) {
        const initData = await initResponse.json()
        throw new Error(initData.error || 'Failed to initialize upload')
      }

      const { csvUploadId } = await initResponse.json()

      // Step 3: Send data in chunks
      const totalChunks = Math.ceil(csvData.length / CHUNK_SIZE)
      setUploadProgress({ current: 0, total: totalChunks })
      
      let totalProcessed = 0
      let totalErrors = []

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, csvData.length)
        const chunk = csvData.slice(start, end)

        setSuccess(`Uploading chunk ${i + 1} of ${totalChunks} (rows ${start + 1}-${end})...`)
        setUploadProgress({ current: i + 1, total: totalChunks })

        const chunkResponse = await fetch('/api/csv/upload-chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            csvUploadId,
            storeId,
            vendorId: formData.vendor_id,
            fileType: formData.file_type,
            chunk,
            chunkIndex: i,
            totalChunks,
            fileName: file.name,
          }),
        })

        if (!chunkResponse.ok) {
          const chunkData = await chunkResponse.json()
          throw new Error(`Failed to upload chunk ${i + 1}: ${chunkData.error || 'Unknown error'}`)
        }

        const chunkResult = await chunkResponse.json()
        totalProcessed += chunkResult.processedCount
        if (chunkResult.errors && chunkResult.errors.length > 0) {
          totalErrors.push(...chunkResult.errors)
        }

        // Small delay between chunks to avoid overwhelming the server
        if (i < totalChunks - 1) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }

      // Step 4: Finalize upload
      const finalizeResponse = await fetch(`/api/csv/upload/${csvUploadId}/finalize`, {
        method: 'POST',
      })

      const errorCount = totalErrors.length
      const successMsg = `CSV uploaded successfully! ${totalProcessed} rows processed.`
      const errorMsg = errorCount > 0 ? ` ${errorCount} rows had errors.` : ''
      setSuccess(successMsg + errorMsg)
      
      if (errorCount > 0) {
        console.error('CSV Upload Errors:', totalErrors.slice(0, 50))
      }
      
      setFile(null)
      setUploadProgress({ current: 0, total: 0 })
      
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
      setUploadProgress({ current: 0, total: 0 })
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
          {uploadProgress.total > 0 && (
            <div className="mt-2">
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className="bg-green-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                ></div>
              </div>
            </div>
          )}
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
          <p className="text-xs text-gray-500 mb-2">
            Large files are supported. The file will be processed in chunks.
          </p>
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
                <p className="text-sm text-gray-600 mb-1">
                  <strong>{file.name}</strong>
                </p>
                <p className="text-xs text-gray-500 mb-2">
                  Size: {(file.size / 1024 / 1024).toFixed(2)}MB
                </p>
                {uploadProgress.total > 0 && (
                  <div className="mt-2">
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div 
                        className="bg-indigo-600 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                      ></div>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Chunk {uploadProgress.current} of {uploadProgress.total}
                    </p>
                  </div>
                )}
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




