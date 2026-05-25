#!/bin/bash
# Script to migrate console.log/warn/error to debug.log/warn/error
# Run from project root: ./scripts/migrate-console-to-debug.sh

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🔄 Migrating console statements to debug utility...${NC}"

# Find all TypeScript and Vue files with console statements (excluding node_modules and the debug utility itself)
FILES=$(find src -type f \( -name "*.ts" -o -name "*.vue" \) \
  -not -path "*/node_modules/*" \
  -not -name "debug.ts" \
  -exec grep -l "console\.\(log\|warn\|error\)" {} \;)

UPDATED=0
FAILED=0

for file in $FILES; do
  echo -e "Processing: $file"
  
  # Check if debug import already exists
  if grep -q "import { debug } from '@/utils/debug'" "$file" || \
     grep -q "import { debug }" "$file"; then
    echo -e "  ${GREEN}✓ Debug import already exists${NC}"
  else
    # Determine file type and add import appropriately
    if [[ "$file" == *.vue ]]; then
      # For Vue files, add import after <script setup lang="ts"> or first import
      if grep -q "<script setup" "$file"; then
        # Vue 3 script setup - add after first import line
        sed -i '/<script setup/,/^import/{/^import/a\import { debug } from '"'"'@/utils/debug'"'"'
        }' "$file" 2>/dev/null || true
      fi
    else
      # For TypeScript files, add import at the top after existing imports
      # Find the last import statement and add after it
      LAST_IMPORT_LINE=$(grep -n "^import" "$file" | tail -1 | cut -d: -f1)
      if [ -n "$LAST_IMPORT_LINE" ]; then
        sed -i "${LAST_IMPORT_LINE}a\\import { debug } from '@/utils/debug'" "$file" 2>/dev/null || true
      fi
    fi
    echo -e "  ${GREEN}+ Added debug import${NC}"
  fi
  
  # Replace console.log with debug.log
  if grep -q "console\.log" "$file"; then
    sed -i 's/console\.log/debug.log/g' "$file"
    echo -e "  ${GREEN}✓ Replaced console.log → debug.log${NC}"
  fi
  
  # Replace console.warn with debug.warn
  if grep -q "console\.warn" "$file"; then
    sed -i 's/console\.warn/debug.warn/g' "$file"
    echo -e "  ${GREEN}✓ Replaced console.warn → debug.warn${NC}"
  fi
  
  # Replace console.error with debug.error
  if grep -q "console\.error" "$file"; then
    sed -i 's/console\.error/debug.error/g' "$file"
    echo -e "  ${GREEN}✓ Replaced console.error → debug.error${NC}"
  fi
  
  ((UPDATED++))
done

echo ""
echo -e "${GREEN}✅ Migration complete!${NC}"
echo -e "   Updated: ${UPDATED} files"
echo ""
echo -e "${YELLOW}Note: You may need to manually verify imports in Vue files${NC}"
echo -e "${YELLOW}Run 'npm run build' to check for any TypeScript errors${NC}"

