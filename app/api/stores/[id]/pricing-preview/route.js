import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '../../../../lib/role-guards'
import { getStorePricingContext } from '../../../../lib/app-settings'
import { resolveItemPrice, resolveCostPrice, toNumber } from '../../../../lib/pricing'

/**
 * POST /api/stores/[id]/pricing-preview
 * READ-ONLY live pricing calculator / preview endpoint.
 *
 * Supports:
 * - Single cost calculation: { "cost": 12.50 }
 * - Product & all variations calculation: { "product_id": 123 }
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

    // 1. Fetch Store Pricing Configuration
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
    const storeContext = {
      pricing_mode: store.pricing_mode || 'legacy_markup',
      price_rule_percent: pricingContext.override,
      fallback_markup_percent: store.fallback_markup_percent ? Number(store.fallback_markup_percent) : null,
      default_price_rule_percent: pricingContext.defaultPercent,
      defaultPercent: pricingContext.defaultPercent,
    }

    // 2. Fetch Active Range Rules
    let rangeRules = []
    try {
      const rulesRes = await db.query(
        `SELECT id, min_cost, max_cost, markup_percent, active
         FROM store_pricing_rules
         WHERE store_id = $1 AND active = true
         ORDER BY min_cost ASC`,
        [storeId]
      )
      rangeRules = rulesRes.rows.map((r) => ({
        id: r.id,
        min_cost: Number(r.min_cost),
        max_cost: r.max_cost !== null ? Number(r.max_cost) : null,
        markup_percent: Number(r.markup_percent),
        active: r.active,
      }))
    } catch {
      rangeRules = []
    }

    // ── Case A: Ad-hoc Single Cost Calculation ───────────────────────────
    if (body.cost !== undefined && body.cost !== null) {
      const rawCost = toNumber(body.cost)
      const result = resolveItemPrice(rawCost, storeContext, rangeRules, null)
      return NextResponse.json({
        store_id: storeId,
        pricing_mode: storeContext.pricing_mode,
        supplier_cost: result.cost,
        selling_price: result.sellingPrice,
        source: result.source,
        applied_markup: result.appliedMarkup,
        matched_rule_id: result.matchedRuleId,
      })
    }

    // ── Case B: Product & Variations Calculation ─────────────────────────
    const productId = parseInt(body.product_id, 10)
    if (!productId || Number.isNaN(productId)) {
      return NextResponse.json({ error: 'Provide either a numeric "cost" or a "product_id" in the request body.' }, { status: 400 })
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

    // Fetch product override for this store
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
    const parentCalc = resolveItemPrice(parentCost, storeContext, rangeRules, productOverride)

    // Variations
    const varRes = await db.query(
      `SELECT id, sku, price, regular_price, sale_price, size, color
       FROM product_variations
       WHERE product_id = $1
       ORDER BY created_at ASC`,
      [productId]
    )

    const variationsPreview = varRes.rows.map((v) => {
      const varCost = resolveCostPrice(v)
      const varCalc = resolveItemPrice(varCost, storeContext, rangeRules, productOverride)
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
      pricing_mode: storeContext.pricing_mode,
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