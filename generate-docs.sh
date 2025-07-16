#!/bin/bash

# Harmony Documentation Auto-Generator
# This script regenerates all documentation from source code

echo "🚀 Harmony Documentation Auto-Generator"
echo "========================================"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}📊 Analyzing codebase...${NC}"

# Count components, services, stores, etc.
COMPONENT_COUNT=$(find src/components -name "*.vue" | wc -l)
SERVICE_COUNT=$(find src/services -name "*.ts" -o -name "*.js" 2>/dev/null | wc -l)
STORE_COUNT=$(find src/stores -name "*.ts" -o -name "*.js" 2>/dev/null | wc -l)
COMPOSABLE_COUNT=$(find src/composables -name "*.ts" -o -name "*.js" 2>/dev/null | wc -l)

echo "  📦 Found $COMPONENT_COUNT Vue components"
echo "  🔧 Found $SERVICE_COUNT services"
echo "  🗃️  Found $STORE_COUNT stores"
echo "  🎯 Found $COMPOSABLE_COUNT composables"

echo -e "\n${YELLOW}🔄 Generating documentation...${NC}"

# Generate component documentation
echo "  📝 Generating component documentation..."
npm run docs:generate-components

# Generate API documentation  
echo "  📝 Generating API documentation..."
npm run docs:generate-api

# Update VitePress configuration
echo "  🔄 Updating VitePress configuration..."
npm run docs:update-config

# Generate TypeDoc documentation
echo "  📝 Generating TypeDoc documentation..."
npm run docs:generate

echo -e "\n${GREEN}✅ Documentation generation complete!${NC}"

echo -e "\n${BLUE}📖 Documentation Summary:${NC}"
echo "  • Component docs: docs/components/"
echo "  • API docs: docs/api/"
echo "  • Generated files: docs/generated/"
echo "  • TypeDoc: docs/typedoc/"

echo -e "\n${YELLOW}🌐 Starting development server...${NC}"
echo "  📍 URL: http://localhost:3001/harmony/"

# Start the dev server
npm run docs:dev
