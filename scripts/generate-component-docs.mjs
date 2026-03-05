#!/usr/bin/env node

import { promises as fs } from 'fs'
import path from 'path'
import { glob } from 'glob'

// Try to import vue-docgen-api, fall back to basic parsing if not available
let parse
try {
  const vueDocgen = await import('vue-docgen-api')
  parse = vueDocgen.parse
} catch (e) {
  console.log('⚠️  vue-docgen-api not available, using basic parsing')
  parse = null
}

const COMPONENTS_DIR = 'src/components'
const DOCS_DIR = 'docs/components'
const GENERATED_DIR = 'docs/generated'

// Ensure directories exist
await fs.mkdir(GENERATED_DIR, { recursive: true })
await fs.mkdir(`${GENERATED_DIR}/components`, { recursive: true })

// Find all Vue components
const componentFiles = await glob(`${COMPONENTS_DIR}/**/*.vue`, {
  ignore: ['**/*.legacy', '**/*.backup']
})

console.log(`Found ${componentFiles.length} Vue components`)

// Generate documentation for each component
const componentDocs = []
const errors = []

for (const filePath of componentFiles) {
  try {
    console.log(`Processing ${filePath}...`)
    
    // Read component content
    const content = await fs.readFile(filePath, 'utf-8')
    
    // Calculate relative path for documentation
    const relativePath = path.relative(COMPONENTS_DIR, filePath)
    const docPath = relativePath.replace('.vue', '.md').toLowerCase()
    const componentName = path.basename(filePath, '.vue')
    
    let componentInfo = null
    
    // Try to parse with vue-docgen-api
    if (parse) {
      try {
        componentInfo = await parse(filePath)
      } catch (parseError) {
        console.log(`  ⚠️  vue-docgen-api parse failed, using fallback: ${parseError.message}`)
      }
    }
    
    // Fallback to basic parsing if vue-docgen fails
    if (!componentInfo) {
      componentInfo = parseComponentBasic(content, componentName)
    }
    
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
      info: componentInfo,
      relativePath: relativePath
    })
    
    console.log(`  ✅ Generated docs for ${componentName}`)
  } catch (error) {
    console.error(`  ❌ Error processing ${filePath}:`, error.message)
    errors.push({ file: filePath, error: error.message })
  }
}

// Generate component index
const indexMarkdown = generateComponentIndex(componentDocs)
await fs.writeFile(path.join(DOCS_DIR, 'index.md'), indexMarkdown)
await fs.writeFile(path.join(DOCS_DIR, 'generated-index.md'), indexMarkdown)

// Save component data as JSON for programmatic access
await fs.writeFile(
  path.join(GENERATED_DIR, 'components.json'), 
  JSON.stringify(componentDocs.map(doc => ({
    name: doc.name,
    path: doc.path,
    relativePath: doc.relativePath,
    props: doc.info.props?.length || 0,
    events: doc.info.events?.length || 0,
    slots: doc.info.slots?.length || 0
  })), null, 2)
)

console.log(`\n✅ Generated documentation for ${componentDocs.length} components`)
console.log(`📁 Documentation files written to: ${DOCS_DIR}`)
console.log(`📄 Component index: ${DOCS_DIR}/index.md`)

if (errors.length > 0) {
  console.log(`\n⚠️  ${errors.length} components had errors:`)
  errors.forEach(e => console.log(`   - ${e.file}: ${e.error}`))
}

