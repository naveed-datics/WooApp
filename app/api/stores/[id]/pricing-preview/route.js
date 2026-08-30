import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '../../../../lib/role-guards'
import { getStorePricingContext } from '../../../../lib/app-settings'
import { resolveItemPrice, resolveCostPrice, toNumber, round2 } from '../../../../lib/pricing'

/**
 * POST /api/stores/[id]/pricing-preview
 * READ-ONLY live pricing calculator & impact preview endpoint.
 *
 * Supports:
 * 1. Single cost calculation: { "cost": 12.50 }
 * 2. Product & variations calculation: { "product_id": 123 }
 * 3. Batch Catalog Impact Preview: { "preview_sample": true, "preview_rules": [...], "preview_fallback": 35.0 }
 */
export async function POST(request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id } = await params
    const storeId = parseInt(id, 10)

    if (session.user.role !== 'super_admin') {
      const hasAccess = await verifyAdminStoreAccess(db, session.user.id, storeId)
      if (!hasAccess) {
        return NextResponse.json({ error: 'Unauthorized access to this store' }, { status: 403 })
      }
    }

    const body = await request.json().catch(() => ({}))

    // 1. Fetch Current Store Pricing Configuration
    const storeRes = await db.query(
      `SELECT id, name, pricing_mode, price_rule_percent, fallback_markup_percent
       FROM stores WHERE id = $1`,
      [storeId]
    )

    if (storeRes.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const store = storeRes.rows[0]
    const pricingContext = await getStorePricingContext(store)
    const activeStoreContext = {
      pricing_mode: store.pricing_mode || 'legacy_markup',
      price_rule_percent: pricingContext.override,
      fallback_markup_percent: store.fallback_markup_percent ? Number(store.fallback_markup_percent) : null,
      default_price_rule_percent: pricingContext.defaultPercent,
      defaultPercent: pricingContext.defaultPercent,
    }

    // 2. Fetch Active Range Rules from DB
    let savedRules = []
    try {
      const rulesRes = await db.query(
        `SELECT id, min_cost, max_cost, markup_percent, active
         FROM store_pricing_rules
         WHERE store_id = $1 AND active = true
         ORDER BY min_cost ASC`,
        [storeId]
      )
      savedRules = rulesRes.rows.map((r) => ({
        id: r.id,
        min_cost: Number(r.min_cost),
        max_cost: r.max_cost !== null ? Number(r.max_cost) : null,
        markup_percent: Number(r.markup_percent),
        active: r.active,
      }))
    } catch {
      savedRules = []
    }

    // ── Case A: Ad-hoc Single Cost Calculation ───────────────────────────
    if (body.cost !== undefined && body.cost !== null) {
      const rawCost = toNumber(body.cost)
      const rulesToUse = Array.isArray(body.preview_rules) ? body.preview_rules : savedRules
      const contextToUse = {
        ...activeStoreContext,
        pricing_mode: body.preview_mode || activeStoreContext.pricing_mode,
        fallback_markup_percent: body.preview_fallback !== undefined ? toNumber(body.preview_fallback) : activeStoreContext.fallback_markup_percent,
      }
      const result = resolveItemPrice(rawCost, contextToUse, rulesToUse, null)
      return NextResponse.json({
        store_id: storeId,
        pricing_mode: contextToUse.pricing_mode,
        supplier_cost: result.cost,
        selling_price: result.sellingPrice,
        source: result.source,
        applied_markup: result.appliedMarkup,
        matched_rule_id: result.matchedRuleId,
      })
    }

    // ── Case B: Batch Catalog Impact Preview (20 Representative Items) ───
    if (body.preview_sample === true) {
      const sampleLimit = Math.min(parseInt(body.limit, 10) || 20, 50)
      const proposedRules = Array.isArray(body.preview_rules) ? body.preview_rules : savedRules
      const proposedContext = {
        pricing_mode: 'range_rules',
        fallback_markup_percent: body.preview_fallback !== undefined ? toNumber(body.preview_fallback) : activeStoreContext.fallback_markup_percent,
        price_rule_percent: activeStoreContext.price_rule_percent,
        defaultPercent: activeStoreContext.defaultPercent,
      }

      // Fetch sample of products & variations associated with store
      const itemsRes = await db.query(
        `SELECT p.id as product_id, p.sku as product_sku, p.name as product_name,
                COALESCE(p.regular_price, p.price) as product_cost,
                pv.id as variation_id, pv.sku as variation_sku,
                COALESCE(pv.regular_price, pv.price) as variation_cost,
                pv.size, pv.color
         FROM products p
         LEFT JOIN product_variations pv ON pv.product_id = p.id
         LEFT JOIN vendor_stores vs ON vs.vendor_id = p.vendor_id AND vs.store_id = $1
         WHERE (p.store_id = $1 OR vs.store_id = $1)
         ORDER BY p.id ASC, pv.id ASC
         LIMIT $2`,
        [storeId, sampleLimit * 2]
      )

      // Also load existing product overrides for this store
      let overridesMap = new Map()
      try {
        const overridesRes = await db.query(
          `SELECT product_id, override_type, custom_markup_percent, fixed_price
           FROM product_store_pricing WHERE store_id = $1`,
          [storeId]
        )
        for (const o of overridesRes.rows) {
          overridesMap.set(o.product_id, {
            override_type: o.override_type,
            custom_markup_percent: o.custom_markup_percent !== null ? Number(o.custom_markup_percent) : null,
            fixed_price: o.fixed_price !== null ? Number(o.fixed_price) : null,
          })
        }
      } catch {
        overridesMap = new Map()
      }

      const comparisonItems = []
      const seenSkus = new Set()

      for (const row of itemsRes.rows) {
        const isVariation = Boolean(row.variation_id)
        const sku = isVariation ? row.variation_sku || row.product_sku : row.product_sku
        if (!sku || seenSkus.has(sku)) continue
        seenSkus.add(sku)

        const cost = isVariation ? toNumber(row.variation_cost) : toNumber(row.product_cost)
        if (cost === null) continue

        const override = overridesMap.get(row.product_id) || null

        // 1. Current Active Price
        const currentRes = resolveItemPrice(cost, activeStoreContext, savedRules, override)

        // 2. Proposed Range Price
        const proposedRes = resolveItemPrice(cost, proposedContext, proposedRules, override)

        const currentPrice = currentRes.sellingPrice
        const proposedPrice = proposedRes.sellingPrice
        const diffAmount = currentPrice !== null && proposedPrice !== null ? round2(proposedPrice - currentPrice) : 0
        const diffPercent = currentPrice && currentPrice > 0 ? round2(((proposedPrice - currentPrice) / currentPrice) * 100) : 0

        comparisonItems.push({
          product_id: row.product_id,
          name: row.product_name,
          sku,
          is_variation: isVariation,
          variation_attrs: isVariation ? [row.color, row.size].filter(Boolean).join(' / ') : null,
          supplier_cost: cost,
          current_price: currentPrice,
          current_source: currentRes.source,
          proposed_price: proposedPrice,
          proposed_source: proposedRes.source,
          applied_markup: proposedRes.appliedMarkup,
          diff_amount: diffAmount,
          diff_percent: diffPercent,
        })

        if (comparisonItems.length >= sampleLimit) break
      }

      return NextResponse.json({
        store_id: storeId,
        current_pricing_mode: activeStoreContext.pricing_mode,
        current_markup_percent: activeStoreContext.price_rule_percent,
        sample_count: comparisonItems.length,
        items: comparisonItems,
      })
    }

    // ── Case C: Single Product & Variations Calculation ──────────────────
    const productId = parseInt(body.product_id, 10)
    if (!productId || Number.isNaN(productId)) {
      return NextResponse.json({ error: 'Provide a numeric "cost", "product_id", or "preview_sample": true in the request body.' }, { status: 400 })
    }

    const prodRes = await db.query(
      `SELECT id, sku, name, price, regular_price, sale_price
       FROM products
       WHERE id = $1`,
      [productId]
    )

    if (prodRes.rows.length === 0) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    const product = prodRes.rows[0]

    let productOverride = null
    try {
      const overrideRes = await db.query(
        `SELECT override_type, custom_markup_percent, fixed_price
         FROM product_store_pricing
         WHERE store_id = $1 AND product_id = $2 LIMIT 1`,
        [storeId, productId]
      )
      if (overrideRes.rows.length > 0) {
        const row = overrideRes.rows[0]
        productOverride = {
          override_type: row.override_type,
          custom_markup_percent: row.custom_markup_percent !== null ? Number(row.custom_markup_percent) : null,
          fixed_price: row.fixed_price !== null ? Number(row.fixed_price) : null,
        }
      }
    } catch {
      productOverride = null
    }

    const parentCost = resolveCostPrice(product)
    const parentCalc = resolveItemPrice(parentCost, activeStoreContext, savedRules, productOverride)

    const varRes = await db.query(
      `SELECT id, sku, price, regular_price, sale_price, size, color
       FROM product_variations
       WHERE product_id = $1
       ORDER BY created_at ASC`,
      [productId]
    )

    const variationsPreview = varRes.rows.map((v) => {
      const varCost = resolveCostPrice(v)
      const varCalc = resolveItemPrice(varCost, activeStoreContext, savedRules, productOverride)
      return {
        id: v.id,
        sku: v.sku,
        size: v.size,
        color: v.color,
        supplier_cost: varCost,
        selling_price: varCalc.sellingPrice,
        source: varCalc.source,
        applied_markup: varCalc.appliedMarkup,
        matched_rule_id: varCalc.matchedRuleId,
      }
    })

    return NextResponse.json({
      store_id: storeId,
      pricing_mode: activeStoreContext.pricing_mode,
      product: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        supplier_cost: parentCost,
        selling_price: parentCalc.sellingPrice,
        source: parentCalc.source,
        applied_markup: parentCalc.appliedMarkup,
        matched_rule_id: parentCalc.matchedRuleId,
        override: productOverride || { override_type: 'store_rules', custom_markup_percent: null, fixed_price: null },
      },
      variations: variationsPreview,
    })
  } catch (error) {
    console.error('Error calculating pricing preview:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}