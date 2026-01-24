import { NextResponse } from 'next/server'
import { requireAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'

const WooCommerceClient = require('../../../../lib/woocommerce')

export async function POST(request, { params }) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const productId = parseInt(id)

    const body = await request.json()
    const { store_id } = body

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

    // Get product
    const productResult = await db.query(
      `SELECT id, sku, name, description, short_description, price, regular_price, 
              sale_price, stock_quantity, manage_stock, stock_status, categories, tags, images, 
              attributes, woo_product_id, store_id, status
       FROM products 
       WHERE id = $1 AND store_id = $2`,
      [productId, store_id]
    )

    if (productResult.rows.length === 0) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    const product = productResult.rows[0]

    if (product.status !== 'approved') {
      return NextResponse.json(
        { error: 'Only approved products can be synced' },
        { status: 400 }
      )
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

    const wooClient = new WooCommerceClient(
      store.store_url,
      store.consumer_key,
      store.consumer_secret
    )

    try {
      // Step 1: Check if product has ANY variations (regardless of status) to determine product type
      // Step 2: Get only APPROVED variations for syncing
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
            [productId]
          )
          hasVariations = parseInt(checkResult.rows[0].count) > 0
        }
        
        // Now get only APPROVED variations for syncing
        if (hasVariations) {
          let variationsResult = await db.query(
            `SELECT pv.id, pv.sku, pv.attributes, pv.price, pv.regular_price, pv.sale_price, 
                    pv.stock_quantity, pv.manage_stock, pv.stock_status, pv.image, 
                    pv.tax_class, pv.images, pv.woo_variation_id, pv.status
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
                      pv.tax_class, pv.images, pv.woo_variation_id, pv.status
               FROM product_variations pv
               WHERE pv.product_id = $1 
                 AND pv.status = 'approved'
               ORDER BY pv.id`,
              [productId]
            )
            approvedVariations = variationsResult.rows
          }
        }
        
        // Debug logging
        if (hasVariations) {
          console.log(`✓ Product ${productId} (SKU: ${product.sku}) has variations - will create VARIABLE product`)
          console.log(`  Found ${approvedVariations.length} approved variations to sync`)
        } else {
          console.log(`✗ Product ${productId} (SKU: ${product.sku}) has no variations - will create SIMPLE product`)
        }
      } else {
        // No SKU, but still check by product_id
        const checkResult = await db.query(
          `SELECT COUNT(*) as count
           FROM product_variations pv
           WHERE pv.product_id = $1`,
          [productId]
        )
        hasVariations = parseInt(checkResult.rows[0].count) > 0
        
        if (hasVariations) {
          const variationsResult = await db.query(
            `SELECT pv.id, pv.sku, pv.attributes, pv.price, pv.regular_price, pv.sale_price, 
                    pv.stock_quantity, pv.manage_stock, pv.stock_status, pv.image, 
                    pv.tax_class, pv.images, pv.woo_variation_id, pv.status
             FROM product_variations pv
             WHERE pv.product_id = $1 
               AND pv.status = 'approved'
             ORDER BY pv.id`,
            [productId]
          )
          approvedVariations = variationsResult.rows
          console.log(`✓ Product ${productId} (no SKU) has variations by product_id - will create VARIABLE product`)
          console.log(`  Found ${approvedVariations.length} approved variations to sync`)
        } else {
          console.log(`✗ Product ${productId} (no SKU) has no variations - will create SIMPLE product`)
        }
      }
      
      // Use approved variations for syncing, but use hasVariations for product type
      const variations = approvedVariations

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
            [product.sku, store_id, productId]
          )
          allVariationsForAttributes = attrResult.rows
        } else {
          let attrResult = await db.query(
            `SELECT pv.attributes
             FROM product_variations pv
             WHERE pv.product_id = $1`,
            [productId]
          )
          allVariationsForAttributes = attrResult.rows
        }
        
        const wooAttributes = parseAttributesFromVariations(allVariationsForAttributes)
        if (wooAttributes.length > 0) {
          wooProductData.attributes = wooAttributes
          console.log(`Added ${wooAttributes.length} attributes to variable product`)
        } else {
          console.warn(`Variable product ${product.name} has no attributes extracted from variations`)
          console.warn(`All variations:`, allVariationsForAttributes)
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
      const syncedVariations = []
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

            if (variation.tax_class) {
              wooVariationData.tax_class = variation.tax_class
            }

            const imgSrc = variation.image || (variation.images ? String(variation.images).split(',')[0]?.trim() : null)
            if (imgSrc) {
              wooVariationData.image = { src: imgSrc }
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

            syncedVariations.push(wooVariation.id)
          } catch (variationError) {
            const errorMsg = variationError.response?.data?.message || variationError.message || 'Unknown error'
            console.error(`Error syncing variation ${variation.id}:`, errorMsg)
            // Continue with other variations even if one fails
          }
        }
      }

      // Update store last sync time
      await db.query(
        'UPDATE stores SET last_sync_at = CURRENT_TIMESTAMP WHERE id = $1',
        [store_id]
      )

      return NextResponse.json({
        success: true,
        message: hasVariations 
          ? `Product and ${syncedVariations.length} variation(s) synced successfully`
          : 'Product synced successfully',
        woo_product_id: wooProduct.id,
        variations_synced: syncedVariations.length,
      })
    } catch (error) {
      const errorMsg = error.response?.data?.message || error.message || 'Unknown error'
      console.error(`Error syncing product ${productId}:`, errorMsg)
      
      return NextResponse.json(
        { error: `Failed to sync product: ${errorMsg}` },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Sync product error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to sync product' },
      { status: 500 }
    )
  }
}
