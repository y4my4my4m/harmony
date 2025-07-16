#!/usr/bin/env node

import { promises as fs } from 'fs'
import path from 'path'
import { parse } from 'vue-docgen-api'
import { glob } from 'glob'

const COMPONENTS_DIR = 'src/components'
const DOCS_DIR = 'docs/components'
const GENERATED_DIR = 'docs/generated'

// Ensure directories exist
await fs.mkdir(GENERATED_DIR, { recursive: true })
await fs.mkdir(`${GENERATED_DIR}/components`, { recursive: true })

// Find all Vue components
const componentFiles = await glob(`${COMPONENTS_DIR}/**/*.vue`)

console.log(`Found ${componentFiles.length} Vue components`)

// Generate documentation for each component
const componentDocs = []

for (const filePath of componentFiles) {
  try {
    console.log(`Processing ${filePath}...`)
    
    // Parse the component
    const componentInfo = await parse(filePath)
    
    // Generate relative path for documentation
    const relativePath = path.relative(COMPONENTS_DIR, filePath)
    const docPath = relativePath.replace('.vue', '.md').toLowerCase()
    const componentName = path.basename(filePath, '.vue')
    
    // Generate markdown documentation
    const markdown = generateComponentMarkdown(componentInfo, componentName, filePath)
    
    // Create directory structure
    const fullDocPath = path.join(DOCS_DIR, docPath)
    const docDir = path.dirname(fullDocPath)
    await fs.mkdir(docDir, { recursive: true })
    
    // Write documentation file
    await fs.writeFile(fullDocPath, markdown)
    
    componentDocs.push({
      name: componentName,
      path: docPath,
      info: componentInfo
    })
    
    console.log(`Generated docs for ${componentName}`)
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error.message)
  }
}

// Generate component index
const indexMarkdown = generateComponentIndex(componentDocs)
await fs.writeFile(path.join(DOCS_DIR, 'generated-index.md'), indexMarkdown)

// Save component data as JSON for programmatic access
await fs.writeFile(
  path.join(GENERATED_DIR, 'components.json'), 
  JSON.stringify(componentDocs, null, 2)
)

console.log(`\n✅ Generated documentation for ${componentDocs.length} components`)
console.log(`📁 Documentation files written to: ${DOCS_DIR}`)
console.log(`📄 Component index: ${DOCS_DIR}/generated-index.md`)

