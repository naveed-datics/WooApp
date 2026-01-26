import { NextResponse } from 'next/server'
import db from '../../../lib/db'
import { validateProductRow, validateVariationRow, parseProductRow, parseVariationRow } from '../../../lib/csv-parser'
import { auth } from '../../auth/[...nextauth]/route'

// Vercel serverless function configuration
export const maxDuration = 60
export const runtime = 'nodejs'

export async function POST(request) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
      `SELECT cu.id, cu.store_id, cu.vendor_id 
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

    let processedCount = 0
    const errorMessages = []

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
              'SELECT id FROM products WHERE store_id = $1 AND sku = $2 LIMIT 1',
              [storeId, variationData.parent_sku]
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
      await db.query(
        `UPDATE csv_uploads 
         SET row_count = row_count + $1, 
             error_message = CASE 
               WHEN error_message IS NULL THEN $2
               WHEN $2 IS NOT NULL THEN error_message || '\n' || $2
               ELSE error_message
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [
          processedCount,
          errorMessages.length > 0 ? errorMessages.slice(0, 50).join('\n') : null,
          csvUploadId,
        ]
      )

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
