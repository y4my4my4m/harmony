# VitePress Documentation Setup for Harmony

## Installation

```bash
npm install -D vitepress @types/node
```

## File Structure

```
docs/
├── .vitepress/
│   ├── config.ts
│   └── theme/
│       ├── index.ts
│       └── custom.css
├── guide/
│   ├── index.md
│   ├── installation.md
│   ├── architecture.md
│   └── features/
├── api/
│   ├── index.md
│   ├── services/
│   └── stores/
└── examples/
    ├── index.md
    └── components/
```

## Quick Start

1. Install dependencies:
   ```bash
   npm install -D vitepress
   ```

2. Add scripts to package.json:
   ```json
   {
     "scripts": {
       "docs:dev": "vitepress dev docs",
       "docs:build": "vitepress build docs",
       "docs:preview": "vitepress preview docs"
     }
   }
   ```

3. Create basic configuration:
   ```bash
   mkdir -p docs/.vitepress
   ```

4. Start development server:
   ```bash
   npm run docs:dev
   ```

## Notes

- Vite-powered static site generation
- Vue 3, matching the app's stack
- API docs generated from TypeScript
- Built-in local search
- Mobile-friendly layout
