# DisFAP control-plane database

PostgreSQL schema managed with Prisma. The canonical model is
[`schema.prisma`](../schema.prisma); the migration directories below are the
immutable, ordered change history used to bring a database to that model.
Apply reviewed migrations with `npx prisma migrate deploy`. Create a migration
for a schema change with `npx prisma migrate dev --name <description>` against a
disposable development database, then review the generated SQL before merging.

## History

| Migration | What it is |
|---|---|
| `20261016000000_init` | The initial baseline, generated from an **empty** datamodel (`prisma migrate diff --from-empty --to-schema-datamodel`). Creates every table, enum, index and FK in `schema.prisma`, including `sessions.license_id` and `sessions_license_id_state_idx`. |
| `20261016010000_external_identities` | Adds `external_identities` — the `(issuer, subject) → user_id` map for OIDC identities, with a `UNIQUE (issuer, subject)` index and an FK to `users`. Authored with `prisma migrate diff --from-url <baseline> --to-schema-datamodel`. |
| `20261111000000_session_disconnect_lifecycle` | Adds the persisted reconnect deadline, indexes for lifecycle reaper scans, and a unique usage-record-per-session constraint. It fails if historical usage contains duplicate session rows; resolve those explicitly before applying. |
| `20261112000000_license_access_duration` | Adds the nullable per-listing maximum rental duration. Existing listings remain governed by the API's global cap. |

## Fresh database

A brand-new, empty database is the intended target:

```bash
cd services/api
DATABASE_URL=... npx prisma migrate deploy
```

The baseline was validated against a throwaway local PostgreSQL cluster:
`migrate deploy` applied cleanly and `test/prisma-persistence.pg.test.ts`
(env-gated on `DFAP_TEST_DATABASE_URL`) proved `sessions.license_id` persists,
`hasActiveForLicense` tracks session state, and `external_identities` resolves
by `(issuer, subject)` with the unique constraint enforced. Both migrations were
also applied together to a second fresh database to confirm the full set applies
from scratch.

## Baselining an existing database

If a database was already created out-of-band (e.g. with `prisma db push` or by
hand) **before** this migration history existed, do **not** run
`migrate deploy` against it — the baseline's `CREATE TABLE` statements would
collide. Instead, mark the baseline as already applied, *after* verifying the
live schema matches `schema.prisma`:

```bash
cd services/api
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma   # expect: no difference
npx prisma migrate resolve --applied 20261016000000_init
```

`migrate resolve --applied` only records the migration in `_prisma_migrations`;
it changes no data. Never run it against a database whose schema does not
actually match, and never point either command at a database you cannot afford
to lose.

## Safety

- Do not apply this migration to an existing, important, or production database.
- Do not reset or `db push --force` an existing database.
- Back up the target database and apply migrations through the deployment
  runbook during a reviewed release window.
- Treat migrations already applied to any shared database as immutable. Fix a
  mistake with a new forward migration; never delete or rewrite migration
  history to make the directory look cleaner.
- To validate locally, use a disposable cluster (see the commands in
  `HANDOFF.md` §10.2), never the developer's working database.
