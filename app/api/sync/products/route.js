import { NextResponse } from 'next/server'
import { requireAdmin } from '../../../lib/auth'
import db from '../../../lib/db'
import { auth } from '../../auth/[...nextauth]/route'

const WooCommerceClient = require('../../../lib/woocommerce')

export async function POST(request) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { store_id, sync_type = 'products' } = body

    if (!store_id) {
      return NextResponse.json({ error: 'Store ID is required' }, { status: 400 })
    }

    // Check if admin has access to this store
    if (session.user.role !== 'super_admin') {
      const accessCheck = await db.query(
        'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
        [session.user.id, store_id]
      )

      if (accessCheck.rows.length === 0) {
        return NextResponse.json(
          { error: 'Unauthorized access to this store' },
          { status: 403 }
        )
      }
    }

    // Get store credentials
    const storeResult = await db.query(
      'SELECT id, name, store_url, consumer_key, consumer_secret FROM stores WHERE id = $1',
      [store_id]
    )

    if (storeResult.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const store = storeResult.rows[0]

    if (!store.store_url || !store.consumer_key || !store.consumer_secret) {
      return NextResponse.json(
        { error: 'Store WooCommerce credentials are not configured' },
        { status: 400 }
      )
    }

    // Create sync log
    const syncLogResult = await db.query(
      `INSERT INTO sync_logs (store_id, sync_type, status, initiated_by)
       VALUES ($1, $2, 'running', $3)
       RETURNING id`,
      [store_id, sync_type, session.user.id]
    )

    const syncLogId = syncLogResult.rows[0].id

    // Get approved products
    const productsResult = await db.query(
      `SELECT id, sku, name, description, short_description, price, regular_price, 
              sale_price, stock_quantity, manage_stock, stock_status, categories, tags, images, 
              attributes, woo_product_id
       FROM products 
       WHERE store_id = $1 AND status = 'approved'
       ORDER BY id`,
      [store_id]
    )

    const products = productsResult.rows

    if (products.length === 0) {
      // Update sync log with no products message
      await db.query(
        `UPDATE sync_logs 
         SET status = 'completed', items_processed = 0, items_succeeded = 0, 
             items_failed = 0, completed_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [syncLogId]
      )

      return NextResponse.json({
        syncId: syncLogId,
        message: 'No approved products to sync',
        processed: 0,
        succeeded: 0,
        failed: 0,
      })
    }

    const wooClient = new WooCommerceClient(
      store.store_url,
      store.consumer_key,
      store.consumer_secret
    )

    let processed = 0
    let succeeded = 0
    let failed = 0
    const errors = []

    // Helper function to parse attributes from variations
    const parseAttributesFromVariations = (variations) => {
      const attributeMap = new Map()
      
      for (const variation of variations) {
        if (!variation.attributes) continue
        
        // Parse attributes - format: "Colour: Red; Size: Large" or "Colour=Red;Size=Large"
        const attrPairs = variation.attributes.split(';').map(a => a.trim()).filter(Boolean)
        
        for (const pair of attrPairs) {
          let attrName, attrValue
          
          if (pair.includes(':')) {
            [attrName, attrValue] = pair.split(':').map(s => s.trim())
          } else if (pair.includes('=')) {
            [attrName, attrValue] = pair.split('=').map(s => s.trim())
          } else {
            continue
          }
          
          if (!attrName || !attrValue) continue
          
          if (!attributeMap.has(attrName)) {
            attributeMap.set(attrName, new Set())
          }
          attributeMap.get(attrName).add(attrValue)
        }
      }
      
      // Convert to WooCommerce format
      const wooAttributes = []
      for (const [name, values] of attributeMap.entries()) {
        wooAttributes.push({
          id: 0, // Will be created by WooCommerce
          name: name,
          position: wooAttributes.length,
          visible: true,
          variation: true,
          options: Array.from(values),
        })
      }
      
      return wooAttributes
    }

    // Sync each product
    for (const product of products) {
      try {
        processed++
        
        // Step 1: Check if product has ANY variations (regardless of status) to determine product type
        // Step 2: Get only APPROVED variations for syncing
        let allVariations = []
        let approvedVariations = []
        let hasVariations = false
        
        if (product.sku) {
          // First try: Match by parent_sku (preferred method) - check for ANY variations
          let checkResult = await db.query(
            `SELECT COUNT(*) as count
             FROM product_variations pv
             INNER JOIN products p ON pv.product_id = p.id
             WHERE TRIM(pv.parent_sku) = TRIM($1)
               AND p.store_id = $2`,
            [product.sku, store_id]
          )
          
          hasVariations = parseInt(checkResult.rows[0].count) > 0
          
          // Fallback: If no variations found by parent_sku, try by product_id
          if (!hasVariations) {
            console.log(`No variations found by parent_sku for ${product.sku}, trying product_id...`)
            checkResult = await db.query(
              `SELECT COUNT(*) as count
               FROM product_variations pv
               WHERE pv.product_id = $1`,
              [product.id]
            )
            hasVariations = parseInt(checkResult.rows[0].count) > 0
          }
          
          // Now get only APPROVED variations for syncing
          if (hasVariations) {
            let variationsResult = await db.query(
              `SELECT pv.id, pv.sku, pv.attributes, pv.price, pv.regular_price, pv.sale_price, 
                      pv.stock_quantity, pv.manage_stock, pv.stock_status, pv.image, 
                      pv.woo_variation_id, pv.status
               FROM product_variations pv
               INNER JOIN products p ON pv.product_id = p.id
               WHERE TRIM(pv.parent_sku) = TRIM($1)
                 AND p.store_id = $2 
                 AND pv.status = 'approved'
               ORDER BY pv.id`,
              [product.sku, store_id]
            )
            
            approvedVariations = variationsResult.rows
            
            // Fallback: If no approved variations found by parent_sku, try by product_id
            if (approvedVariations.length === 0) {
              variationsResult = await db.query(
                `SELECT pv.id, pv.sku, pv.attributes, pv.price, pv.regular_price, pv.sale_price, 
                        pv.stock_quantity, pv.manage_stock, pv.stock_status, pv.image, 
                        pv.woo_variation_id, pv.status
                 FROM product_variations pv
                 WHERE pv.product_id = $1 
                   AND pv.status = 'approved'
                 ORDER BY pv.id`,
                [product.id]
              )
              approvedVariations = variationsResult.rows
            }
          }
          
          // Debug logging
          if (hasVariations) {
            console.log(`✓ Product ${product.id} (SKU: ${product.sku}) has variations - will create VARIABLE product`)
            console.log(`  Found ${approvedVariations.length} approved variations to sync`)
          } else {
            console.log(`✗ Product ${product.id} (SKU: ${product.sku}) has no variations - will create SIMPLE product`)
          }
        } else {
          // No SKU, but still check by product_id
          const checkResult = await db.query(
            `SELECT COUNT(*) as count
             FROM product_variations pv
             WHERE pv.product_id = $1`,
            [product.id]
          )
          hasVariations = parseInt(checkResult.rows[0].count) > 0
          
          if (hasVariations) {
            const variationsResult = await db.query(
              `SELECT pv.id, pv.sku, pv.attributes, pv.price, pv.regular_price, pv.sale_price, 
                      pv.stock_quantity, pv.manage_stock, pv.stock_status, pv.image, 
                      pv.woo_variation_id, pv.status
               FROM product_variations pv
               WHERE pv.product_id = $1 
                 AND pv.status = 'approved'
               ORDER BY pv.id`,
              [product.id]
            )
            approvedVariations = variationsResult.rows
            console.log(`✓ Product ${product.id} (no SKU) has variations by product_id - will create VARIABLE product`)
            console.log(`  Found ${approvedVariations.length} approved variations to sync`)
          } else {
            console.log(`✗ Product ${product.id} (no SKU) has no variations - will create SIMPLE product`)
          }
        }
        
        // Use approved variations for syncing, but use hasVariations for product type
        const variations = approvedVariations
        
        // Convert to WooCommerce format
        const wooProductData = {
          name: product.name,
          type: hasVariations ? 'variable' : 'simple',
          sku: product.sku || undefined,
          description: product.description || '',
          short_description: product.short_description || '',
          status: 'publish',
        }
        
        // Debug: Log product type decision
        console.log(`Creating ${wooProductData.type} product for ${product.name} (SKU: ${product.sku})`)

        // For simple products, add pricing and stock
        if (!hasVariations) {
          wooProductData.regular_price = product.regular_price?.toString() || product.price?.toString() || ''
          wooProductData.sale_price = product.sale_price?.toString() || undefined
          wooProductData.manage_stock = product.manage_stock || (product.stock_quantity !== null)
          wooProductData.stock_quantity = product.stock_quantity || undefined
          wooProductData.stock_status = product.stock_status || 'instock'
          
          // Remove empty sale_price
          if (!wooProductData.sale_price) {
            delete wooProductData.sale_price
          }
        } else {
          // For variable products: Step 1 - Add attributes (no pricing/stock on parent)
          // Variable products MUST have attributes in WooCommerce
          // Get ALL variations (not just approved) to extract attributes
          let allVariationsForAttributes = []
          if (product.sku) {
            let attrResult = await db.query(
              `SELECT pv.attributes
               FROM product_variations pv
               INNER JOIN products p ON pv.product_id = p.id
               WHERE TRIM(pv.parent_sku) = TRIM($1) AND p.store_id = $2
               UNION
               SELECT pv.attributes
               FROM product_variations pv
               WHERE pv.product_id = $3`,
              [product.sku, store_id, product.id]
            )
            allVariationsForAttributes = attrResult.rows
          } else {
            let attrResult = await db.query(
              `SELECT pv.attributes
               FROM product_variations pv
               WHERE pv.product_id = $1`,
              [product.id]
            )
            allVariationsForAttributes = attrResult.rows
          }
          
          const wooAttributes = parseAttributesFromVariations(allVariationsForAttributes)
          if (wooAttributes.length > 0) {
            wooProductData.attributes = wooAttributes
            console.log(`Added ${wooAttributes.length} attributes to variable product`)
          } else {
            console.error(`ERROR: Variable product ${product.name} has variations but no attributes could be extracted!`)
            console.error(`All variations:`, allVariationsForAttributes)
            // Still create as variable, but WooCommerce might reject it without attributes
            // This should not happen if variations have proper attributes
          }
          // Variable products don't have pricing/stock on parent - only on variations
        }

        // Parse categories if provided
        if (product.categories) {
          const categoryNames = product.categories.split(',').map(cat => cat.trim()).filter(Boolean)
          if (categoryNames.length > 0) {
            wooProductData.categories = categoryNames.map(name => ({ name }))
          }
        }

        // Parse tags if provided
        if (product.tags) {
          const tagNames = product.tags.split(',').map(tag => tag.trim()).filter(Boolean)
          if (tagNames.length > 0) {
            wooProductData.tags = tagNames.map(name => ({ name }))
          }
        }

        // Parse images if provided
        if (product.images) {
          const imageUrls = product.images.split(',').map(url => url.trim()).filter(Boolean)
          if (imageUrls.length > 0) {
            wooProductData.images = imageUrls.map(src => ({ src }))
          }
        }

        let wooProduct

        // Update existing or create new
        if (product.woo_product_id) {
          wooProduct = await wooClient.updateProduct(product.woo_product_id, wooProductData)
        } else {
          wooProduct = await wooClient.createProduct(wooProductData)
        }

        // Update product in database
        await db.query(
          `UPDATE products 
           SET woo_product_id = $1, status = 'synced', updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [wooProduct.id, product.id]
        )

        // Step 2: Sync variations if product has them (after parent is created)
        if (hasVariations && wooProduct.id) {
          for (const variation of variations) {
            try {
              // Parse variation attributes to WooCommerce format
              const variationAttributes = []
              if (variation.attributes) {
                const attrPairs = variation.attributes.split(';').map(a => a.trim()).filter(Boolean)
                for (const pair of attrPairs) {
                  let attrName, attrValue
                  
                  if (pair.includes(':')) {
                    [attrName, attrValue] = pair.split(':').map(s => s.trim())
                  } else if (pair.includes('=')) {
                    [attrName, attrValue] = pair.split('=').map(s => s.trim())
                  } else {
                    continue
                  }
                  
                  if (attrName && attrValue) {
                    // Find attribute ID from parent product
                    const parentAttr = wooProduct.attributes?.find(a => a.name === attrName)
                    if (parentAttr) {
                      variationAttributes.push({
                        id: parentAttr.id,
                        name: attrName,
                        option: attrValue,
                      })
                    }
                  }
                }
              }

              const wooVariationData = {
                sku: variation.sku || undefined,
                regular_price: variation.regular_price?.toString() || variation.price?.toString() || '',
                sale_price: variation.sale_price?.toString() || undefined,
                manage_stock: variation.manage_stock || (variation.stock_quantity !== null),
                stock_quantity: variation.stock_quantity || undefined,
                stock_status: variation.stock_status || 'instock',
                status: 'publish',
              }

              // Remove empty sale_price
              if (!wooVariationData.sale_price) {
                delete wooVariationData.sale_price
              }

              // Add attributes
              if (variationAttributes.length > 0) {
                wooVariationData.attributes = variationAttributes
              }

              // Add image if provided
              if (variation.image) {
                wooVariationData.image = { src: variation.image }
              }

              let wooVariation

              // Update existing or create new variation
              if (variation.woo_variation_id) {
                wooVariation = await wooClient.updateVariation(
                  wooProduct.id,
                  variation.woo_variation_id,
                  wooVariationData
                )
              } else {
                wooVariation = await wooClient.createVariation(wooProduct.id, wooVariationData)
              }

              // Update variation in database
              await db.query(
                `UPDATE product_variations 
                 SET woo_variation_id = $1, status = 'synced', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [wooVariation.id, variation.id]
              )
            } catch (variationError) {
              const errorMsg = variationError.response?.data?.message || variationError.message || 'Unknown error'
              errors.push(`Variation ${variation.id} (${variation.sku || 'N/A'}): ${errorMsg}`)
              console.error(`Error syncing variation ${variation.id}:`, errorMsg)
            }
          }
        }

        succeeded++
      } catch (error) {
        failed++
        const errorMsg = error.response?.data?.message || error.message || 'Unknown error'
        errors.push(`Product ${product.id} (${product.sku || product.name}): ${errorMsg}`)
        console.error(`Error syncing product ${product.id}:`, errorMsg)
      }
    }

    // Update sync log
    await db.query(
      `UPDATE sync_logs 
       SET status = $1, items_processed = $2, items_succeeded = $3, 
           items_failed = $4, error_message = $5, completed_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [
        failed > 0 && succeeded === 0 ? 'failed' : 'completed',
        processed,
        succeeded,
        failed,
        errors.length > 0 ? errors.slice(0, 10).join('\n') : null, // Limit error message length
        syncLogId
      ]
    )

    // Update store last sync time
    await db.query(
      'UPDATE stores SET last_sync_at = CURRENT_TIMESTAMP WHERE id = $1',
      [store_id]
    )

    return NextResponse.json({
      syncId: syncLogId,
      message: 'Sync completed',
      processed,
      succeeded,
      failed,
      errors: errors.length > 0 ? errors.slice(0, 20) : undefined, // Return first 20 errors
    })
  } catch (error) {
    console.error('Sync error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to sync products' },
      { status: 500 }
    )
  }
}
