# Getting Started with Harmony

Welcome to Harmony! This guide will help you set up and understand the federated social platform.

## What You'll Learn

- How to install and configure Harmony
- Understanding the architecture and core concepts
- Setting up development environment
- Basic usage and features

## Prerequisites

Before you begin, ensure you have:

- **Node.js 18+** - [Download from nodejs.org](https://nodejs.org/)
- **npm or yarn** - Package manager (comes with Node.js)
- **Git** - Version control system
- **Supabase Account** - [Sign up at supabase.com](https://supabase.com/)

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/harmony.git
cd harmony
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Environment Setup

Copy the environment template:

```bash
cp .env.example .env.local
```

Edit `.env.local` with your configuration:

```env
# Supabase Configuration
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key

# App Configuration
VITE_APP_URL=http://localhost:5173
VITE_APP_NAME=Harmony

# Federation Settings
VITE_FEDERATION_ENABLED=true
VITE_INSTANCE_DOMAIN=localhost:5173
```

### 4. Database Setup

1. Create a new Supabase project
2. Run the database migrations:
   ```bash
   # Import the schema
   psql -h your-db-host -U postgres -d postgres < db_schema/supabase_schema_backup_latest.sql
   ```
3. Set up storage buckets (follow the Supabase docs)

### 5. Start Development Server

```bash
npm run dev
```

Your application will be available at `http://localhost:5173`

## First Steps

### 1. Create an Account

- Navigate to `http://localhost:5173`
- Click "Register" to create your first account
- Complete the profile setup

### 2. Explore the Interface

Harmony has two main modes:

- **Chat Mode**: Discord-like servers and channels
- **Social Mode**: ActivityPub federated timeline

### 3. Create Your First Server

1. Click the "+" button in the server sidebar
2. Fill in server details
3. Create channels and invite users

### 4. Connect to the Fediverse

1. Go to Social mode
2. Configure federation settings
3. Follow users from other ActivityPub instances

## Development Workflow

### Project Structure

```
harmony/
├── src/
│   ├── components/     # Vue components
│   ├── stores/        # Pinia state management
│   ├── services/      # Business logic
│   ├── layouts/       # Layout components
│   ├── views/         # Page components
│   └── types/         # TypeScript definitions
├── docs/              # Documentation
├── public/            # Static assets
└── db_schema/         # Database schema files
```

### Key Commands

```bash
# Development
npm run dev              # Start dev server
npm run build           # Build for production
npm run preview         # Preview production build

# Code Quality
npm run type-check      # TypeScript checking
npm run lint           # ESLint checking
npm run format         # Prettier formatting

# Documentation
npm run docs:dev       # Start documentation server
npm run docs:build     # Build documentation
```

### Making Changes

1. **Components**: Add new Vue components in `src/components/`
2. **State**: Create Pinia stores in `src/stores/`
3. **Services**: Add business logic in `src/services/`
4. **Types**: Define TypeScript types in `src/types/`

## Next Steps

Now that you have Harmony running:

1. [Learn about the Architecture](/guide/architecture/) - Understand how everything works
2. [Explore Features](/guide/features/chat) - Deep dive into chat and social features
3. [Set up Federation](/guide/features/federation) - Connect to the fediverse
4. [Read the API Docs](/api/) - Understand the codebase

## Getting Help

- **Documentation**: Browse the complete guide
- **GitHub Issues**: Report bugs or request features
- **Community Chat**: Join our Discord server
- **Code Examples**: Check the `/examples` directory

## Contributing

We welcome contributions! See our [Contributing Guide](/guide/development/contributing) for details on:

- Code style and standards
- Pull request process
- Development setup
- Testing requirements

---

Ready to dive deeper? Continue with the [Architecture Overview](/guide/architecture/) to understand how Harmony works under the hood.
