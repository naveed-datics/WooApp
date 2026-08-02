/**
 * Smoke test: fetch Ralawise catalog via env URL or Playwright login download.
 *
 * Usage:
 *   node scripts/ralawise-resolve-urls-smoke.js
 *   node scripts/ralawise-resolve-urls-smoke.js --force-scrape
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env.local') })
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const { fetchRalawiseCatalog, parseCSV } = (() => {
  const client = require('../app/lib/ralawise-client')
  const { parseCSV } = require('../app/lib/csv-parser')
  return { ...client, parseCSV }
})()

async function main() {
  const forcePlaywright = process.argv.includes('--force-scrape')
  console.log(
    forcePlaywright
      ? 'Fetching catalog via Playwright login…'
      : 'Fetching catalog (env URL, Playwright fallback)…'
  )

  const catalog = await fetchRalawiseCatalog({ forcePlaywright })
  console.log('Source:', catalog.source)
  console.log('Work dir:', catalog.workDir)

  const products = await parseCSV(catalog.parentCsvText)
  const variations = await parseCSV(catalog.variationsCsvText)
  console.log('Product rows:', products.length)
  console.log('Variation rows:', variations.length)

  if (!products.length || !variations.length) {
    throw new Error('Downloaded CSVs are empty')
  }
  if (!products[0].sku && !products[0].post_title) {
    throw new Error('Parent CSV missing expected columns')
  }
  if (!variations[0].parent_sku) {
    throw new Error('Variations CSV missing parent_sku')
  }

  console.log('Resolve/download smoke test OK')
}

main().catch((err) => {
  console.error('Resolve/download smoke FAILED:', err.message)
  process.exit(1)
})
