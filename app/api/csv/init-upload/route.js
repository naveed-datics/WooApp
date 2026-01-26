import { NextResponse } from 'next/server'
import db from '../../../lib/db'
import { auth } from '../../auth/[...nextauth]/route'

export const maxDuration = 10
export const runtime = 'nodejs'

export async function POST(request) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { storeId, vendorId, fileType, fileName, totalRows } = body

    if (!storeId || !vendorId || !fileType || !fileName || !totalRows) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    // Check if admin has access to this store
    if (session.user.role !== 'super_admin') {
      const accessCheck = await db.query(
        'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
        [session.user.id, storeId]
      )

      if (accessCheck.rows.length === 0) {
        return NextResponse.json(
          { error: 'Unauthorized access to this store' },
          { status: 403 }
        )
      }
    }

    // Create CSV upload record
    const uploadResult = await db.query(
      `INSERT INTO csv_uploads (store_id, vendor_id, uploaded_by, file_type, file_name, row_count, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'processing')
       RETURNING id`,
      [storeId, vendorId, session.user.id, fileType, fileName, totalRows]
    )

    const csvUploadId = uploadResult.rows[0].id

    return NextResponse.json({
      success: true,
      csvUploadId,
    })
  } catch (error) {
    console.error('Error initializing CSV upload:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to initialize CSV upload' },
      { status: 500 }
    )
  }
}
