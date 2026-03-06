# Contributing

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork and install dependencies:

```bash
git clone https://github.com/your-username/harmony.git
cd harmony
npm install
```

3. Set up your local environment (see [Installation](../installation))
4. Create a feature branch:

```bash
git checkout -b feature/your-feature-name
```

## Development Process

### Before Writing Code

- Check existing issues and PRs to avoid duplicate work
- For large features, open an issue first to discuss the approach
- Review the [Architecture](../architecture/) docs to understand the codebase

### Code Style

- Follow the existing Prettier and ESLint configuration
- Use TypeScript for all new code
- Prefer Composition API (`<script setup>`) for Vue components
- Keep components focused; extract shared logic into composables or services
- Use the `services` facade for database access, never call Supabase directly from components

### Key Conventions

- **Services**: Business logic goes in `src/services/`, not in components or stores
- **Stores**: Pinia stores manage reactive state and call services
- **Permissions**: Use `bigint` bitmasks (see `permissionsService.ts`)
- **Encryption**: Thread messages bypass encryption; DMs and channel messages respect the server's encryption mode
- **Database**: Wrap migrations in `BEGIN;`/`COMMIT;`, use `CREATE OR REPLACE` and `DROP POLICY IF EXISTS` for idempotency

### Running Tests

Before submitting a PR:

```bash
# Type checking
npm run type-check

# Linting
npm run lint

# Unit tests
npm run test

# Integration tests (requires supabase start)
npm run test:integration
```

## Pull Request Guidelines

### PR Structure

- Keep PRs focused on a single change
- Include a clear description of what changed and why
- Reference related issues
- Add tests for new functionality

### What to Include

- TypeScript types for new interfaces/data structures
- Unit tests for services and utilities
- Integration tests for database-touching features
- Updated documentation if the change affects user-facing features or APIs

### Review Process

- PRs require review before merging
- Address review comments with new commits (don't force-push during review)
- CI must pass (type check, lint, tests)

## Where to Find Things

| What | Where |
|------|-------|
| Component for a feature | `src/components/{feature}/` |
| Business logic | `src/services/` or `src/services/core/` |
| State management | `src/stores/` |
| Route definitions | `src/router/` |
| Database schema | `db_schema/init/` (fresh) or `db_schema/migrations/` (changes) |
| RLS policies | `db_schema/init/30_rls_policies.sql` |
| Federation backend | `federation-backend/src/` |
| Tests | `tests/` or co-located `__tests__/` directories |
| Documentation | `docs-source/guide/` (edit here, not `docs/guide/`) |

## Database Changes

When modifying the database schema:

1. Create an idempotent migration file in `db_schema/migrations/` with a date prefix (e.g., `20260306_add_new_table.sql`)
2. Wrap in `BEGIN;`/`COMMIT;`
3. Use `CREATE OR REPLACE` for functions and `DROP POLICY IF EXISTS` before `CREATE POLICY` for RLS
4. Update the corresponding init file in `db_schema/init/` if this is a fresh-install change
5. Test with `supabase db reset` to verify the init scripts still work

## License

Harmony is licensed under AGPL-3.0. By contributing, you agree that your contributions will be licensed under the same license.

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/development/contributing.md` and run `npm run docs:generate-guide` to update.
