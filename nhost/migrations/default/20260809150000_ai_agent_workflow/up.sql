CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  quota_allowed integer NOT NULL DEFAULT 100 CHECK (quota_allowed >= 0),
  quota_used integer NOT NULL DEFAULT 0 CHECK (quota_used >= 0),
  quota_reserved integer NOT NULL DEFAULT 0 CHECK (quota_reserved >= 0),
  quota_period_start date NOT NULL DEFAULT date_trunc('month', now())::date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.org_members (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE public.workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  type text NOT NULL CHECK (type IN (
    'llm_call', 'http_request', 'db_write', 'notify',
    'conditional_branch', 'approval_gate'
  )),
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, position)
);

CREATE TABLE public.workflow_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('manual', 'webhook', 'scheduled', 'database_event')),
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, type)
);

CREATE TABLE public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed')),
  trigger_type text NOT NULL CHECK (trigger_type IN ('manual', 'webhook', 'scheduled', 'database_event')),
  triggered_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  trigger_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_position integer NOT NULL DEFAULT 0 CHECK (current_position >= 0),
  quota_reserved boolean NOT NULL DEFAULT true,
  dedupe_key text UNIQUE,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.step_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id uuid REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
  position integer NOT NULL CHECK (position >= 0),
  step_type text NOT NULL,
  step_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'awaiting_approval', 'completed', 'failed', 'skipped')),
  input jsonb,
  output jsonb,
  error text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, position)
);

CREATE TABLE public.run_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT 'start',
  processed boolean NOT NULL DEFAULT false,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id uuid REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.workflow_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.db_write_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id uuid REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_org_members_user ON public.org_members(user_id);
CREATE INDEX idx_workflows_org ON public.workflows(org_id);
CREATE INDEX idx_steps_workflow_position ON public.workflow_steps(workflow_id, position);
CREATE INDEX idx_runs_workflow_created ON public.workflow_runs(workflow_id, created_at DESC);
CREATE INDEX idx_runs_org_created ON public.workflow_runs(org_id, created_at DESC);
CREATE INDEX idx_step_runs_run_position ON public.step_runs(workflow_run_id, position);
CREATE INDEX idx_run_jobs_unprocessed ON public.run_jobs(processed, created_at);
CREATE INDEX idx_notifications_status ON public.notification_outbox(status, created_at);
CREATE INDEX idx_inbox_workflow ON public.workflow_inbox(workflow_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_organizations_updated_at BEFORE UPDATE ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_workflows_updated_at BEFORE UPDATE ON public.workflows
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_workflow_steps_updated_at BEFORE UPDATE ON public.workflow_steps
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_workflow_triggers_updated_at BEFORE UPDATE ON public.workflow_triggers
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_workflow_runs_updated_at BEFORE UPDATE ON public.workflow_runs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_step_runs_updated_at BEFORE UPDATE ON public.step_runs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_notification_outbox_updated_at BEFORE UPDATE ON public.notification_outbox
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Atomic quota reservation. Only tracked for admin/server-side use in metadata.
CREATE OR REPLACE FUNCTION public.reserve_org_quota(p_org_id uuid)
RETURNS SETOF public.organizations
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  current_period date := date_trunc('month', now())::date;
BEGIN
  -- Lock the organization so simultaneous run starts cannot race the quota check.
  PERFORM 1 FROM public.organizations WHERE id = p_org_id FOR UPDATE;

  UPDATE public.organizations
     SET quota_used = CASE WHEN quota_period_start < current_period THEN 0 ELSE quota_used END,
         quota_reserved = CASE WHEN quota_period_start < current_period THEN 0 ELSE quota_reserved END,
         quota_period_start = CASE WHEN quota_period_start < current_period THEN current_period ELSE quota_period_start END
   WHERE id = p_org_id;

  RETURN QUERY
  UPDATE public.organizations
     SET quota_reserved = quota_reserved + 1
   WHERE id = p_org_id
     AND (quota_used + quota_reserved) < quota_allowed
  RETURNING *;
END;
$$;

-- Atomically release the reservation and optionally count completed usage.
CREATE OR REPLACE FUNCTION public.finish_workflow_run(
  p_run_id uuid,
  p_status text,
  p_error text DEFAULT NULL
)
RETURNS SETOF public.workflow_runs
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  r public.workflow_runs%ROWTYPE;
BEGIN
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'finish_workflow_run only accepts completed or failed';
  END IF;

  SELECT * INTO r
  FROM public.workflow_runs
  WHERE id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF r.status IN ('completed', 'failed') THEN
    RETURN QUERY SELECT * FROM public.workflow_runs WHERE id = p_run_id;
    RETURN;
  END IF;

  IF r.quota_reserved THEN
    UPDATE public.organizations
       SET quota_reserved = GREATEST(quota_reserved - 1, 0),
           quota_used = quota_used + CASE WHEN p_status = 'completed' THEN 1 ELSE 0 END
     WHERE id = r.org_id;
  END IF;

  UPDATE public.workflow_runs
     SET status = p_status,
         error = p_error,
         quota_reserved = false,
         finished_at = now()
   WHERE id = p_run_id;

  RETURN QUERY SELECT * FROM public.workflow_runs WHERE id = p_run_id;
END;
$$;

CREATE OR REPLACE VIEW public.org_monthly_usage AS
SELECT
  o.id AS org_id,
  o.name AS org_name,
  date_trunc('month', now())::date AS month,
  o.quota_allowed,
  o.quota_used,
  o.quota_reserved,
  COUNT(r.id) FILTER (WHERE r.status = 'completed' AND r.finished_at >= date_trunc('month', now())) AS completed_runs_this_month,
  AVG(EXTRACT(EPOCH FROM (r.finished_at - r.started_at))) FILTER (
    WHERE r.status = 'completed' AND r.started_at IS NOT NULL AND r.finished_at IS NOT NULL
  ) AS avg_run_duration_seconds
FROM public.organizations o
LEFT JOIN public.workflow_runs r ON r.org_id = o.id
GROUP BY o.id, o.name, o.quota_allowed, o.quota_used, o.quota_reserved;
