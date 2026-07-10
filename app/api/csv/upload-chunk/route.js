import { NextResponse } from 'next/server'
import db from '../../../lib/db'
import { validateProductRow, validateVariationRow, parseProductRow, parseVariationRow } from '../../../lib/csv-parser'
import { createVendorCache, resolveVendorId } from '../../../lib/vendor-resolver'
import { auth } from '../../auth/[...nextauth]/route'
import { requireSuperAdminApi } from '../../../lib/role-guards'

// Vercel serverless function configuration
export const maxDuration = 60
export const runtime = 'nodejs'

export async function POST(request) {
  try {
    const session = await auth()
    const roleCheck = requireSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const body = await request.json()
    const { 
      csvUploadId, 
      storeId, 
      vendorId, 
      fileType, 
      chunk, 
      chunkIndex, 
      totalChunks,
      fileName 
    } = body

    if (!csvUploadId || !storeId || !vendorId || !fileType || !chunk || !Array.isArray(chunk)) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    // Verify CSV upload exists and user has access
    const uploadCheck = await db.query(
      `SELECT cu.id, cu.store_id, cu.vendor_id, cu.status,
              cu.last_chunk_index, cu.processed_row_count
       FROM csv_uploads cu
       WHERE cu.id = $1`,
      [csvUploadId]
    )

    if (uploadCheck.rows.length === 0) {
      return NextResponse.json(
        { error: 'CSV upload record not found' },
        { status: 404 }
      )
    }

    const uploadRecord = uploadCheck.rows[0]

    if (uploadRecord.status === 'completed') {
      return NextResponse.json({
        success: true,
        chunkIndex,
        processedCount: 0,
        errorCount: 0,
        errors: [],
        isLastChunk: true,
        skipped: true,
        message: 'Upload already completed',
      })
    }

    const lastCompleted = uploadRecord.last_chunk_index ?? -1
    if (typeof chunkIndex === 'number' && chunkIndex <= lastCompleted) {
      return NextResponse.json({
        success: true,
        chunkIndex,
        processedCount: 0,
        errorCount: 0,
        errors: [],
        isLastChunk: chunkIndex === totalChunks - 1,
        skipped: true,
        message: 'Chunk already processed',
      })
    }

    let processedCount = 0
    const errorMessages = []
    const vendorCache = createVendorCache()
    const defaultVendorId = parseInt(vendorId, 10)

    try {
      if (fileType === 'products') {
        // Process product rows
        for (let i = 0; i < chunk.length; i++) {
          try {
            const row = chunk[i]
            const globalRowIndex = chunkIndex * chunk.length + i
            const errors = validateProductRow(row, globalRowIndex)
            
            if (errors.length > 0) {
              errorMessages.push(...errors)
              continue
            }

            const productData = parseProductRow(row)
            const resolvedVendorId = await resolveVendorId({
              row,
              defaultVendorId,
              vendorCache,
              db,
            })
            const existing = await db.query(
              'SELECT id FROM products WHERE sku = $1 LIMIT 1',
              [productData.sku]
            )

            let productId
            if (existing.rows.length > 0) {
              productId = existing.rows[0].id
              await db.query(
                `UPDATE products SET
                  csv_upload_id = $1, vendor_id = $2, name = $3, description = $4, short_description = $5,
                  price = $6, regular_price = $7, sale_price = $8, stock_quantity = $9,
                  manage_stock = $10, stock_status = $11, categories = $12, tags = $13,
                  images = $14, attributes = $15, brand = $16, updated_at = NOW()
                 WHERE id = $17`,
                [
                  csvUploadId,
                  resolvedVendorId,
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
                  productData.brand,
                  productId,
                ]
              )
            } else {
              const inserted = await db.query(
                `INSERT INTO products (
                  csv_upload_id, vendor_id, sku, name, description, short_description,
                  price, regular_price, sale_price, stock_quantity, manage_stock,
                  stock_status, categories, tags, images, attributes, brand
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                RETURNING id`,
                [
                  csvUploadId,
                  resolvedVendorId,
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
                  productData.brand,
                ]
              )
              productId = inserted.rows[0].id
              // New product starts globally 'pending' (products.status column
              // default) - approval is global, not per-store, so no
              // product_stores linking is needed here (see export/products/route.js).
            }
            processedCount++
          } catch (rowError) {
            const globalRowIndex = chunkIndex * chunk.length + i
            console.error(`Error processing row ${globalRowIndex + 1}:`, rowError.message)
            errorMessages.push(`Row ${globalRowIndex + 1}: ${rowError.message}`)
          }
        }
      } else if (fileType === 'variations') {
        // Process variation rows
        for (let i = 0; i < chunk.length; i++) {
          try {
            const row = chunk[i]
            const globalRowIndex = chunkIndex * chunk.length + i
            const errors = validateVariationRow(row, globalRowIndex)
            
            if (errors.length > 0) {
              errorMessages.push(...errors)
              continue
            }

            const variationData = parseVariationRow(row)

            const productResult = await db.query(
              'SELECT id FROM products WHERE sku = $1 LIMIT 1',
              [variationData.parent_sku]
            )

            if (productResult.rows.length === 0) {
              errorMessages.push(`Row ${globalRowIndex + 1}: Parent product with SKU "${variationData.parent_sku}" not found`)
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
            const globalRowIndex = chunkIndex * chunk.length + i
            console.error(`Error processing row ${globalRowIndex + 1}:`, rowError.message)
            errorMessages.push(`Row ${globalRowIndex + 1}: ${rowError.message}`)
          }
        }
      }

      // Update CSV upload record with progress
      const errorText = errorMessages.length > 0 ? errorMessages.slice(0, 50).join('\n') : null

      if (errorText) {
        await db.query(
          `UPDATE csv_uploads
           SET processed_row_count = COALESCE(processed_row_count, 0) + $1,
               last_chunk_index = GREATEST(COALESCE(last_chunk_index, -1), $2),
               error_message = COALESCE(error_message || '\n' || $3::text, $3::text),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`,
          [processedCount, chunkIndex, errorText, csvUploadId]
        )
      } else {
        await db.query(
          `UPDATE csv_uploads
           SET processed_row_count = COALESCE(processed_row_count, 0) + $1,
               last_chunk_index = GREATEST(COALESCE(last_chunk_index, -1), $2),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [processedCount, chunkIndex, csvUploadId]
        )
      }

      return NextResponse.json({
        success: true,
        chunkIndex,
        processedCount,
        errorCount: errorMessages.length,
        errors: errorMessages.slice(0, 10), // Return first 10 errors
        isLastChunk: chunkIndex === totalChunks - 1,
      })
    } catch (error) {
      console.error('Error processing chunk:', error)
      return NextResponse.json(
        { error: error.message || 'Failed to process chunk' },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Error in chunk upload:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to upload chunk' },
      { status: 500 }
    )
  }
}
