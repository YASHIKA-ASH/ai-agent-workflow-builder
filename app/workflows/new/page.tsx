'use client'

import RequireAuth from '@/components/RequireAuth'
import Header from '@/components/Header'
import WorkflowEditor from '@/components/WorkflowEditor'

export default function NewWorkflowPage() {
  return <RequireAuth><Header /><main className="page container"><div className="page-head"><div><p className="eyebrow">BUILDER</p><h1>New workflow</h1></div></div><WorkflowEditor /></main></RequireAuth>
}
