#!/usr/bin/env node

import { promises as fs } from 'fs'
import path from 'path'
import { glob } from 'glob'

const SERVICES_DIR = 'src/services'
const STORES_DIR = 'src/stores'
const COMPOSABLES_DIR = 'src/composables'
const TYPES_DIR = 'src/types'
const UTILS_DIR = 'src/utils'
const CONFIG_DIR = 'src/config'
const DIRECTIVES_DIR = 'src/directives'
const LAYOUTS_DIR = 'src/layouts'
const ROUTER_DIR = 'src/router'
const VIEWS_DIR = 'src/views'
const DOCS_API_DIR = 'docs/api'
const GENERATED_DIR = 'docs/generated'

// Ensure directories exist
await fs.mkdir(`${GENERATED_DIR}/api`, { recursive: true })
await fs.mkdir(`${DOCS_API_DIR}/services`, { recursive: true })
await fs.mkdir(`${DOCS_API_DIR}/stores`, { recursive: true })
await fs.mkdir(`${DOCS_API_DIR}/composables`, { recursive: true })
await fs.mkdir(`${DOCS_API_DIR}/types`, { recursive: true })
await fs.mkdir(`${DOCS_API_DIR}/utils`, { recursive: true })
await fs.mkdir(`${DOCS_API_DIR}/config`, { recursive: true })
await fs.mkdir(`${DOCS_API_DIR}/directives`, { recursive: true })
await fs.mkdir(`${DOCS_API_DIR}/layouts`, { recursive: true })
await fs.mkdir(`${DOCS_API_DIR}/router`, { recursive: true })
await fs.mkdir(`${DOCS_API_DIR}/views`, { recursive: true })

console.log('🔧 Generating API documentation from TypeScript files...')

// Process all directories
await processDirectory(SERVICES_DIR, 'services', 'Service')
await processDirectory(STORES_DIR, 'stores', 'Store')
await processDirectory(COMPOSABLES_DIR, 'composables', 'Composable')
await processDirectory(TYPES_DIR, 'types', 'Types')
await processDirectory(UTILS_DIR, 'utils', 'Utility')
await processDirectory(CONFIG_DIR, 'config', 'Configuration')
await processDirectory(DIRECTIVES_DIR, 'directives', 'Directive')
await processDirectory(LAYOUTS_DIR, 'layouts', 'Layout')
await processDirectory(ROUTER_DIR, 'router', 'Router')
await processDirectory(VIEWS_DIR, 'views', 'View')

console.log('✅ API documentation generation complete!')

async function processDirectory(sourceDir, category, suffix) {
  try {
    const files = await glob(`${sourceDir}/**/*.{ts,js}`)
    console.log(`\n📁 Processing ${category}: ${files.length} files`)
    
    for (const filePath of files) {
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        const fileName = path.basename(filePath, path.extname(filePath))
        const markdown = await generateApiMarkdown(content, fileName, filePath, suffix)
        
        const docPath = path.join(DOCS_API_DIR, category, `${fileName.toLowerCase()}.md`)
        await fs.writeFile(docPath, markdown)
        
        console.log(`  ✅ Generated: ${fileName}`)
      } catch (error) {
        console.error(`  ❌ Error processing ${filePath}:`, error.message)
      }
    }
  } catch (error) {
    console.log(`⚠️  Directory ${sourceDir} not found, skipping...`)
  }
}

async function generateApiMarkdown(content, fileName, filePath, suffix) {
  const exports = extractExports(content)
  const functions = extractFunctions(content)
  const classes = extractClasses(content)
  const interfaces = extractInterfaces(content)
  const types = extractTypes(content)
  const constants = extractConstants(content)
  const jsdocComments = extractJSDocComments(content)
  
  return `# ${fileName} ${suffix}

**File:** \`${filePath}\`

## Overview

\`\`\`mermaid
graph TB
    subgraph "${fileName} ${suffix}"
        ${exports.length > 0 ? exports.map(exp => `${exp.name.toUpperCase()}[${exp.name}]`).join('\n        ') : 'EMPTY[No exports]'}
    end
    
    ${functions.length > 0 ? `subgraph "Functions"
        ${functions.map(fn => `${fn.name.toUpperCase()}[${fn.name}()]`).join('\n        ')}
    end` : ''}
    
    ${interfaces.length > 0 ? `subgraph "Interfaces"
        ${interfaces.map(int => `${int.name.toUpperCase()}[${int.name}]`).join('\n        ')}
    end` : ''}
\`\`\`

${exports.length > 0 ? `## Exports

${exports.map(exp => `- **${exp.name}** - ${exp.description || 'No description'}`).join('\n')}` : ''}

${functions.length > 0 ? `## Functions

${functions.map(fn => `### \`${fn.name}(${fn.params.join(', ')})\`

${fn.description || 'No description available.'}

**Parameters:**
${fn.params.length > 0 ? fn.params.map(param => `- \`${param}\``).join('\n') : 'None'}

**Returns:** ${fn.returnType || 'Unknown'}

\`\`\`typescript
${fn.signature}
\`\`\`
`).join('\n')}` : ''}

${classes.length > 0 ? `## Classes

${classes.map(cls => `### ${cls.name}

${cls.description || 'No description available.'}

**Methods:**
${cls.methods.map(method => `- \`${method}\``).join('\n') || 'None'}

