import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '../../../lib/auth'
import db from '../../../lib/db'

export async function GET(request, { params }) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    
    const result = await db.query(
      'SELECT id, name, store_url, consumer_key, consumer_secret, status FROM stores WHERE id = $1',
      [id]
    )
    
    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Store not found' },
        { status: 404 }
      )
    }
    
    return NextResponse.json(result.rows[0])
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 401 }
    )
  }
}

export async function PUT(request, { params }) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    
    const body = await request.json()
    const { name, store_url, consumer_key, consumer_secret, status } = body

    if (!name || !store_url || !consumer_key || !consumer_secret) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    const result = await db.query(
      `UPDATE stores 
       SET name = $1, store_url = $2, consumer_key = $3, consumer_secret = $4, status = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING id, name, store_url, status, updated_at`,
      [name, store_url, consumer_key, consumer_secret, status || 'active', id]
    )

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Store not found' },
        { status: 404 }
      )
    }

    return NextResponse.json(result.rows[0])
  } catch (error) {
    console.error('Error updating store:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}

export async function DELETE(request, { params }) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    
    const result = await db.query(
      'DELETE FROM stores WHERE id = $1 RETURNING id',
      [id]
    )

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Store not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ message: 'Store deleted successfully' })
  } catch (error) {
    console.error('Error deleting store:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}




