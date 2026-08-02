import { NextResponse, after } from 'next/server'
import db from '../../../lib/db'
import { auth } from '../../auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '../../../lib/role-guards'
import { runRalawiseImport } from '../../../lib/ralawise-import'
import {
  JOB_STATUS,
  createSyncJob,
  updateSyncJob,
  makeJobProgressUpdater,
} from '../../../lib/ralawise-sync-jobs'

export const maxDuration = 300
export const runtime = 'nodejs'

export async function POST(request) {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const body = await request.json().catch(() => ({}))
    const storeId = parseInt(body.store_id, 10)
    const vendorId = parseInt(
      body.vendor_id ?? process.env.RALAWISE_DEFAULT_VENDOR_ID,
      10
    )

    if (!storeId || Number.isNaN(storeId)) {
      return NextResponse.json({ error: 'store_id is required' }, { status: 400 })
    }
    if (!vendorId || Number.isNaN(vendorId)) {
      return NextResponse.json(
        { error: 'vendor_id is required (or set RALAWISE_DEFAULT_VENDOR_ID)' },
        { status: 400 }
      )
    }

    if (session.user.role === 'admin') {
      const hasAccess = await verifyAdminStoreAccess(db, session.user.id, storeId)
      if (!hasAccess) {
        return NextResponse.json(
          { error: 'Unauthorized access to this store' },
          { status: 403 }
        )
      }
    }

    const storeCheck = await db.query('SELECT id FROM stores WHERE id = $1', [storeId])
    if (storeCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const vendorCheck = await db.query(
      `SELECT id FROM vendors WHERE id = $1 AND status = 'active'`,
      [vendorId]
    )
    if (vendorCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Vendor not found or inactive' }, { status: 404 })
    }

    const job = await createSyncJob(db, {
      storeId,
      vendorId,
      userId: session.user.id,
    })

    after(async () => {
      const onProgress = makeJobProgressUpdater(db, job.id)
      try {
        await updateSyncJob(db, job.id, {
          status: JOB_STATUS.CONNECTING,
          step: JOB_STATUS.CONNECTING,
          message: 'Starting Ralawise sync…',
          started_at: new Date(),
        })

        const result = await runRalawiseImport({
          storeId,
          vendorId,
          userId: session.user.id,
          db,
          onProgress,
        })

        await updateSyncJob(db, job.id, {
          status: JOB_STATUS.COMPLETED,
          step: JOB_STATUS.COMPLETED,
          message: result.no_changes
            ? 'No changes since last import'
            : 'Ralawise sync complete',
          current_count:
            (result.products?.processed ?? 0) + (result.variations?.processed ?? 0),
          total_count:
            (result.products?.totalRows ?? 0) + (result.variations?.totalRows ?? 0),
          products_new: result.products?.new ?? 0,
          products_updated: result.products?.updated ?? 0,
          products_skipped: result.products?.skipped ?? 0,
          products_errors: result.products?.errorCount ?? 0,
          variations_new: result.variations?.new ?? 0,
          variations_updated: result.variations?.updated ?? 0,
          variations_skipped: result.variations?.skipped ?? 0,
          variations_errors: result.variations?.errorCount ?? 0,
          result_json: result,
          completed_at: new Date(),
          error_message: null,
        })
      } catch (error) {
        console.error('Ralawise sync job failed:', error)
        await updateSyncJob(db, job.id, {
          status: JOB_STATUS.FAILED,
          message: error.message || 'Ralawise sync failed',
          error_message: error.message || 'Ralawise sync failed',
          completed_at: new Date(),
        })
      }
    })

    return NextResponse.json({
      jobId: job.id,
      status: JOB_STATUS.QUEUED,
    })
  } catch (error) {
    console.error('Ralawise sync failed to start:', error)
    return NextResponse.json(
      { error: error.message || 'Ralawise sync failed' },
      { status: 500 }
    )
  }
}
