const Papa = require('papaparse')

async function parseCSV(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => {
        // Normalize header names - convert to lowercase and remove spaces
        return header.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
      },
      complete: (results) => {
        resolve(results.data)
      },
      error: (error) => {
        reject(error)
      },
    })
  })
}

// Map common column name variations to standard names
function normalizeColumnName(key) {
  if (!key) return key
  
  const normalized = key.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  
  // Map common variations
  const columnMap = {
    'product_name': 'name',
    'name': 'name',
    'title': 'name',
    'product_title': 'name',
    'productname': 'name',
    'product_title': 'name',
    'sku': 'sku',
    'product_sku': 'sku',
    'productsku': 'sku',
  }
  
  return columnMap[normalized] || normalized
}

function validateProductRow(row, rowIndex) {
  const errors = []
  
  // Headers are already normalized by transformHeader, so check normalized keys
  // Common normalized column names: "name", "product_name", "title", "product_title", "post_title"
  const nameValue = row.name || row.product_name || row.title || row.product_title || row.post_title
  
  if (!nameValue || String(nameValue).trim() === '') {
    const availableColumns = Object.keys(row).join(', ')
    errors.push(`Row ${rowIndex + 1}: Product name is required. Available columns: ${availableColumns}`)
  }

  // Common normalized column names: "sku", "product_sku"
  const skuValue = row.sku || row.product_sku
  
  if (!skuValue || String(skuValue).trim() === '') {
    const availableColumns = Object.keys(row).join(', ')
    errors.push(`Row ${rowIndex + 1}: SKU is required. Available columns: ${availableColumns}`)
  }

  // Update row with found values for consistent access
  row.name = nameValue
  row.sku = skuValue

  return errors
}

function validateVariationRow(row, rowIndex) {
  const errors = []
  
  if (!row.parent_sku || row.parent_sku.trim() === '') {
    errors.push(`Row ${rowIndex + 1}: Parent SKU is required`)
  }

  if (!row.sku || row.sku.trim() === '') {
    errors.push(`Row ${rowIndex + 1}: SKU is required`)
  }

  return errors
}

function parseProductRow(row) {
  // Headers are already normalized by transformHeader
  // Get values with fallbacks to common variations
  const nameValue = row.name || row.product_name || row.title || row.product_title || row.post_title || ''
  const skuValue = row.sku || row.product_sku || null
  
  // Map WooCommerce export format to our format
  const description = row.post_content || row.description || null
  const shortDescription = row.post_excerpt || row.short_description || null
  const categories = row.taxproduct_cat || row.categories || null
  
  // Parse attributes from WooCommerce format
  const attributes = []
  if (row.attributecolour) {
    attributes.push(`Colour: ${row.attributecolour}`)
  }
  if (row.attributesize) {
    attributes.push(`Size: ${row.attributesize}`)
  }
  // Add other attributes if needed
  const attributesString = attributes.length > 0 ? attributes.join('; ') : (row.attributes || null)
  
  return {
    sku: skuValue ? String(skuValue).trim() : null,
    name: String(nameValue).trim() || '',
    description: description ? String(description).trim() : null,
    short_description: shortDescription ? String(shortDescription).trim() : null,
    price: row.price ? parseFloat(row.price) : null,
    regular_price: row.regular_price ? parseFloat(row.regular_price) : null,
    sale_price: row.sale_price ? parseFloat(row.sale_price) : null,
    stock_quantity: row.stock_quantity ? parseInt(row.stock_quantity) : null,
    manage_stock: row.manage_stock === 'true' || row.manage_stock === '1' || row.manage_stock === 'yes',
    stock_status: (row.stock_status?.toLowerCase() || 'instock'),
    categories: categories ? String(categories).trim() : null,
    tags: row.tags ? String(row.tags).trim() : null,
    images: row.images ? String(row.images).trim() : null,
    attributes: attributesString ? String(attributesString).trim() : null,
  }
}

function parseVariationRow(row) {
  return {
    parent_sku: row.parent_sku?.trim() || '',
    sku: row.sku?.trim() || '',
    attributes: row.attributes?.trim() || null,
    price: row.price ? parseFloat(row.price) : null,
    regular_price: row.regular_price ? parseFloat(row.regular_price) : null,
    sale_price: row.sale_price ? parseFloat(row.sale_price) : null,
    stock_quantity: row.stock_quantity ? parseInt(row.stock_quantity) : null,
    manage_stock: row.manage_stock === 'true' || row.manage_stock === '1' || row.manage_stock === 'yes',
    stock_status: row.stock_status?.toLowerCase() || 'instock',
    image: row.image?.trim() || null,
  }
}

module.exports = {
  parseCSV,
  validateProductRow,
  validateVariationRow,
  parseProductRow,
  parseVariationRow,
}




