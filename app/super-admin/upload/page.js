import Link from 'next/link'
import { requireSuperAdmin } from '../../lib/auth'
import db from '../../lib/db'
import { Button } from '@/app/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/app/components/ui/card'
import { Upload, ShoppingBag, Layers } from 'lucide-react'

export default async function UploadProductsPage() {
  await requireSuperAdmin()

  const result = await db.query(
    'SELECT id, name, store_url, status FROM stores ORDER BY name ASC'
  )
  const stores = result.rows

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Upload Catalog</h1>
        <p className="text-gray-600 mt-1">
          Choose a store, then upload products or variations as separate CSV files.
        </p>
      </div>

      {stores.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No stores yet</CardTitle>
            <CardDescription>
              Create a store before uploading products.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/super-admin/stores/new">Add New Store</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {stores.map((store) => (
            <Card key={store.id}>
              <CardHeader>
                <CardTitle className="text-lg">{store.name}</CardTitle>
                <CardDescription className="truncate">{store.store_url}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <Button asChild>
                  <Link href={`/admin/store/${store.id}/import?type=products`}>
                    <Upload className="h-4 w-4 mr-2" />
                    Upload Products
                  </Link>
                </Button>
                <Button variant="secondary" asChild>
                  <Link href={`/admin/store/${store.id}/import?type=variations`}>
                    <Layers className="h-4 w-4 mr-2" />
                    Upload Variations
                  </Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link href={`/admin/store/${store.id}/products`}>
                    <ShoppingBag className="h-4 w-4 mr-2" />
                    Review Products
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
