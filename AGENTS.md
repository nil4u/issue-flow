# Issue Flow Agent Instructions

## Commit Messages

- All commits must use Conventional Commits format.
- Use `type(scope): subject` when a scope adds clarity, otherwise `type: subject`.
- Prefer these types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`.
- Keep the subject concise, imperative, and lower-case unless naming a proper noun.
- Structural changes without behavior changes must use `chore:` or `refactor:` so release automation does not infer a product change.

## Database Migrations

- Do not modify existing Prisma migration files during development. Treat applied migrations as append-only history; schema changes must be made by adding a new migration.