// Basic component parser (fallback when vue-docgen-api fails)
function parseComponentBasic(content, componentName) {
  const result = {
    displayName: componentName,
    description: '',
    props: [],
    events: [],
    slots: [],
    methods: [],
    tags: []
  }
  
  // Extract script setup content
  const scriptMatch = content.match(/<script[^>]*setup[^>]*>([\s\S]*?)<\/script>/i)
  const scriptContent = scriptMatch ? scriptMatch[1] : ''
  
  // Extract props from defineProps
  const propsMatch = scriptContent.match(/defineProps(?:<([^>]+)>)?\s*\(\s*(?:\{([\s\S]*?)\}|\[([\s\S]*?)\])?\s*\)/s)
  if (propsMatch) {
    const propsType = propsMatch[1] || ''
    const propsObject = propsMatch[2] || ''
    const propsArray = propsMatch[3] || ''
    
    // Extract from type definition
    if (propsType) {
      const propMatches = propsType.matchAll(/(\w+)(?:\?)?:\s*([^,;\n}]+)/g)
      for (const match of propMatches) {
        result.props.push({
          name: match[1],
          type: { name: match[2].trim() },
          required: !propsType.includes(`${match[1]}?`),
          description: ''
        })
      }
    }
    
    // Extract from object definition
    if (propsObject) {
      const propMatches = propsObject.matchAll(/(\w+)\s*:\s*\{([^}]+)\}/g)
      for (const match of propMatches) {
        const propDef = match[2]
        const typeMatch = propDef.match(/type\s*:\s*(\w+)/)
        const requiredMatch = propDef.match(/required\s*:\s*(true|false)/)
        result.props.push({
          name: match[1],
          type: { name: typeMatch ? typeMatch[1] : 'unknown' },
          required: requiredMatch ? requiredMatch[1] === 'true' : false,
          description: ''
        })
      }
    }
    
    // Extract from array definition
    if (propsArray) {
      const propNames = propsArray.match(/'(\w+)'/g) || []
      propNames.forEach(name => {
        result.props.push({
          name: name.replace(/'/g, ''),
          type: { name: 'unknown' },
          required: false,
          description: ''
        })
      })
    }
  }
  
  // Extract emits from defineEmits
  const emitsMatch = scriptContent.match(/defineEmits(?:<([^>]+)>)?\s*\(\s*(?:\[([\s\S]*?)\])?\s*\)/s)
  if (emitsMatch) {
    const emitsType = emitsMatch[1] || ''
    const emitsArray = emitsMatch[2] || ''
    
    // Extract from type definition
    if (emitsType) {
      const emitMatches = emitsType.matchAll(/\(\s*e\s*:\s*['"](\w+)['"]/g)
      for (const match of emitMatches) {
        result.events.push({
          name: match[1],
          description: ''
        })
      }
    }
    
    // Extract from array definition
    if (emitsArray) {
      const eventNames = emitsArray.match(/'(\w+)'/g) || []
      eventNames.forEach(name => {
        result.events.push({
          name: name.replace(/'/g, ''),
          description: ''
        })
      })
    }
  }
  
  // Extract slots from template
  const templateMatch = content.match(/<template[^>]*>([\s\S]*?)<\/template>/i)
  const templateContent = templateMatch ? templateMatch[1] : ''
  
  const slotMatches = templateContent.matchAll(/<slot(?:\s+name=["']([^"']+)["'])?[^>]*(?:\/>|>[\s\S]*?<\/slot>)/g)
  for (const match of slotMatches) {
    const slotName = match[1] || 'default'
    if (!result.slots.find(s => s.name === slotName)) {
      result.slots.push({
        name: slotName,
        description: ''
      })
    }
  }
  
  // Extract component description from comments
  const docCommentMatch = content.match(/<!--\s*@component\s*([\s\S]*?)-->/i)
  if (docCommentMatch) {
    result.description = docCommentMatch[1].trim()
  }
  
  return result
}

function generateComponentMarkdown(componentInfo, componentName, filePath) {
  const { displayName, description, props, events, slots, methods, tags } = componentInfo
  
  return `# ${displayName || componentName}

${description || 'A Vue component.'}

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
${events.map(event => `| \`${event.name}\` | \`${event.type?.names?.join(', ') || 'unknown'}\` | ${event.description || 'No description'} |`).join('\n')}

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
${events && events.length > 0 ? events.map(e => `const handle${capitalize(e.name)} = (data: ${e.type?.names?.[0] || 'unknown'}) => {
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
    // Get category from first directory in path
    const pathParts = doc.path.split('/')
    const category = pathParts.length > 1 ? pathParts[0] : 'root'
    if (!categorized[category]) {
      categorized[category] = []
    }
    categorized[category].push(doc)
  })
  
  // Sort categories and components
  const sortedCategories = Object.keys(categorized).sort()
  sortedCategories.forEach(key => {
    categorized[key].sort((a, b) => a.name.localeCompare(b.name))
  })
  
  return `# Component Library

This documentation is automatically generated from the Vue component source code.

**Total Components:** ${componentDocs.length}

## Overview

\`\`\`mermaid
graph TB
    subgraph "Component Architecture"
        LAYOUTS[Layouts]
        VIEWS[Views]
        SHARED[Shared Components]
        FEATURE[Feature Components]
    end
    
    VIEWS --> LAYOUTS
    VIEWS --> SHARED
    VIEWS --> FEATURE
    FEATURE --> SHARED
\`\`\`

## Components by Category

${sortedCategories.map(category => `### ${capitalize(category)}

${categorized[category].map(comp => {
  const propCount = comp.info.props?.length || 0
  const eventCount = comp.info.events?.length || 0
  const slotCount = comp.info.slots?.length || 0
  const stats = [
    propCount > 0 ? `${propCount} props` : null,
    eventCount > 0 ? `${eventCount} events` : null,
    slotCount > 0 ? `${slotCount} slots` : null
  ].filter(Boolean).join(', ')
  
  return `- [${comp.name}](./${comp.path})${stats ? ` - ${stats}` : ''}`
}).join('\n')}`).join('\n\n')}

## All Components

| Component | Props | Events | Slots | Path |
|-----------|-------|--------|-------|------|
${componentDocs.sort((a, b) => a.name.localeCompare(b.name)).map(doc => {
  return `| [${doc.name}](./${doc.path}) | ${doc.info.props?.length || 0} | ${doc.info.events?.length || 0} | ${doc.info.slots?.length || 0} | \`${doc.relativePath}\` |`
}).join('\n')}

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
  if (!str) return ''
  return str.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')
}