**Properties:**
${cls.properties.map(prop => `- \`${prop}\``).join('\n') || 'None'}
`).join('\n')}` : ''}

${interfaces.length > 0 ? `## Interfaces

${interfaces.map(int => `### ${int.name}

${int.description || 'No description available.'}

\`\`\`typescript
${int.definition}
\`\`\`
`).join('\n')}` : ''}

${types.length > 0 ? `## Type Definitions

${types.map(type => `### ${type.name}

${type.description || 'No description available.'}

\`\`\`typescript
${type.definition}
\`\`\`
`).join('\n')}` : ''}

${constants.length > 0 ? `## Constants

${constants.map(constant => `### ${constant.name}

${constant.description || 'No description available.'}

\`\`\`typescript
${constant.definition}
\`\`\`
`).join('\n')}` : ''}

## Source Code Insights

**File Size:** ${content.length} characters
**Lines of Code:** ${content.split('\n').length}
**Imports:** ${(content.match(/^import .+$/gm) || []).length}

## Usage Example

\`\`\`typescript
import { ${exports.map(exp => exp.name).join(', ') || fileName} } from '${filePath.replace('src/', '@/')}'

// Example usage
${functions.length > 0 ? functions[0].name + '()' : '// Use the exported functionality'}
\`\`\`

---

*This documentation was automatically generated from the source code.*`
}

function extractExports(content) {
  const exports = []
  
  // Named exports
  const namedExports = content.match(/export\s+(?:const|function|class|interface|type)\s+(\w+)/g) || []
  namedExports.forEach(exp => {
    const name = exp.match(/export\s+(?:const|function|class|interface|type)\s+(\w+)/)[1]
    exports.push({ name, type: 'named' })
  })
  
  // Default exports
  const defaultExport = content.match(/export\s+default\s+(\w+)/g)
  if (defaultExport) {
    exports.push({ name: 'default', type: 'default' })
  }
  
  return exports
}

function extractFunctions(content) {
  const functions = []
  const functionRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)[^{]*{/g
  const arrowFunctionRegex = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g
  
  let match
  while ((match = functionRegex.exec(content)) !== null) {
    const name = match[1]
    const signature = match[0]
    const params = extractFunctionParams(signature)
    functions.push({ name, signature, params, returnType: 'Unknown' })
  }
  
  while ((match = arrowFunctionRegex.exec(content)) !== null) {
    const name = match[1]
    const signature = match[0]
    const params = extractFunctionParams(signature)
    functions.push({ name, signature, params, returnType: 'Unknown' })
  }
  
  return functions
}

function extractFunctionParams(signature) {
  const paramMatch = signature.match(/\(([^)]*)\)/)
  if (!paramMatch) return []
  
  const params = paramMatch[1].split(',').map(p => p.trim()).filter(p => p)
  return params
}

function extractClasses(content) {
  const classes = []
  const classRegex = /(?:export\s+)?class\s+(\w+)[^{]*{([^}]*)}/g
  
  let match
  while ((match = classRegex.exec(content)) !== null) {
    const name = match[1]
    const body = match[2]
    const methods = extractClassMethods(body)
    const properties = extractClassProperties(body)
    classes.push({ name, methods, properties })
  }
  
  return classes
}

function extractClassMethods(classBody) {
  const methodRegex = /(?:public|private|protected)?\s*(\w+)\s*\([^)]*\)[^{]*{/g
  const methods = []
  let match
  
  while ((match = methodRegex.exec(classBody)) !== null) {
    methods.push(match[1])
  }
  
  return methods
}

function extractClassProperties(classBody) {
  const propertyRegex = /(?:public|private|protected)?\s*(\w+)\s*[:=]/g
  const properties = []
  let match
  
  while ((match = propertyRegex.exec(classBody)) !== null) {
    properties.push(match[1])
  }
  
  return properties
}

function extractInterfaces(content) {
  const interfaces = []
  const interfaceRegex = /(?:export\s+)?interface\s+(\w+)[^{]*{([^}]*)}/g
  
  let match
  while ((match = interfaceRegex.exec(content)) !== null) {
    const name = match[1]
    const definition = match[0]
    interfaces.push({ name, definition })
  }
  
  return interfaces
}

function extractTypes(content) {
  const types = []
  const typeRegex = /(?:export\s+)?type\s+(\w+)\s*=\s*([^;\n]+)/g
  
  let match
  while ((match = typeRegex.exec(content)) !== null) {
    const name = match[1]
    const definition = match[0]
    types.push({ name, definition })
  }
  
  return types
}

function extractConstants(content) {
  const constants = []
  const constantRegex = /(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=\s*([^;\n]+)/g
  
  let match
  while ((match = constantRegex.exec(content)) !== null) {
    const name = match[1]
    const definition = match[0]
    constants.push({ name, definition })
  }
  
  return constants
}

function extractJSDocComments(content) {
  const jsdocRegex = /\/\*\*\s*\n([^*]*(?:\*[^/][^*]*)*)\*\//g
  const comments = []
  
  let match
  while ((match = jsdocRegex.exec(content)) !== null) {
    comments.push(match[1].replace(/^\s*\*\s?/gm, '').trim())
  }
  
  return comments
}
