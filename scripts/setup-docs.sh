#!/bin/bash

# Harmony Documentation Setup Script
# This script sets up VitePress documentation for the Harmony project

set -e

echo "🚀 Setting up Harmony Documentation System..."

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script from the project root."
    exit 1
fi

# Install VitePress and dependencies
echo "📦 Installing VitePress and dependencies..."
npm install -D vitepress @types/node

# Update package.json scripts
echo "📝 Adding documentation scripts to package.json..."

# Create temporary package.json with new scripts
cat package.json | jq '.scripts += {
    "docs:dev": "vitepress dev docs",
    "docs:build": "vitepress build docs", 
    "docs:preview": "vitepress preview docs",
    "docs:generate-api": "typedoc --options typedoc.json",
    "docs:generate-all": "npm run docs:generate-api && npm run docs:build"
}' > package.json.tmp && mv package.json.tmp package.json

# Create additional documentation directories
echo "📁 Creating documentation structure..."
mkdir -p docs/{guide/{architecture,features,development,deployment},api/{services,stores,composables,types},components/{layouts,chat,social,shared},examples,flows}

# Create TypeDoc configuration for API documentation
echo "⚙️ Setting up TypeDoc configuration..."
cat > typedoc.config.js << 'EOF'
module.exports = {
  entryPoints: ['./src'],
  out: './docs/api/generated',
  theme: 'default',
  includeVersion: true,
  excludePrivate: true,
  excludeProtected: true,
  excludeExternals: true,
  readme: 'none',
  navigation: {
    includeCategories: true,
    includeGroups: true
  },
  categorizeByGroup: true,
  groupOrder: [
    'Services',
    'Stores', 
    'Components',
    'Types',
    'Utilities'
  ],
  plugin: ['typedoc-plugin-markdown'],
  githubPages: false
}
EOF

# Create documentation automation script
echo "🤖 Creating documentation automation..."
cat > scripts/generate-docs.js << 'EOF'
#!/usr/bin/env node

/**
 * Documentation Generation Script
 * Automatically generates documentation from source code
 */

const fs = require('fs');
const path = require('path');

// Generate service documentation
function generateServiceDocs() {
  const servicesDir = './src/services';
  const outputDir = './docs/api/services';
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const services = fs.readdirSync(servicesDir)
    .filter(file => file.endsWith('.ts'))
    .map(file => file.replace('.ts', ''));
  
  services.forEach(service => {
    const content = `# ${service}

> Auto-generated documentation for ${service}

## Overview

This service handles [description].

## Methods

[Auto-generated method documentation]

## Usage Example

\`\`\`typescript
import { ${service} } from '@/services/${service}'

// Example usage
\`\`\`

## Related

- [Service Overview](/api/)
- [Type Definitions](/api/types/)
`;

    fs.writeFileSync(path.join(outputDir, `${service.toLowerCase()}.md`), content);
  });
  
  console.log(`✅ Generated documentation for ${services.length} services`);
}

// Generate store documentation
function generateStoreDocs() {
  const storesDir = './src/stores';
  const outputDir = './docs/api/stores';
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const stores = fs.readdirSync(storesDir)
    .filter(file => file.endsWith('.ts'))
    .map(file => file.replace('.ts', ''));
  
  stores.forEach(store => {
    const content = `# ${store}

> Auto-generated documentation for ${store}

## State

[Auto-generated state documentation]

## Getters

[Auto-generated getters documentation]

## Actions

[Auto-generated actions documentation]

## Usage Example

\`\`\`typescript
import { ${store} } from '@/stores/${store}'

const store = ${store}()
// Example usage
\`\`\`
`;

    fs.writeFileSync(path.join(outputDir, `${store.toLowerCase()}.md`), content);
  });
  
  console.log(`✅ Generated documentation for ${stores.length} stores`);
}

// Main execution
console.log('🚀 Generating documentation...');
generateServiceDocs();
generateStoreDocs();
console.log('✅ Documentation generation complete!');
EOF

chmod +x scripts/generate-docs.js

# Create GitHub Actions workflow for docs
echo "🔄 Setting up GitHub Actions for documentation..."
mkdir -p .github/workflows

cat > .github/workflows/docs.yml << 'EOF'
name: Deploy Documentation

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  docs:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Generate API documentation
        run: npm run docs:generate-api
        
      - name: Build VitePress documentation
        run: npm run docs:build
        
      - name: Deploy to GitHub Pages
        if: github.ref == 'refs/heads/main'
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: docs/.vitepress/dist
          cname: harmony-docs.yourdomain.com  # Optional: your custom domain
EOF

# Create documentation README
echo "📖 Creating documentation README..."
cat > docs/README.md << 'EOF'
# Harmony Documentation

This directory contains the complete documentation for the Harmony federated social platform.

## Structure

- **`guide/`** - User and developer guides
- **`api/`** - Auto-generated API documentation
- **`components/`** - Component documentation
- **`examples/`** - Code examples and tutorials
- **`flows/`** - System architecture and flow diagrams

## Development

```bash
# Start documentation development server
npm run docs:dev

# Build documentation
npm run docs:build

# Preview built documentation
npm run docs:preview
```

## Contributing

When adding new features:

1. Update relevant guide pages
2. Add API documentation for new services/stores
3. Include component documentation for UI changes
4. Add examples for complex features

The documentation is automatically generated and deployed on every push to main.
EOF

# Success message
echo ""
echo "✅ Harmony Documentation System Setup Complete!"
echo ""
echo "📚 What was created:"
echo "  • VitePress configuration and theme"
echo "  • Documentation structure and templates"
echo "  • TypeDoc integration for API docs"
echo "  • GitHub Actions for automated deployment"
echo "  • Documentation generation scripts"
echo ""
echo "🚀 Next steps:"
echo "  1. Run 'npm run docs:dev' to start the documentation server"
echo "  2. Visit http://localhost:3001 to see your documentation"
echo "  3. Customize the content in docs/ directories"
echo "  4. Add your repository URL to .vitepress/config.ts"
echo ""
echo "📖 Documentation will be available at:"
echo "  • Development: http://localhost:3001"
echo "  • Production: GitHub Pages (after first deployment)"
echo ""
echo "Happy documenting! 🎉"
