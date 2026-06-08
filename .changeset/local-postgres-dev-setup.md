---
"sql-fs-api": patch
---

Fix local Postgres dev setup for the integration test suite (#119).

- Add `docker-compose.local.yml` (Postgres 16 + Redis 7). Its `initdb` script
  (`scripts/initdb/00-create-app-role.sql`) provisions a **non-superuser** `sqlfs_app`
  role that owns the `sqlfs` database — required because migration `0005` enables
  `FORCE ROW LEVEL SECURITY`, which a superuser silently bypasses (the RLS isolation
  tests fail under the default `postgres` superuser). The file was previously
  referenced by the README but `.gitignore`d, so it could never be committed.
- Document the non-superuser-owner requirement and the full local-DB workflow in
  `CONTRIBUTING.md` (new "Local database" section).
- Correct the `DATABASE_DIRECT_URL` row in the README env table: it is optional and
  used only by drizzle-kit (`pnpm db:generate`); the server's boot-time migration
  runner uses `DATABASE_URL`.
- Update `.env.example` defaults to match the compose stack.
- Remove the broken, unused `pnpm db:migrate` script (drizzle-kit `migrate` with no
  journal). Migrations are applied automatically on server boot.
