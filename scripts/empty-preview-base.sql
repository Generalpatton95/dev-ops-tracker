-- T-7 (REQ-6): empties the Neon `preview-base` branch, once, by hand, and marks it.
--
-- What it's for: `preview-base` is a schema-only branch of `main` and the Neon project's default
-- branch, so every preview database is branched from it. A schema-only copy keeps the tables
-- but not drizzle's migration history, so a preview's migrate step would fail on it. This script
-- leaves `preview-base` with no tables, views, sequences or types in `public` and no `drizzle`
-- schema, so each preview migrates from scratch and is then seeded with fake data
-- (scripts/seed-preview.mjs).
--
-- The marker: it ends by setting the comment 'dot-preview-base' on the public schema. Every
-- branch made from `preview-base` inherits it, and the preview migrate and seed steps refuse to
-- run on a database without it (scripts/preview-base-lib.mjs). `main` must never have it.
--
-- Where to run it: Neon console -> SQL Editor, with the `preview-base` branch selected, as the
-- same role you will pick in the Neon Vercel integration (normally `neondb_owner`). Never on
-- `main`.
--
-- Safety: it is ONE statement (a DO block), so any error aborts all of it. It first checks for
-- signs of a real database and stops, changing nothing, if it finds any: migration history
-- in drizzle.__drizzle_migrations, rows in public."user" or public.workspace, or rows in any
-- other table in the public or drizzle schemas. Run on `main` by mistake, it MUST fail at that
-- check, since `main` has migration history.
--
-- What it keeps: the public schema itself, with its owner and grants (including any Neon set),
-- and anything that belongs to an extension. Only our own objects inside it are dropped.
DO $$
DECLARE
  found_rows boolean;
  t record;
BEGIN
  -- ---------- Guard: nothing below runs unless every check passes ----------

  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations)' INTO found_rows;
    IF found_rows THEN
      RAISE EXCEPTION 'migration history found: this is not the schema-only preview-base branch; nothing was changed';
    END IF;
  END IF;

  IF to_regclass('public."user"') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public."user")' INTO found_rows;
    IF found_rows THEN
      RAISE EXCEPTION 'rows found in public."user": this is not the schema-only preview-base branch; nothing was changed';
    END IF;
  END IF;

  IF to_regclass('public.workspace') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.workspace)' INTO found_rows;
    IF found_rows THEN
      RAISE EXCEPTION 'rows found in public.workspace: this is not the schema-only preview-base branch; nothing was changed';
    END IF;
  END IF;

  -- A schema-only branch has no rows anywhere, so rows in any other table also stop the script.
  FOR t IN
    SELECT schemaname, tablename FROM pg_catalog.pg_tables
    WHERE schemaname IN ('public', 'drizzle')
    ORDER BY schemaname, tablename
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', t.schemaname, t.tablename)
      INTO found_rows;
    IF found_rows THEN
      RAISE EXCEPTION 'rows found in %.%: this is not the schema-only preview-base branch; nothing was changed',
        quote_ident(t.schemaname), quote_ident(t.tablename);
    END IF;
  END LOOP;

  -- ---------- Empty the branch ----------

  DROP SCHEMA IF EXISTS drizzle CASCADE;

  -- Views, materialized views, tables, foreign tables and sequences in public, except those that
  -- belong to an extension. IF EXISTS because CASCADE may already have dropped one (a view on a
  -- table, a sequence a column owns).
  FOR t IN
    SELECT c.relname, c.relkind FROM pg_catalog.pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('v', 'm', 'r', 'p', 'f', 'S')
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
      )
    ORDER BY array_position(ARRAY['v', 'm', 'r', 'p', 'f', 'S']::"char"[], c.relkind), c.relname
  LOOP
    EXECUTE format(
      'DROP %s IF EXISTS public.%I CASCADE',
      CASE t.relkind
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'f' THEN 'FOREIGN TABLE'
        WHEN 'S' THEN 'SEQUENCE'
        ELSE 'TABLE'
      END,
      t.relname);
  END LOOP;

  -- Types in public: enums (our migration makes six), domains, ranges and standalone composite
  -- types. Skipped: types that belong to an extension, array types (dropped with their element
  -- type), multiranges (dropped with their range) and the row types of tables.
  FOR t IN
    SELECT ty.typname, ty.typtype FROM pg_catalog.pg_type ty
    WHERE ty.typnamespace = 'public'::regnamespace
      AND ty.typtype IN ('e', 'd', 'r', 'c')
      AND ty.typcategory <> 'A'
      AND (ty.typrelid = 0
           OR (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = ty.typrelid) = 'c')
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_type'::regclass AND d.objid = ty.oid AND d.deptype = 'e'
      )
    ORDER BY ty.typname
  LOOP
    EXECUTE format(
      'DROP %s IF EXISTS public.%I CASCADE',
      CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END,
      t.typname);
  END LOOP;

  -- ---------- Mark the branch (see "The marker" above) ----------

  COMMENT ON SCHEMA public IS 'dot-preview-base';

  RAISE NOTICE 'preview-base emptied and marked: nothing of ours left in public, drizzle schema dropped';
END
$$;
