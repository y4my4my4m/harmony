# Contributing to Harmony

Thank you for your interest in contributing to Harmony! This document provides guidelines and instructions for contributing.

## Code of Conduct

### Our Pledge

We are committed to providing a welcoming and inspiring community for all. Please be respectful and constructive in all interactions.

### Expected Behavior

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Give and accept constructive feedback gracefully
- Focus on what is best for the community
- Show empathy towards other community members

### Unacceptable Behavior

- Harassment, discrimination, or offensive comments
- Trolling, insulting/derogatory comments, and personal attacks
- Public or private harassment
- Publishing others' private information
- Other conduct which could reasonably be considered inappropriate

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
   
   # Backend
   cd backend && npm install
   ```

3. **Configure Environment**
   ```bash
   # Copy example env files
   cp .env.example .env
   cd backend && cp .env.example .env
   ```

4. **Set Up Supabase**
   - Create a Supabase project
   - Import schema from `harmonious/supabase_schema_backup_latest.sql`
   - Copy your project URL and keys to `.env` files

5. **Start Development**
   ```bash
   # Terminal 1: Frontend
   npm run dev
   
   # Terminal 2: Backend
   cd backend && npm run dev
   ```

6. **Access the App**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3001
   - Health check: http://localhost:3001/health

## Development Workflow

### Branch Strategy

- `main` - Production-ready code
- `develop` - Integration branch for features
- `feature/*` - New features
- `bugfix/*` - Bug fixes
- `hotfix/*` - Urgent production fixes

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
   # Frontend
   npm run lint
   npm run type-check
   
   # Backend
   cd backend
   npm run lint
   npm run type-check
   npm test  # When tests are set up
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
   Then create a Pull Request on GitHub.

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

### Code Documentation

- Add JSDoc comments for public APIs
- Document complex algorithms
- Explain "why" not just "what"
- Keep comments up to date

### User Documentation

- Update README.md for user-facing changes
- Add examples for new features
- Update ARCHITECTURE.md for structural changes
- Create guides for complex features

## Pull Request Process

1. **Before Submitting**
   - Ensure all tests pass
   - Update documentation
   - Add changelog entry if needed
   - Rebase on latest `develop`

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

## Community

### Communication Channels

- GitHub Issues - Bug reports and feature requests
- GitHub Discussions - General questions and ideas
- Discord - Real-time chat (link in README)

### Getting Help

- Check existing documentation
- Search closed issues
- Ask in Discussions
- Join Discord for quick questions

## Recognition

Contributors will be:
- Listed in CONTRIBUTORS.md
- Credited in release notes
- Given credit in commit history
- Appreciated in the community!

## License

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 License.

---

Thank you for contributing to Harmony! 🎵

