import { NextResponse } from 'next/server'
import { requireAdmin } from '../../../lib/auth'
import db from '../../../lib/db'
import { parseCSV, validateProductRow, validateVariationRow, parseProductRow, parseVariationRow } from '../../../lib/csv-parser'
import { auth } from '../../auth/[...nextauth]/route'

// Vercel serverless function configuration
export const maxDuration = 60 // Maximum execution time in seconds (60s for Pro, 10s for Hobby)
export const runtime = 'nodejs' // Use Node.js runtime

export async function POST(request) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const formData = await request.formData()
    const file = formData.get('file')
    const storeIdStr = formData.get('store_id')
    const vendorIdStr = formData.get('vendor_id')
    const fileType = formData.get('file_type')

    const storeId = parseInt(storeIdStr)
    const vendorId = parseInt(vendorIdStr)

    if (!file || !storeIdStr || !vendorIdStr || !fileType) {
      return NextResponse.json(
        { error: 'Missing required fields', details: { hasFile: !!file, storeId: storeIdStr, vendorId: vendorIdStr, fileType } },
        { status: 400 }
      )
    }

    if (isNaN(storeId) || isNaN(vendorId)) {
      return NextResponse.json(
        { error: 'Invalid store ID or vendor ID', details: { storeId, vendorId } },
        { status: 400 }
      )
    }

    // Validate file size (Vercel has 4.5MB limit for request body, but we'll use 3MB to be safe)
    const MAX_FILE_SIZE = 3 * 1024 * 1024 // 3MB
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { 
          error: `File size exceeds limit. Maximum size is ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB. Your file is ${(file.size / 1024 / 1024).toFixed(2)}MB. Please split your CSV file into smaller files.`,
          fileSize: file.size,
          maxSize: MAX_FILE_SIZE
        },
        { status: 413 } // Use 413 Payload Too Large status
      )
    }

    console.log(`Processing - CSV upload: file=${file.name}, size=${(file.size / 1024).toFixed(2)}KB, type=${fileType}`)

    // Check if admin has access to this store
    if (session.user.role !== 'super_admin') {
      const accessCheck = await db.query(
        'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
        [session.user.id, storeId]
      )

      if (accessCheck.rows.length === 0) {
        return NextResponse.json(
          { error: 'Unauthorized access to this store' },
          { status: 403 }
        )
      }
    }

    // Read file content
    let fileText
    try {
      const fileBuffer = await file.arrayBuffer()
      fileText = Buffer.from(fileBuffer).toString('utf-8')
    } catch (error) {
      console.error('Error reading file:', error)
      return NextResponse.json(
        { error: 'Failed to read file. Please ensure the file is a valid CSV file.' },
        { status: 400 }
      )
    }

    // Parse CSV
    let csvData
    try {
      csvData = await parseCSV(fileText)
    } catch (error) {
      console.error('Error parsing CSV:', error)
      return NextResponse.json(
        { error: 'Failed to parse CSV file. Please ensure the file is properly formatted.' },
        { status: 400 }
      )
    }

    if (csvData.length === 0) {
      return NextResponse.json(
        { error: 'CSV file is empty' },
        { status: 400 }
      )
    }

    // Log first row for debugging (shows what columns were detected)
    if (csvData.length > 0) {
      console.log('CSV First row columns:', Object.keys(csvData[0]))
      console.log('CSV First row sample:', csvData[0])
    }

    // Create CSV upload record
    const uploadResult = await db.query(
      `INSERT INTO csv_uploads (store_id, vendor_id, uploaded_by, file_type, file_name, row_count, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'processing')
       RETURNING id`,
      [storeId, vendorId, session.user.id, fileType, file.name, csvData.length]
    )

    const csvUploadId = uploadResult.rows[0].id

    let processedCount = 0
    let errorMessages = []

    try {
      if (fileType === 'products') {
        // Validate and process products (upsert by store_id, sku)
        // Process in batches to avoid timeout issues
        const BATCH_SIZE = 50
        console.log(`Processing ${csvData.length} product rows in batches of ${BATCH_SIZE}`)
        
        for (let batchStart = 0; batchStart < csvData.length; batchStart += BATCH_SIZE) {
          const batchEnd = Math.min(batchStart + BATCH_SIZE, csvData.length)
          console.log(`Processing batch: rows ${batchStart + 1} to ${batchEnd}`)
          
          for (let i = batchStart; i < batchEnd; i++) {
            try {
              const row = csvData[i]
              const errors = validateProductRow(row, i)
              
              if (errors.length > 0) {
                errorMessages.push(...errors)
                continue
              }

              const productData = parseProductRow(row)
              const existing = await db.query(
                'SELECT id FROM products WHERE store_id = $1 AND sku = $2 LIMIT 1',
                [storeId, productData.sku]
              )

              if (existing.rows.length > 0) {
                await db.query(
                  `UPDATE products SET
                    csv_upload_id = $1, name = $2, description = $3, short_description = $4,
                    price = $5, regular_price = $6, sale_price = $7, stock_quantity = $8,
                    manage_stock = $9, stock_status = $10, categories = $11, tags = $12,
                    images = $13, attributes = $14, updated_at = NOW()
                   WHERE id = $15`,
                  [
                    csvUploadId,
                    productData.name,
                    productData.description,
                    productData.short_description,
                    productData.price,
                    productData.regular_price,
                    productData.sale_price,
                    productData.stock_quantity,
                    productData.manage_stock,
                    productData.stock_status,
                    productData.categories,
                    productData.tags,
                    productData.images,
                    productData.attributes,
                    existing.rows[0].id,
                  ]
                )
              } else {
                await db.query(
                  `INSERT INTO products (
                    csv_upload_id, store_id, sku, name, description, short_description,
                    price, regular_price, sale_price, stock_quantity, manage_stock,
                    stock_status, categories, tags, images, attributes, status
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending')`,
                  [
                    csvUploadId,
                    storeId,
                    productData.sku,
                    productData.name,
                    productData.description,
                    productData.short_description,
                    productData.price,
                    productData.regular_price,
                    productData.sale_price,
                    productData.stock_quantity,
                    productData.manage_stock,
                    productData.stock_status,
                    productData.categories,
                    productData.tags,
                    productData.images,
                    productData.attributes,
                  ]
                )
              }
              processedCount++
            } catch (rowError) {
              console.error(`Error processing row ${i + 1}:`, rowError.message)
              errorMessages.push(`Row ${i + 1}: ${rowError.message}`)
            }
          }
        }
      } else if (fileType === 'variations') {
        // Validate and process variations (upsert by product_id, sku)
        // Process in batches to avoid timeout issues
        const BATCH_SIZE = 50
        console.log(`Processing ${csvData.length} variation rows in batches of ${BATCH_SIZE}`)
        
        for (let batchStart = 0; batchStart < csvData.length; batchStart += BATCH_SIZE) {
          const batchEnd = Math.min(batchStart + BATCH_SIZE, csvData.length)
          console.log(`Processing batch: rows ${batchStart + 1} to ${batchEnd}`)
          
          for (let i = batchStart; i < batchEnd; i++) {
            try {
              const row = csvData[i]
              const errors = validateVariationRow(row, i)
              
              if (errors.length > 0) {
                errorMessages.push(...errors)
                continue
              }

              const variationData = parseVariationRow(row)

              const productResult = await db.query(
                'SELECT id FROM products WHERE store_id = $1 AND sku = $2 LIMIT 1',
                [storeId, variationData.parent_sku]
              )

              if (productResult.rows.length === 0) {
                errorMessages.push(`Row ${i + 1}: Parent product with SKU "${variationData.parent_sku}" not found`)
                continue
              }

              const productId = productResult.rows[0].id
              const existingVar = await db.query(
                'SELECT id FROM product_variations WHERE product_id = $1 AND sku = $2 LIMIT 1',
                [productId, variationData.sku]
              )

              const imagesVal = variationData.images || variationData.image || null
              const imageVal = variationData.image || (variationData.images ? String(variationData.images).split(',')[0]?.trim() : null) || null

              if (existingVar.rows.length > 0) {
                await db.query(
                  `UPDATE product_variations SET
                    csv_upload_id = $1, parent_sku = $2, attributes = $3, size = $4, color = $5, price = $6,
                    regular_price = $7, sale_price = $8, stock_quantity = $9,
                    manage_stock = $10, stock_status = $11, image = $12, tax_class = $13,
                    images = $14, updated_at = NOW()
                   WHERE id = $15`,
                  [
                    csvUploadId,
                    variationData.parent_sku,
                    variationData.attributes,
                    variationData.size,
                    variationData.color,
                    variationData.price,
                    variationData.regular_price,
                    variationData.sale_price,
                    variationData.stock_quantity,
                    variationData.manage_stock,
                    variationData.stock_status,
                    imageVal,
                    variationData.tax_class,
                    imagesVal,
                    existingVar.rows[0].id,
                  ]
                )
              } else {
                await db.query(
                  `INSERT INTO product_variations (
                    product_id, csv_upload_id, parent_sku, sku, attributes, size, color,
                    price, regular_price, sale_price, stock_quantity, manage_stock,
                    stock_status, image, tax_class, images, status
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending')`,
                  [
                    productId,
                    csvUploadId,
                    variationData.parent_sku,
                    variationData.sku,
                    variationData.attributes,
                    variationData.size,
                    variationData.color,
                    variationData.price,
                    variationData.regular_price,
                    variationData.sale_price,
                    variationData.stock_quantity,
                    variationData.manage_stock,
                    variationData.stock_status,
                    imageVal,
                    variationData.tax_class,
                    imagesVal,
                  ]
                )
              }
              processedCount++
            } catch (rowError) {
              console.error(`Error processing row ${i + 1}:`, rowError.message)
              errorMessages.push(`Row ${i + 1}: ${rowError.message}`)
            }
          }
        }
      }

      // Update CSV upload status
      await db.query(
        `UPDATE csv_uploads 
         SET status = $1, row_count = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [
          errorMessages.length > 0 ? 'completed' : 'completed',
          processedCount,
          errorMessages.length > 0 ? errorMessages.slice(0, 50).join('\n') : null, // Limit error message length
          csvUploadId,
        ]
      )

      console.log(`CSV upload completed: ${processedCount} rows processed, ${errorMessages.length} errors`)

      return NextResponse.json({
        message: 'CSV uploaded and processed successfully',
        csvUploadId,
        rowCount: processedCount,
        totalRows: csvData.length,
        errors: errorMessages.length > 0 ? errorMessages.slice(0, 100) : undefined, // Return first 100 errors
        errorCount: errorMessages.length,
      })
    } catch (error) {
      // Update CSV upload status to failed
      await db.query(
        `UPDATE csv_uploads 
         SET status = 'failed', error_message = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [error.message, csvUploadId]
      )

      throw error
    }
  } catch (error) {
    console.error('Error uploading CSV:', error)
    
    // Handle specific Vercel errors
    if (error.message && error.message.includes('FUNCTION_PAYLOAD_TOO_LARGE')) {
      return NextResponse.json(
        { 
          error: 'File is too large. Maximum file size is 3MB. Please split your CSV file into smaller files or compress it.',
          code: 'PAYLOAD_TOO_LARGE'
        },
        { status: 413 }
      )
    }
    
    return NextResponse.json(
      { error: error.message || 'Failed to upload CSV' },
      { status: 500 }
    )
  }
}


