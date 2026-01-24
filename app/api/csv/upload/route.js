import { NextResponse } from 'next/server'
import { requireAdmin } from '../../../lib/auth'
import db from '../../../lib/db'
import { parseCSV, validateProductRow, validateVariationRow, parseProductRow, parseVariationRow } from '../../../lib/csv-parser'
import { auth } from '../../auth/[...nextauth]/route'

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
    const fileBuffer = await file.arrayBuffer()
    const fileText = Buffer.from(fileBuffer).toString('utf-8')

    // Parse CSV
    const csvData = await parseCSV(fileText)

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
        // Validate and process products
        for (let i = 0; i < csvData.length; i++) {
          const row = csvData[i]
          const errors = validateProductRow(row, i)
          
          if (errors.length > 0) {
            errorMessages.push(...errors)
            continue
          }

          const productData = parseProductRow(row)

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
          processedCount++
        }
      } else if (fileType === 'variations') {
        // Validate and process variations
        for (let i = 0; i < csvData.length; i++) {
          const row = csvData[i]
          const errors = validateVariationRow(row, i)
          
          if (errors.length > 0) {
            errorMessages.push(...errors)
            continue
          }

          const variationData = parseVariationRow(row)

          // Find parent product by SKU
          const productResult = await db.query(
            'SELECT id FROM products WHERE store_id = $1 AND sku = $2 LIMIT 1',
            [storeId, variationData.parent_sku]
          )

          if (productResult.rows.length === 0) {
            errorMessages.push(`Row ${i + 1}: Parent product with SKU "${variationData.parent_sku}" not found`)
            continue
          }

          const productId = productResult.rows[0].id

          await db.query(
            `INSERT INTO product_variations (
              product_id, csv_upload_id, parent_sku, sku, attributes,
              price, regular_price, sale_price, stock_quantity, manage_stock,
              stock_status, image, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')`,
            [
              productId,
              csvUploadId,
              variationData.parent_sku,
              variationData.sku,
              variationData.attributes,
              variationData.price,
              variationData.regular_price,
              variationData.sale_price,
              variationData.stock_quantity,
              variationData.manage_stock,
              variationData.stock_status,
              variationData.image,
            ]
          )
          processedCount++
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
          errorMessages.length > 0 ? errorMessages.join('\n') : null,
          csvUploadId,
        ]
      )

      return NextResponse.json({
        message: 'CSV uploaded and processed successfully',
        csvUploadId,
        rowCount: processedCount,
        errors: errorMessages.length > 0 ? errorMessages : undefined,
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
    return NextResponse.json(
      { error: error.message || 'Failed to upload CSV' },
      { status: 500 }
    )
  }
}


