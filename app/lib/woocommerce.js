const axios = require('axios')

class WooCommerceClient {
  constructor(storeUrl, consumerKey, consumerSecret) {
    this.baseURL = storeUrl.endsWith('/') ? storeUrl : `${storeUrl}/`
    this.consumerKey = consumerKey
    this.consumerSecret = consumerSecret

    // Create axios instance with basic auth
    this.client = axios.create({
      baseURL: `${this.baseURL}wp-json/wc/v3/`,
      auth: {
        username: consumerKey,
        password: consumerSecret,
      },
      timeout: 30000,
    })
  }

  async createProduct(productData) {
    try {
      const response = await this.client.post('products', productData)
      return response.data
    } catch (error) {
      console.error('Error creating product:', error.response?.data || error.message)
      throw error
    }
  }

  async updateProduct(productId, productData) {
    try {
      const response = await this.client.put(`products/${productId}`, productData)
      return response.data
    } catch (error) {
      console.error('Error updating product:', error.response?.data || error.message)
      throw error
    }
  }

  async createVariation(productId, variationData) {
    try {
      const response = await this.client.post(`products/${productId}/variations`, variationData)
      return response.data
    } catch (error) {
      console.error('Error creating variation:', error.response?.data || error.message)
      throw error
    }
  }

  async updateVariation(productId, variationId, variationData) {
    try {
      const response = await this.client.put(
        `products/${productId}/variations/${variationId}`,
        variationData
      )
      return response.data
    } catch (error) {
      console.error('Error updating variation:', error.response?.data || error.message)
      throw error
    }
  }

  async getOrders(params = {}) {
    try {
      const response = await this.client.get('orders', { params })
      return response.data
    } catch (error) {
      console.error('Error fetching orders:', error.response?.data || error.message)
      throw error
    }
  }

  async getOrder(orderId) {
    try {
      const response = await this.client.get(`orders/${orderId}`)
      return response.data
    } catch (error) {
      console.error('Error fetching order:', error.response?.data || error.message)
      throw error
    }
  }

  async updateOrder(orderId, orderData) {
    try {
      const response = await this.client.put(`orders/${orderId}`, orderData)
      return response.data
    } catch (error) {
      console.error('Error updating order:', error.response?.data || error.message)
      throw error
    }
  }

  async testConnection() {
    try {
      // Test connection by fetching products with limit 1
      // This is a lightweight way to verify credentials work
      const response = await this.client.get('products', { params: { per_page: 1 } })
      return { success: true, data: { message: 'Connection successful', products_count: response.headers['x-wp-total'] || 'N/A' } }
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.message || error.message || 'Failed to connect to WooCommerce',
      }
    }
  }
}

module.exports = WooCommerceClient






