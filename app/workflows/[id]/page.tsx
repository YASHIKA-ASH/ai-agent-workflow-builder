'use client'

import { use } from 'react'
import RequireAuth from '@/components/RequireAuth'
import Header from '@/components/Header'
import WorkflowEditor from '@/components/WorkflowEditor'

export default function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <RequireAuth><Header /><main className="page container"><div className="page-head"><div><p className="eyebrow">BUILDER</p><h1>Edit workflow</h1></div></div><WorkflowEditor workflowId={id} /></main></RequireAuth>
}
