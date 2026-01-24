import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '../../lib/auth'
import db from '../../lib/db'

export async function GET() {
  try {
    await requireSuperAdmin()
    
    const result = await db.query(
      'SELECT id, name, store_url, status, last_sync_at, created_at FROM stores ORDER BY created_at DESC'
    )
    
    return NextResponse.json(result.rows)
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 401 }
    )
  }
}

export async function POST(request) {
  try {
    await requireSuperAdmin()
    
    const body = await request.json()
    const { name, store_url, consumer_key, consumer_secret, status } = body

    if (!name || !store_url || !consumer_key || !consumer_secret) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    const result = await db.query(
      `INSERT INTO stores (name, store_url, consumer_key, consumer_secret, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, store_url, status, created_at`,
      [name, store_url, consumer_key, consumer_secret, status || 'active']
    )

    return NextResponse.json(result.rows[0], { status: 201 })
  } catch (error) {
    console.error('Error creating store:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}