function generateComponentMarkdown(componentInfo, componentName, filePath) {
  const { displayName, description, props, events, slots, methods, tags } = componentInfo
  
  return `# ${displayName || componentName}

${description || 'No description available.'}

**File:** \`${filePath}\`

## Overview

\`\`\`mermaid
graph TB
    PROPS[Props] --> COMPONENT[${componentName}]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
\`\`\`

${props && props.length > 0 ? `## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
${props.map(prop => `| \`${prop.name}\` | \`${prop.type?.name || 'any'}\` | \`${prop.defaultValue?.value || 'undefined'}\` | ${prop.required ? '✅' : '❌'} | ${prop.description || 'No description'} |`).join('\n')}

### Props Details

${props.map(prop => `#### \`${prop.name}\`

${prop.description || 'No description available.'}

- **Type:** \`${prop.type?.name || 'any'}\`
- **Required:** ${prop.required ? 'Yes' : 'No'}
- **Default:** \`${prop.defaultValue?.value || 'undefined'}\`

${prop.tags && prop.tags.length > 0 ? `**Tags:** ${prop.tags.map(tag => `\`@${tag.title}\``).join(', ')}` : ''}
`).join('\n')}` : '## Props\n\nThis component has no props.'}

${events && events.length > 0 ? `## Events

| Name | Parameters | Description |
|------|------------|-------------|
${events.map(event => `| \`${event.name}\` | ${event.type?.names?.join(', ') || 'unknown'} | ${event.description || 'No description'} |`).join('\n')}

### Event Details

${events.map(event => `#### \`${event.name}\`

${event.description || 'No description available.'}

**Parameters:** \`${event.type?.names?.join(', ') || 'unknown'}\`

${event.tags && event.tags.length > 0 ? `**Tags:** ${event.tags.map(tag => `\`@${tag.title}\``).join(', ')}` : ''}
`).join('\n')}` : '## Events\n\nThis component emits no events.'}

${slots && slots.length > 0 ? `## Slots

| Name | Scoped | Description |
|------|--------|-------------|
${slots.map(slot => `| \`${slot.name}\` | ${slot.scoped ? '✅' : '❌'} | ${slot.description || 'No description'} |`).join('\n')}

### Slot Details

${slots.map(slot => `#### \`${slot.name}\`

${slot.description || 'No description available.'}

**Scoped:** ${slot.scoped ? 'Yes' : 'No'}

${slot.bindings && slot.bindings.length > 0 ? `**Bindings:**
${slot.bindings.map(binding => `- \`${binding.name}\`: \`${binding.type?.name || 'any'}\` - ${binding.description || 'No description'}`).join('\n')}` : ''}
`).join('\n')}` : '## Slots\n\nThis component has no slots.'}

${methods && methods.length > 0 ? `## Methods

| Name | Parameters | Returns | Description |
|------|------------|---------|-------------|
${methods.map(method => `| \`${method.name}\` | ${method.params?.map(p => `${p.name}: ${p.type?.name || 'any'}`).join(', ') || 'none'} | \`${method.returns?.type?.name || 'void'}\` | ${method.description || 'No description'} |`).join('\n')}

### Method Details

${methods.map(method => `#### \`${method.name}\`

${method.description || 'No description available.'}

**Parameters:**
${method.params?.map(param => `- \`${param.name}\`: \`${param.type?.name || 'any'}\` - ${param.description || 'No description'}`).join('\n') || 'None'}

**Returns:** \`${method.returns?.type?.name || 'void'}\`
${method.returns?.description ? `\n${method.returns.description}` : ''}
`).join('\n')}` : '## Methods\n\nThis component exposes no public methods.'}

## Usage Example

\`\`\`vue
<template>
  <${componentName}${props && props.length > 0 ? `
    ${props.filter(p => p.required).map(p => `:${p.name}="${getExampleValue(p)}"`).join('\n    ')}` : ''}${events && events.length > 0 ? `
    ${events.map(e => `@${e.name}="handle${capitalize(e.name)}"`).join('\n    ')}` : ''}${slots && slots.length > 0 ? `>
    ${slots.map(s => `<template #${s.name}${s.scoped ? '="slotProps"' : ''}>
      <!-- Slot content for ${s.name} -->
    </template>`).join('\n    ')}
  </${componentName}>` : ' />'}
</template>

<script setup lang="ts">
${events && events.length > 0 ? events.map(e => `const handle${capitalize(e.name)} = (${e.type?.names?.join(', ') || 'data'}) => {
  // Handle ${e.name} event
}`).join('\n\n') : '// No event handlers needed'}
</script>
\`\`\`

${tags && tags.length > 0 ? `## Component Tags

${tags.map(tag => `- **@${tag.title}:** ${tag.description || 'No description'}`).join('\n')}` : ''}

## File Location

\`${filePath}\`

---

*This documentation was automatically generated from the component source code.*`
}

function generateComponentIndex(componentDocs) {
  const categorized = {}
  
  componentDocs.forEach(doc => {
    const category = doc.path.split('/')[0] || 'uncategorized'
    if (!categorized[category]) {
      categorized[category] = []
    }
    categorized[category].push(doc)
  })
  
  return `# Auto-Generated Component Documentation

This documentation is automatically generated from the Vue component source code.

**Total Components:** ${componentDocs.length}

## Components by Category

${Object.entries(categorized).map(([category, components]) => `### ${capitalize(category)}

${components.map(comp => `- [${comp.name}](./${comp.path}) - ${comp.info.description || 'No description'}`).join('\n')}`).join('\n\n')}

## All Components

${componentDocs.map(doc => `- **[${doc.name}](./${doc.path})** - ${doc.info.description || 'No description'}`).join('\n')}

---

*Last generated: ${new Date().toISOString()}*`
}

function getExampleValue(prop) {
  const type = prop.type?.name?.toLowerCase()
  
  switch (type) {
    case 'string': return '"example"'
    case 'number': return '42'
    case 'boolean': return 'true'
    case 'array': return '[]'
    case 'object': return '{}'
    default: return prop.defaultValue?.value || 'undefined'
  }
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}
