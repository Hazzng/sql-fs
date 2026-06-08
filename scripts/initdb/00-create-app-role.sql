-- Provision the sql-fs application role for local dev / integration tests.
--
-- This directory is mounted into /docker-entrypoint-initdb.d by
-- docker-compose.local.yml, so every *.sql here runs ONCE, as the bootstrap
-- superuser, on first Postgres container start.
--
-- WHY A NON-SUPERUSER OWNER ROLE — do NOT "simplify" this to the default
-- `postgres` superuser:
--   * Migration 0005 enables FORCE ROW LEVEL SECURITY on inodes/dirents/sandboxes.
--     A superuser has BYPASSRLS and SILENTLY bypasses the policy, so the RLS
--     isolation suite (rls.integration.test.ts) fails with confusing errors —
--     under "sandbox A's context" the queries return rows from every sandbox.
--   * The role must OWN the database and the public schema: the migration runner
--     CREATEs objects in `public`, and the RLS suite re-applies 0005's
--     `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, which requires table ownership
--     (a non-owner fails with `must be owner of table inodes`).
--   * CREATEDB is required because some integration suites (multi-tenant routing,
--     migrations) create ephemeral databases at runtime from DATABASE_URL.
--
-- Point DATABASE_URL at this role, NOT at the bootstrap `postgres` superuser:
--   DATABASE_URL=postgres://sqlfs_app:sqlfs_app@localhost:5432/sqlfs

CREATE ROLE sqlfs_app LOGIN PASSWORD 'sqlfs_app' NOSUPERUSER NOBYPASSRLS CREATEDB;
CREATE DATABASE sqlfs OWNER sqlfs_app;

-- PG15+ no longer grants CREATE on `public` to non-owners by default, so the
-- migration runner cannot create tables until the app role owns the schema.
\connect sqlfs
ALTER SCHEMA public OWNER TO sqlfs_app;
