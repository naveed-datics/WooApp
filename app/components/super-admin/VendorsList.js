'use client'

import Link from 'next/link'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { vendorQueries } from '@/app/lib/api/query-functions'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/app/components/ui/table'
import { Button } from '@/app/components/ui/button'
import { Badge } from '@/app/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card'
import { Package, Edit, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'

export default function VendorsList({ vendors }) {
  const queryClient = useQueryClient()
  const router = useRouter()

  const deleteMutation = useMutation({
    mutationFn: vendorQueries.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vendors'] })
      router.refresh()
    },
  })

  const formatDate = (date) => {
    if (!date) return 'Never'
    return new Date(date).toLocaleString()
  }

  const getStatusBadge = (status) => {
    const variants = {
      active: 'success',
      inactive: 'secondary',
    }
    return (
      <Badge variant={variants[status] || 'secondary'}>
        {status}
      </Badge>
    )
  }

  const handleDelete = (id, name) => {
    if (confirm(`Are you sure you want to delete "${name}"?`)) {
      deleteMutation.mutate(id)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center space-x-2">
              <Package className="h-5 w-5" />
              <span>Vendors</span>
            </CardTitle>
            <CardDescription>
              Manage your vendors
            </CardDescription>
          </div>
          <Button asChild>
            <Link href="/super-admin/vendors/new">
              Add New Vendor
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {vendors.length === 0 ? (
          <div className="text-center py-12">
            <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No vendors found. Create your first vendor to get started.</p>
            <Button asChild className="mt-4">
              <Link href="/super-admin/vendors/new">Add New Vendor</Link>
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Contact Info</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendors.map((vendor) => (
                <TableRow key={vendor.id}>
                  <TableCell className="font-medium">{vendor.name}</TableCell>
                  <TableCell>{vendor.email || '-'}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {vendor.contact_info || '-'}
                  </TableCell>
                  <TableCell>{getStatusBadge(vendor.status)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(vendor.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end space-x-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        asChild
                      >
                        <Link href={`/super-admin/vendors/${vendor.id}`}>
                          <Edit className="h-4 w-4 mr-1" />
                          Edit
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(vendor.id, vendor.name)}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4 mr-1 text-destructive" />
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
