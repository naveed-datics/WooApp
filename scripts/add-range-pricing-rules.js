// Migration: adds range-based pricing rules and per-product overrides.
// - stores.pricing_mode (defaults to 'legacy_markup' for 100% backward compatibility)
// - stores.fallback_markup_percent
// - store_pricing_rules table (normalized price bands)
// - product_store_pricing table (per-product / per-store overrides)
//
// Safe to re-run: fully idempotent.
// Run with: node scripts/add-range-pricing-rules.js
//   or:     npm run migrate:range-pricing

const { Pool } = require('pg')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env.local') })
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
})

async function run() {
  const client = await pool.connect()
  try {
    console.log('Beginning range pricing rules schema migration...')

    // 1. Add pricing columns to stores table
    await client.query(`
      ALTER TABLE stores
        ADD COLUMN IF NOT EXISTS pricing_mode VARCHAR(50) NOT NULL DEFAULT 'legacy_markup',
        ADD COLUMN IF NOT EXISTS fallback_markup_percent DECIMAL(6, 2) DEFAULT NULL;
    `)

    // Ensure pricing_mode check constraint exists
    await client.query(`
      DO $$
      BEGIN
        ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_pricing_mode_check;
        ALTER TABLE stores ADD CONSTRAINT stores_pricing_mode_check
          CHECK (pricing_mode IN ('legacy_markup', 'range_rules'));
      EXCEPTION
        WHEN OTHERS THEN NULL;
      END $$;
    `)

    // 2. Create store_pricing_rules table
    await client.query(`
      CREATE TABLE IF NOT EXISTS store_pricing_rules (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        min_cost DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        max_cost DECIMAL(10, 2) DEFAULT NULL,
        markup_percent DECIMAL(6, 2) NOT NULL CHECK (markup_percent >= 0),
        sort_order INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_store_pricing_rules_store_active
        ON store_pricing_rules(store_id, active, min_cost);
    `)

    // 3. Create product_store_pricing table
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_store_pricing (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        override_type VARCHAR(50) NOT NULL DEFAULT 'store_rules'
          CHECK (override_type IN ('store_rules', 'custom_markup', 'fixed_price')),
        custom_markup_percent DECIMAL(6, 2) DEFAULT NULL CHECK (custom_markup_percent IS NULL OR custom_markup_percent >= 0),
        fixed_price DECIMAL(10, 2) DEFAULT NULL CHECK (fixed_price IS NULL OR fixed_price >= 0),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(store_id, product_id)
      );
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_product_store_pricing_lookup
        ON product_store_pricing(store_id, product_id);
    `)

    console.log('Range pricing migration completed successfully.')
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
