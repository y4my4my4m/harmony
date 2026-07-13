# Contributing to Harmony

This document covers setting up a dev environment, finding something to work on, and getting changes merged.

The project lives at <https://mony.lol>; the canonical instance is <https://har.mony.lol>. Drop in there for real-time chat with maintainers and other contributors.

## Getting Started

### Prerequisites

- Node.js 18+ or Bun
- Git
- Supabase account (free tier is fine)
- Basic knowledge of Vue 3, TypeScript, and Express

### Development Setup

1. **Fork and Clone**
   ```bash
   git clone https://github.com/y4my4my4m/harmony.git
   cd harmony
   ```

2. **Install Dependencies**
   ```bash
   # Frontend
   npm install
   
   # Federation backend
   cd federation-backend && npm install && cd ..
   ```

3. **Configure Environment**
   ```bash
   # Copy example env files
   cp .env.example .env
   cp federation-backend/env.template federation-backend/.env
   ```

4. **Set Up Supabase**
   - Create a Supabase project
   - Import schema from `db_schema/init/` (run `init.sql` which loads all numbered SQL files)
   - Copy your project URL and keys to `.env` files

5. **Start Development**
   ```bash
   # Terminal 1: Frontend
   npm run dev
   
   # Terminal 2: Federation backend (optional for many UI tasks)
   cd federation-backend && npm run dev
   ```

6. **Access the App**
   - Frontend: http://localhost:5173
   - Federation backend: http://localhost:3001
   - Health check: http://localhost:3001/health

## Roadmap & known issues

- **[ROADMAP.md](./ROADMAP.md)** - what we want to ship next, in priority order.
- **[BUGS.md](./BUGS.md)** - known defects (incl. security findings) on `master`.

## Development Workflow

### Branch Strategy

- `master` - Production / default branch. PRs target this directly.
- `feature/*` - New features
- `bugfix/*` - Bug fixes
- `security/*` - Security-related fixes (please coordinate via SECURITY.md before disclosing publicly)

### Making Changes

1. **Create a Branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make Your Changes**
   - Write clean, well-documented code
   - Follow the coding standards (see below)
   - Add tests for new features
   - Update documentation as needed

3. **Test Your Changes**
   ```bash
   # Frontend / app
   npm run lint
   npm run type-check
   npm run test           # Unit tests (Vitest)
   npm run test:integration  # Optional, requires `supabase start`

   # Federation backend
   cd federation-backend
   npx vitest run
   ```

4. **Commit Your Changes**
   ```bash
   git add .
   git commit -m "feat: add new feature description"
   ```

5. **Push and Create PR**
   ```bash
   git push origin feature/your-feature-name
   ```
   Then open a Pull Request against `master` on GitHub.

### Commit Message Convention

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**
```
feat(api): add message reactions endpoint
fix(frontend): resolve message saving bug
docs: update installation instructions
refactor(activitypub): simplify inbox handler
```

## Coding Standards

### TypeScript/JavaScript

- Use TypeScript for all new code
- Enable strict mode (`strict: true`)
- Use meaningful variable and function names
- Prefer `const` over `let`, avoid `var`
- Use async/await instead of callbacks
- Document complex logic with comments
- Export types for reusability

### Vue Components

- Use Composition API (`<script setup>`)
- Organize by: imports → composables → reactive state → computed → methods → lifecycle
- Use TypeScript for props/emits
- Create reusable composables for shared logic
- Keep components focused (single responsibility)

**Example:**
```vue
<script setup lang="ts">
import { ref, computed } from 'vue';
import { useUserData } from '@/composables/useUserData';

interface Props {
  userId: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'update', value: string): void;
}>();

const { user, loading } = useUserData(props.userId);
const displayName = computed(() => user.value?.display_name || 'Unknown');
</script>
```

### Backend Code

- Use services for business logic
- Keep routes thin (validation + service calls)
- Use middleware for cross-cutting concerns
- Handle errors gracefully
- Log important operations
- Use Zod for validation

**Example:**
```typescript
// Route
router.post('/', authenticate, asyncHandler(async (req, res) => {
  const validated = createSchema.parse(req.body);
  const result = await SomeService.create(validated, req.context!.userId);
  res.status(201).json({ success: true, data: result });
}));

// Service
class SomeService {
  static async create(data: CreateData, userId: string): Promise<Result> {
    // Business logic here
    logger.info(`Created resource for user ${userId}`);
    return result;
  }
}
```

### Database

- Use migrations for schema changes (no direct edits)
- Add indexes for frequently queried columns
- Use Row-Level Security (RLS) policies
- Avoid N+1 queries
- Use transactions for multi-step operations

## Testing

### Unit Tests

```typescript
// backend/src/services/__tests__/UserService.test.ts
describe('UserService', () => {
  it('should fetch user by ID', async () => {
    const user = await UserService.getUserById('test-id');
    expect(user).toBeDefined();
    expect(user.id).toBe('test-id');
  });
});
```

### Integration Tests

```typescript
// Test API endpoints
describe('POST /api/messages', () => {
  it('should create a message', async () => {
    const response = await request(app)
      .post('/api/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Test message', channelId: 'test-channel' });
    
    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
  });
});
```

## Documentation

### VitePress site and guides

- From the repo root: `npm run docs:dev` (see [docs/README.md](./docs/README.md)).
- Edit guides under `docs-source/guide/`, then run `npm run docs:generate-guide` (do not edit `docs/guide/` directly).

### Code Documentation

- Add JSDoc comments for public APIs
- Document complex algorithms
- Explain "why" not just "what"
- Keep comments up to date

### User Documentation

- Update README.md for user-facing changes
- Add examples for new features
- Update guides under `docs-source/guide/` for structural changes
- Create guides for complex features

## Pull Request Process

1. **Before Submitting**
   - Ensure all tests pass
   - Update documentation
   - Add a `CHANGELOG.md` entry if user-facing
   - Rebase on latest `master`

2. **PR Description**
   - Describe what changed and why
   - Link related issues
   - Add screenshots for UI changes
   - List breaking changes (if any)

3. **Review Process**
   - Address review comments
   - Keep discussions focused and respectful
   - Be open to suggestions
   - Update PR based on feedback

4. **After Approval**
   - Squash commits if requested
   - Maintainer will merge when ready

## Areas to Contribute

### Good First Issues

Look for issues labeled `good first issue`:
- Documentation improvements
- UI/UX enhancements
- Bug fixes
- Test coverage

### High Priority

- Performance optimizations
- Federation compatibility
- Mobile responsiveness
- Accessibility improvements
- Security enhancements

### Feature Requests

- Check existing issues/discussions first
- Open an issue to discuss before implementing
- Get consensus on approach
- Consider backward compatibility

## Reporting Security Issues

Please **do not** open a public GitHub issue for security vulnerabilities. See [SECURITY.md](./SECURITY.md) for the reporting process.

## Community

### Communication Channels

- GitHub Issues - Bug reports and feature requests
- GitHub Discussions - General questions and ideas
- Harmony - Real-time chat with the project at <https://har.mony.lol>
- Project home: <https://mony.lol>

### Getting Help

- Check existing documentation (`docs/`)
- Search closed issues
- Ask in GitHub Discussions
- Join the Harmony instance above for quick questions

## License

Harmony is under the **GNU Affero General Public License v3.0** (see root `LICENSE`). By contributing, you agree your contributions are licensed under the same terms.

---

Thank you for contributing to Harmony.

