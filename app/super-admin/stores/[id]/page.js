import { requireSuperAdmin } from '../../../lib/auth'
import db from '../../../lib/db'
import StoreForm from '../../../components/super-admin/StoreForm'
import { Button } from '@/app/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/app/components/ui/card'

export default async function EditStorePage({ params }) {
  await requireSuperAdmin()
  const { id } = await params

  const result = await db.query(
    'SELECT id, name, store_url, consumer_key, consumer_secret, status FROM stores WHERE id = $1',
    [id]
  )

  if (result.rows.length === 0) {
    return (
      <div className="container mx-auto py-12">
        <Card className="max-w-md mx-auto">
          <CardHeader>
            <CardTitle>Store not found</CardTitle>
            <CardDescription>The store you're looking for doesn't exist.</CardDescription>
          </CardHeader>
          <CardContent>
            <a href="/super-admin/stores">
              <Button variant="outline">Back to Stores</Button>
            </a>
          </CardContent>
        </Card>
      </div>
    )
  }

  const store = result.rows[0]

  return (
    <div className="container mx-auto py-6 space-y-6">
      <h1 className="text-3xl font-bold">Edit Store</h1>
      <StoreForm store={store} />
    </div>
  )
}


