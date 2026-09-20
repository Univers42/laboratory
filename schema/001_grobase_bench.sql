-- Laboratory · grobase bench schema. Idempotent; apply from the VM owner:
--   make -C /goinfre/dlesieur/born2root sql FILE=$PWD/schema/001_grobase_bench.sql B2B_CONFIG=profiles/server.toml
-- Two tables the probes share: a dish (private unless is_public) and the
-- notes pinned on it. RLS is the point: culture B must not read culture A's
-- private dish, and the realtime probe watches lab_notes. grobase's event
-- trigger (migration 012) attaches realtime_notify() to any new public
-- table; realtime_ensure_trigger() below makes that explicit.
BEGIN;

CREATE TABLE IF NOT EXISTS public.lab_dishes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    owner      uuid NOT NULL DEFAULT auth.uid(),
    is_public  boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.lab_notes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dish_id    uuid NOT NULL REFERENCES public.lab_dishes(id) ON DELETE CASCADE,
    author     uuid NOT NULL DEFAULT auth.uid(),
    body       text NOT NULL,
    pos        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lab_notes_dish_idx ON public.lab_notes (dish_id, created_at);

ALTER TABLE public.lab_dishes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lab_notes  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lab_dishes_select ON public.lab_dishes;
CREATE POLICY lab_dishes_select ON public.lab_dishes FOR SELECT
    USING (is_public OR owner = auth.uid());
DROP POLICY IF EXISTS lab_dishes_insert ON public.lab_dishes;
CREATE POLICY lab_dishes_insert ON public.lab_dishes FOR INSERT
    WITH CHECK (owner = auth.uid());
DROP POLICY IF EXISTS lab_dishes_update ON public.lab_dishes;
CREATE POLICY lab_dishes_update ON public.lab_dishes FOR UPDATE
    USING (owner = auth.uid());
DROP POLICY IF EXISTS lab_dishes_delete ON public.lab_dishes;
CREATE POLICY lab_dishes_delete ON public.lab_dishes FOR DELETE
    USING (owner = auth.uid());

DROP POLICY IF EXISTS lab_notes_select ON public.lab_notes;
CREATE POLICY lab_notes_select ON public.lab_notes FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.lab_dishes d
                   WHERE d.id = dish_id AND (d.is_public OR d.owner = auth.uid())));
DROP POLICY IF EXISTS lab_notes_insert ON public.lab_notes;
CREATE POLICY lab_notes_insert ON public.lab_notes FOR INSERT
    WITH CHECK (author = auth.uid()
                AND EXISTS (SELECT 1 FROM public.lab_dishes d
                            WHERE d.id = dish_id AND (d.is_public OR d.owner = auth.uid())));
DROP POLICY IF EXISTS lab_notes_update ON public.lab_notes;
CREATE POLICY lab_notes_update ON public.lab_notes FOR UPDATE
    USING (author = auth.uid());
DROP POLICY IF EXISTS lab_notes_delete ON public.lab_notes;
CREATE POLICY lab_notes_delete ON public.lab_notes FOR DELETE
    USING (author = auth.uid());

GRANT SELECT ON public.lab_dishes, public.lab_notes TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lab_dishes, public.lab_notes TO authenticated;

-- rpc: who am I, as the database sees it (the auth probe's last word)
CREATE OR REPLACE FUNCTION public.lab_ping() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'now',  now(),
        'role', current_setting('request.jwt.claims', true)::jsonb ->> 'role',
        'uid',  auth.uid())
$$;
GRANT EXECUTE ON FUNCTION public.lab_ping() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.lab_note_count(dish uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
    SELECT count(*) FROM public.lab_notes WHERE dish_id = dish
$$;
GRANT EXECUTE ON FUNCTION public.lab_note_count(uuid) TO anon, authenticated;

SELECT public.realtime_ensure_trigger('public', 'lab_dishes');
SELECT public.realtime_ensure_trigger('public', 'lab_notes');

COMMIT;
NOTIFY pgrst, 'reload schema';
