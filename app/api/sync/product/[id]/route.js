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

    // Auto-approve pending products before publishing
    if (product.status === 'pending') {
      await db.query(
        `UPDATE products SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [product.id]
      )
      product.status = 'approved'
    }

    if (product.status !== 'approved' && product.status !== 'synced') {
      return NextResponse.json(
        { error: 'Only approved or synced products can be published' },
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
            `SELECT pv.id, pv.sku, pv.attributes, pv.size, pv.color, pv.price, pv.regular_price, pv.sale_price, 
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
              `SELECT pv.id, pv.sku, pv.attributes, pv.size, pv.color, pv.price, pv.regular_price, pv.sale_price, 
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
            `SELECT pv.id, pv.sku, pv.attributes, pv.size, pv.color, pv.price, pv.regular_price, pv.sale_price, 
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

      // Helper function to extract attributes from variations (using size/color columns + attributes text)
      const extractAttributesFromVariations = (variations) => {
        const attributeMap = new Map()
        
        for (const variation of variations) {
          // Extract from size column
          if (variation.size && variation.size.trim()) {
            const attrName = 'Size'
            if (!attributeMap.has(attrName)) {
              attributeMap.set(attrName, new Set())
            }
            attributeMap.get(attrName).add(variation.size.trim())
          }
          
          // Extract from color column
          if (variation.color && variation.color.trim()) {
            const attrName = 'Color'
            if (!attributeMap.has(attrName)) {
              attributeMap.set(attrName, new Set())
            }
            attributeMap.get(attrName).add(variation.color.trim())
          }
          
          // Also parse from attributes text field (fallback)
          if (variation.attributes) {
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
              
              // Normalize attribute names (Color/Colour -> Color)
              if (attrName.toLowerCase() === 'colour') {
                attrName = 'Color'
              }
              if (attrName.toLowerCase() === 'size') {
                attrName = 'Size'
              }
              
              if (!attributeMap.has(attrName)) {
                attributeMap.set(attrName, new Set())
              }
              attributeMap.get(attrName).add(attrValue)
            }
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
            options: Array.from(values).sort(), // Sort options for consistency
          })
        }
        
        return wooAttributes
      }

      // ✅ STEP 0: Create categories if provided (before creating product)
      const categoryIds = []
      if (product.categories) {
        const categoryNames = product.categories.split(',').map(cat => cat.trim()).filter(Boolean)
        if (categoryNames.length > 0) {
          console.log(`✅ STEP 0: Processing ${categoryNames.length} categories`)
          
          // Get existing categories from WooCommerce (fetch all pages if needed)
          let existingCategories = []
          let page = 1
          let hasMore = true
          
          while (hasMore) {
            const response = await wooClient.getCategories({ per_page: 100, page })
            existingCategories = existingCategories.concat(response)
            hasMore = response.length === 100
            page++
          }
          
          const existingCategoryMap = new Map()
          existingCategories.forEach(cat => {
            existingCategoryMap.set(cat.name.toLowerCase(), cat.id)
          })
          
          console.log(`  Found ${existingCategories.length} existing categories in WooCommerce`)
          
          // Process unique category names
          const uniqueCategoryNames = [...new Set(categoryNames)]
          console.log(`  Found ${uniqueCategoryNames.length} unique category names`)
          
          for (const categoryName of uniqueCategoryNames) {
            const categoryNameLower = categoryName.toLowerCase()
            
            // Check if category already exists
            if (existingCategoryMap.has(categoryNameLower)) {
              const existingId = existingCategoryMap.get(categoryNameLower)
              categoryIds.push(existingId)
              console.log(`  ✓ Category "${categoryName}" already exists (ID: ${existingId})`)
            } else {
              // Create new category
              try {
                const newCategory = await wooClient.createCategory({ name: categoryName })
                categoryIds.push(newCategory.id)
                existingCategoryMap.set(categoryNameLower, newCategory.id)
                console.log(`  ✓ Created category "${categoryName}" (ID: ${newCategory.id})`)
              } catch (catError) {
                console.error(`  ✗ Failed to create category "${categoryName}":`, catError.message)
                // Continue with other categories even if one fails
              }
            }
          }
        }
      }

      // ✅ STEP 1: Create/Update Variable Product (Parent) - WITHOUT attributes initially
      const wooProductData = {
        name: product.name,
        type: hasVariations ? 'variable' : 'simple',
        sku: product.sku || undefined,
        description: product.description || '',
        short_description: product.short_description || '',
        status: 'publish',
      }
      
      console.log(`✅ STEP 1: Creating ${wooProductData.type} product for ${product.name} (SKU: ${product.sku})`)

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
      }
      // Note: For variable products, we DON'T add attributes here - that's STEP 2

      // Add categories using IDs (more reliable than names)
      if (categoryIds.length > 0) {
        wooProductData.categories = categoryIds.map(id => ({ id }))
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

      // Create or update product (STEP 1)
      if (product.woo_product_id) {
        try {
          wooProduct = await wooClient.updateProduct(product.woo_product_id, wooProductData)
        } catch (updateError) {
          // If update fails (e.g., invalid ID), create a new product instead
          console.log(`Update failed for product ID ${product.woo_product_id}, creating new product instead`)
          wooProduct = await wooClient.createProduct(wooProductData)
          // Clear the invalid woo_product_id from database
          await db.query(
            `UPDATE products SET woo_product_id = NULL WHERE id = $1`,
            [product.id]
          )
        }
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

      // ✅ STEP 2: Add Attributes to Variable Product (if it has variations)
      if (hasVariations && variations.length > 0) {
        console.log(`✅ STEP 2: Adding attributes to variable product ${wooProduct.id}`)
        
        // Get ALL variations (not just approved) to extract all possible attribute values
        let allVariationsForAttributes = []
        if (product.sku) {
          let attrResult = await db.query(
            `SELECT pv.attributes, pv.size, pv.color
             FROM product_variations pv
             INNER JOIN products p ON pv.product_id = p.id
             WHERE TRIM(pv.parent_sku) = TRIM($1) AND p.store_id = $2
             UNION
             SELECT pv.attributes, pv.size, pv.color
             FROM product_variations pv
             WHERE pv.product_id = $3`,
            [product.sku, store_id, productId]
          )
          allVariationsForAttributes = attrResult.rows
        } else {
          let attrResult = await db.query(
            `SELECT pv.attributes, pv.size, pv.color
             FROM product_variations pv
             WHERE pv.product_id = $1`,
            [productId]
          )
          allVariationsForAttributes = attrResult.rows
        }
        
        const wooAttributes = extractAttributesFromVariations(allVariationsForAttributes)
        
        if (wooAttributes.length > 0) {
          // Update product with attributes
          const attributesUpdate = {
            attributes: wooAttributes
          }
          
          wooProduct = await wooClient.updateProduct(wooProduct.id, attributesUpdate)
          console.log(`✓ Added ${wooAttributes.length} attributes: ${wooAttributes.map(a => a.name).join(', ')}`)
        } else {
          console.warn(`⚠ Variable product ${product.name} has no attributes extracted from variations`)
        }
      }

      // ✅ STEP 3: Create Variations using Batch Endpoint
      const syncedVariations = []
      if (hasVariations && wooProduct.id && variations.length > 0) {
        console.log(`✅ STEP 3: Creating ${variations.length} variations using batch endpoint`)
        
        // Get fresh product data with attributes (needed for attribute IDs)
        const freshProduct = await wooClient.getProduct(wooProduct.id)
        
        // Prepare batch variations payload
        const batchVariations = {
          create: []
        }
        
        // Track which variations are being batch created (for mapping results back)
        const batchVariationMap = new Map() // index -> variation database id
        
        for (let i = 0; i < variations.length; i++) {
          const variation = variations[i]
          try {
            // Build variation attributes from size/color columns + attributes text
            const variationAttributes = []
            
            // Add Size attribute if present
            if (variation.size && variation.size.trim()) {
              const sizeAttr = freshProduct.attributes?.find(a => 
                a.name === 'Size' || a.name === 'size'
              )
              if (sizeAttr) {
                variationAttributes.push({
                  id: sizeAttr.id,
                  name: sizeAttr.name,
                  option: variation.size.trim(),
                })
              }
            }
            
            // Add Color attribute if present
            if (variation.color && variation.color.trim()) {
              const colorAttr = freshProduct.attributes?.find(a => 
                a.name === 'Color' || a.name === 'Colour' || a.name === 'color' || a.name === 'colour'
              )
              if (colorAttr) {
                variationAttributes.push({
                  id: colorAttr.id,
                  name: colorAttr.name,
                  option: variation.color.trim(),
                })
              }
            }
            
            // Also parse from attributes text field (fallback)
            if (variation.attributes && variationAttributes.length === 0) {
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
                  // Normalize attribute names
                  if (attrName.toLowerCase() === 'colour') attrName = 'Color'
                  
                  const parentAttr = freshProduct.attributes?.find(a => 
                    a.name === attrName || a.name.toLowerCase() === attrName.toLowerCase()
                  )
                  if (parentAttr) {
                    variationAttributes.push({
                      id: parentAttr.id,
                      name: parentAttr.name,
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

            // Add attributes (required for variations)
            if (variationAttributes.length > 0) {
              wooVariationData.attributes = variationAttributes
            } else {
              console.warn(`⚠ Variation ${variation.sku} has no attributes - skipping`)
              continue
            }

            if (variation.tax_class) {
              wooVariationData.tax_class = variation.tax_class
            }

            const imgSrc = variation.image || (variation.images ? String(variation.images).split(',')[0]?.trim() : null)
            if (imgSrc) {
              wooVariationData.image = { src: imgSrc }
            }

            // Add to batch (only for new variations)
            if (!variation.woo_variation_id) {
              const batchIndex = batchVariations.create.length
              batchVariations.create.push(wooVariationData)
              batchVariationMap.set(batchIndex, variation.id) // Map batch index to database variation id
            } else {
              // Update existing variations individually
              try {
                const wooVariation = await wooClient.updateVariation(
                  wooProduct.id,
                  variation.woo_variation_id,
                  wooVariationData
                )
                
                await db.query(
                  `UPDATE product_variations 
                   SET woo_variation_id = $1, status = 'synced', updated_at = CURRENT_TIMESTAMP
                   WHERE id = $2`,
                  [wooVariation.id, variation.id]
                )
                
                syncedVariations.push(wooVariation.id)
              } catch (updateError) {
                // If update fails (e.g., invalid ID), create a new variation instead
                console.log(`Update failed for variation ID ${variation.woo_variation_id}, creating new variation instead`)
                const batchIndex = batchVariations.create.length
                batchVariations.create.push(wooVariationData)
                batchVariationMap.set(batchIndex, variation.id)
                // Clear the invalid woo_variation_id from database
                await db.query(
                  `UPDATE product_variations SET woo_variation_id = NULL WHERE id = $1`,
                  [variation.id]
                )
              }
            }
          } catch (variationError) {
            const errorMsg = variationError.response?.data?.message || variationError.message || 'Unknown error'
            console.error(`Error preparing variation ${variation.id}:`, errorMsg)
            // Continue with other variations even if one fails
          }
        }
        
        // Execute batch create if there are new variations
        // Split into smaller chunks to avoid timeout (20 variations per batch)
        if (batchVariations.create.length > 0) {
          const BATCH_SIZE = 20
          const totalBatches = Math.ceil(batchVariations.create.length / BATCH_SIZE)
          console.log(`Creating ${batchVariations.create.length} variations in ${totalBatches} batch(es) of ${BATCH_SIZE}...`)
          
          let globalIndex = 0
          
          for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
            const startIdx = batchNum * BATCH_SIZE
            const endIdx = Math.min(startIdx + BATCH_SIZE, batchVariations.create.length)
            const chunk = batchVariations.create.slice(startIdx, endIdx)
            
            console.log(`  Processing batch ${batchNum + 1}/${totalBatches} (variations ${startIdx + 1}-${endIdx})...`)
            
            try {
              const chunkBatchData = { create: chunk }
              const batchResult = await wooClient.batchVariations(wooProduct.id, chunkBatchData)
              
              // Update database with created variation IDs
              if (batchResult.create && batchResult.create.length > 0) {
                for (let i = 0; i < batchResult.create.length; i++) {
                  const createdVariation = batchResult.create[i]
                  const actualIndex = startIdx + i
                  const variationDbId = batchVariationMap.get(actualIndex)
                  
                  if (createdVariation && createdVariation.id && variationDbId) {
                    await db.query(
                      `UPDATE product_variations 
                       SET woo_variation_id = $1, status = 'synced', updated_at = CURRENT_TIMESTAMP
                       WHERE id = $2`,
                      [createdVariation.id, variationDbId]
                    )
                    syncedVariations.push(createdVariation.id)
                  } else if (createdVariation && createdVariation.error) {
                    console.error(`Error creating variation at index ${actualIndex}:`, createdVariation.error)
                  }
                }
              }
              
              console.log(`  ✓ Batch ${batchNum + 1} completed: ${batchResult.create?.length || 0} variations created`)
            } catch (batchError) {
              const errorMsg = batchError.response?.data?.message || batchError.message || 'Unknown error'
              console.error(`  ✗ Error in batch ${batchNum + 1}:`, errorMsg)
              // Continue with next batch instead of failing completely
              // throw batchError
            }
          }
          
          console.log(`✓ Completed all batches: ${syncedVariations.length} variations synced successfully`)
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
