CREATE TABLE IF NOT EXISTS public.webhook_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_name TEXT,
    event TEXT,
    payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);
ALTER TABLE public.webhook_logs DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.webhook_logs TO anon, authenticated, service_role;
