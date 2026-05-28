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
await fs.mkdir(`${DOCS_API_DIR}/services/core`, { recursive: true })
await fs.mkdir(`${DOCS_API_DIR}/services/encryption`, { recursive: true })
await fs.mkdir(`${DOCS_API_DIR}/services/federation`, { recursive: true })
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

// Track all generated files for summary
const generatedFiles = {
  services: [],
  stores: [],
  composables: [],
  types: [],
  utils: [],
  config: [],
  directives: [],
  layouts: [],
  router: [],
  views: []
}

// Process all directories
await processDirectory(SERVICES_DIR, 'services', 'Service', generatedFiles.services)
await processDirectory(STORES_DIR, 'stores', 'Store', generatedFiles.stores)
await processDirectory(COMPOSABLES_DIR, 'composables', 'Composable', generatedFiles.composables)
await processDirectory(TYPES_DIR, 'types', 'Types', generatedFiles.types)
await processDirectory(UTILS_DIR, 'utils', 'Utility', generatedFiles.utils)
await processDirectory(CONFIG_DIR, 'config', 'Configuration', generatedFiles.config)
await processDirectory(DIRECTIVES_DIR, 'directives', 'Directive', generatedFiles.directives)
await processDirectory(LAYOUTS_DIR, 'layouts', 'Layout', generatedFiles.layouts)
await processDirectory(ROUTER_DIR, 'router', 'Router', generatedFiles.router)
await processDirectory(VIEWS_DIR, 'views', 'View', generatedFiles.views)

// Generate API index with all files
await generateApiIndex(generatedFiles)

console.log('\n✅ API documentation generation complete!')
console.log('\n📊 Summary:')
Object.entries(generatedFiles).forEach(([category, files]) => {
  if (files.length > 0) {
    console.log(`   ${category}: ${files.length} files`)
  }
})

async function processDirectory(sourceDir, category, suffix, fileList) {
  try {
    // Use recursive glob to find all .ts, .js, and .vue files
    const files = await glob(`${sourceDir}/**/*.{ts,js,vue}`, {
      ignore: ['**/*.node-only', '**/*.legacy', '**/*.d.ts', '**/*.spec.ts', '**/*.test.ts']
    })
    
    if (files.length === 0) {
      console.log(`⚠️  No files found in ${sourceDir}`)
      return
    }
    
    console.log(`\n📁 Processing ${category}: ${files.length} files`)
    
    for (const filePath of files) {
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        const fileName = path.basename(filePath, path.extname(filePath))
        
        // Skip index files with only re-exports
        if (fileName === 'index' && content.split('\n').length < 50) {
          const hasOnlyExports = content.split('\n').every(line => 
            line.trim() === '' || 
            line.startsWith('export') || 
            line.startsWith('//') || 
            line.startsWith('/*') ||
            line.startsWith('*') ||
            line.startsWith('import')
          )
          if (hasOnlyExports) {
            console.log(`  ⏭️  Skipping index file: ${filePath}`)
            continue
          }
        }
        
        // Calculate relative path from source dir to maintain directory structure
        const relativePath = path.relative(sourceDir, filePath)
        const relativeDir = path.dirname(relativePath)
        const isNested = relativeDir !== '.'
        
        let outputSubDir = ''
        if (isNested) {
          outputSubDir = relativeDir.replace(/\\/g, '/')
          await fs.mkdir(path.join(DOCS_API_DIR, category, outputSubDir), { recursive: true })
        }
        
        const markdown = await generateApiMarkdown(content, fileName, filePath, suffix, outputSubDir)
        
        // Build output path
        const docFileName = `${fileName.toLowerCase()}.md`
        const docPath = isNested 
          ? path.join(DOCS_API_DIR, category, outputSubDir, docFileName)
          : path.join(DOCS_API_DIR, category, docFileName)
        
        await fs.writeFile(docPath, markdown)
        
        // Track the file with its relative path
        const linkPath = isNested 
          ? `${category}/${outputSubDir}/${fileName.toLowerCase()}`
          : `${category}/${fileName.toLowerCase()}`
        
        fileList.push({
          name: fileName,
          path: linkPath,
          subDir: outputSubDir,
          filePath: filePath
        })
        
        console.log(`  ✅ Generated: ${isNested ? `${outputSubDir}/` : ''}${fileName}`)
      } catch (error) {
        console.error(`  ❌ Error processing ${filePath}:`, error.message)
      }
    }
  } catch (error) {
    console.log(`⚠️  Directory ${sourceDir} not found or error: ${error.message}`)
  }
}

// Escape angle brackets for markdown (to prevent Vue template parsing)
function escapeAngleBrackets(text) {
  if (!text) return text
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function generateApiMarkdown(content, fileName, filePath, suffix, subDir) {
  const exports = extractExports(content)
  const functions = extractFunctions(content)
  const classes = extractClasses(content)
  const interfaces = extractInterfaces(content)
  const types = extractTypes(content)
  const constants = extractConstants(content)
  const vueComponent = filePath.endsWith('.vue') ? extractVueComponent(content) : null
  
  // Deduplicate exports for mermaid diagram
  const uniqueExports = [...new Map(exports.map(exp => [exp.name, exp])).values()]
  
  // Build title with subdirectory context
  const titlePrefix = subDir ? `${subDir}/` : ''
  const title = `${titlePrefix}${fileName} ${suffix}`
  
  // Generate mermaid diagram with proper escaping and deduplication
  const mermaidDiagram = generateMermaidDiagram(fileName, suffix, uniqueExports, functions, interfaces, classes)
  
  return `# ${title}

**File:** \`${filePath}\`

## Overview

${mermaidDiagram}

${exports.length > 0 ? `## Exports

${uniqueExports.map(exp => `- **${exp.name}** - ${exp.description || exp.type + ' export'}`).join('\n')}` : ''}

${functions.length > 0 ? `## Functions

${functions.map(fn => `### \`${escapeAngleBrackets(fn.name)}(${fn.params.map(p => escapeAngleBrackets(p)).join(', ')})\`

${fn.description || 'No description available.'}

**Parameters:**
${fn.params.length > 0 ? fn.params.map(param => `- \`${escapeAngleBrackets(param)}\``).join('\n') : 'None'}

**Returns:** \`${escapeAngleBrackets(fn.returnType) || 'Unknown'}\`

\`\`\`typescript
${fn.signature}
\`\`\`
`).join('\n')}` : ''}

${classes.length > 0 ? `## Classes

${classes.map(cls => `### ${cls.name}

${cls.description || 'No description available.'}

${cls.methods.length > 0 ? `**Methods:**
${cls.methods.map(method => `- \`${method}\``).join('\n')}` : ''}

${cls.properties.length > 0 ? `**Properties:**
${cls.properties.map(prop => `- \`${prop}\``).join('\n')}` : ''}
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

${vueComponent ? `## Vue Component

This is a Vue component file.

${vueComponent.props.length > 0 ? `### Props
${vueComponent.props.map(p => `- \`${p}\``).join('\n')}` : ''}

${vueComponent.emits.length > 0 ? `### Emits
${vueComponent.emits.map(e => `- \`${e}\``).join('\n')}` : ''}
` : ''}

## Source Code Insights

**File Size:** ${content.length} characters
**Lines of Code:** ${content.split('\n').length}
**Imports:** ${(content.match(/^import .+$/gm) || []).length}

## Usage Example

\`\`\`typescript
import { ${uniqueExports.map(exp => exp.name).join(', ') || fileName} } from '${filePath.replace('src/', '@/').replace(/\.(ts|js|vue)$/, '')}'

// Example usage
${functions.length > 0 ? functions[0].name + '()' : '// Use the exported functionality'}
\`\`\`

---

*This documentation was automatically generated from the source code.*`
}

function generateMermaidDiagram(fileName, suffix, exports, functions, interfaces, classes) {
  // Sanitize names for mermaid (replace special chars, limit length)
  const sanitize = (name) => name.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30)
  
  const hasContent = exports.length > 0 || functions.length > 0 || interfaces.length > 0 || classes.length > 0
  
  if (!hasContent) {
    return `\`\`\`mermaid
graph TB
    MODULE[${sanitize(fileName)} ${suffix}]
\`\`\`
`
  }
  
  let diagram = `\`\`\`mermaid
graph TB
    subgraph "${fileName} ${suffix}"
`
  
  // Add exports (deduplicated)
  const seenExports = new Set()
  exports.forEach(exp => {
    if (!seenExports.has(exp.name)) {
      seenExports.add(exp.name)
      diagram += `        ${sanitize(exp.name).toUpperCase()}[${exp.name}]\n`
    }
  })
  
  diagram += `    end\n`
  
  // Add functions subgraph if there are any
  if (functions.length > 0) {
    diagram += `    
    subgraph "Functions"
`
    const seenFunctions = new Set()
    functions.forEach(fn => {
      if (!seenFunctions.has(fn.name)) {
        seenFunctions.add(fn.name)
        diagram += `        FN_${sanitize(fn.name).toUpperCase()}[${fn.name}]\n`
      }
    })
    diagram += `    end\n`
  }
  
  // Add interfaces subgraph if there are any
  if (interfaces.length > 0) {
    diagram += `    
    subgraph "Interfaces"
`
    const seenInterfaces = new Set()
    interfaces.forEach(int => {
      if (!seenInterfaces.has(int.name)) {
        seenInterfaces.add(int.name)
        diagram += `        INT_${sanitize(int.name).toUpperCase()}[${int.name}]\n`
      }
    })
    diagram += `    end\n`
  }
  
  // Add classes subgraph if there are any
  if (classes.length > 0) {
    diagram += `    
    subgraph "Classes"
`
    const seenClasses = new Set()
    classes.forEach(cls => {
      if (!seenClasses.has(cls.name)) {
        seenClasses.add(cls.name)
        diagram += `        CLS_${sanitize(cls.name).toUpperCase()}[${cls.name}]\n`
      }
    })
    diagram += `    end\n`
  }
  
  diagram += `\`\`\`
`
  
  return diagram
}

function extractExports(content) {
  const exports = []
  const seen = new Set()
  
  // Named exports: export const/function/class/interface/type
  const namedExportRegex = /export\s+(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g
  let match
  while ((match = namedExportRegex.exec(content)) !== null) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      const type = match[0].includes('function') ? 'function' :
                   match[0].includes('class') ? 'class' :
                   match[0].includes('interface') ? 'interface' :
                   match[0].includes('type') ? 'type' :
                   match[0].includes('enum') ? 'enum' : 'const'
      exports.push({ name, type })
    }
  }
  
  // Default exports
  const defaultExportRegex = /export\s+default\s+(?:class|function|async function)?\s*(\w+)?/g
  while ((match = defaultExportRegex.exec(content)) !== null) {
    const name = match[1] || 'default'
    if (!seen.has(name)) {
      seen.add(name)
      exports.push({ name, type: 'default' })
    }
  }
  
  return exports
}

function extractFunctions(content) {
  const functions = []
  const seen = new Set()
  
  // Regular function declarations
  const functionRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/g
  let match
  while ((match = functionRegex.exec(content)) !== null) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      const signature = match[0].replace(/\s*\{$/, '')
      const params = extractFunctionParams(match[2])
      const returnType = match[3]?.trim() || 'void'
      functions.push({ name, signature, params, returnType })
    }
  }
  
  // Arrow function exports
  const arrowFunctionRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)(?:\s*:\s*([^=]+))?\s*=>/g
  while ((match = arrowFunctionRegex.exec(content)) !== null) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      const signature = match[0]
      const params = extractFunctionParams(match[2])
      const returnType = match[3]?.trim() || 'Unknown'
      functions.push({ name, signature, params, returnType })
    }
  }
  
  return functions
}

function extractFunctionParams(paramString) {
  if (!paramString || !paramString.trim()) return []
  
  // Handle complex parameter patterns with type annotations
  const params = []
  let depth = 0
  let current = ''
  
  for (const char of paramString) {
    if (char === '(' || char === '<' || char === '{' || char === '[') {
      depth++
      current += char
    } else if (char === ')' || char === '>' || char === '}' || char === ']') {
      depth--
      current += char
    } else if (char === ',' && depth === 0) {
      if (current.trim()) {
        params.push(current.trim())
      }
      current = ''
    } else {
      current += char
    }
  }
  
  if (current.trim()) {
    params.push(current.trim())
  }
  
  return params
}

function extractClasses(content) {
  const classes = []
  const seen = new Set()
  
  // Match class declarations with their full body
  const classRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/g
  let match
  
  while ((match = classRegex.exec(content)) !== null) {
    const name = match[1]
    if (seen.has(name)) continue
    seen.add(name)
    
    // Find the class body by matching braces
    const startIndex = match.index + match[0].length - 1
    const classBody = extractBracedContent(content, startIndex)
    
    const methods = extractClassMethods(classBody)
    const properties = extractClassProperties(classBody)
    
    classes.push({ name, methods, properties })
  }
  
  return classes
}

function extractBracedContent(content, startIndex) {
  let depth = 0
  let start = -1
  
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === '{') {
      if (depth === 0) start = i + 1
      depth++
    } else if (content[i] === '}') {
      depth--
      if (depth === 0) {
        return content.substring(start, i)
      }
    }
  }
  
  return ''
}

function extractClassMethods(classBody) {
  const methods = []
  const seen = new Set()
  
  // Match method declarations
  const methodRegex = /(?:public|private|protected|static|async|\s)+(\w+)\s*\([^)]*\)(?:\s*:\s*[^{]+)?\s*\{/g
  let match
  
  while ((match = methodRegex.exec(classBody)) !== null) {
    const name = match[1]
    if (!seen.has(name) && name !== 'constructor' && name !== 'if' && name !== 'for' && name !== 'while') {
      seen.add(name)
      methods.push(name)
    }
  }
  
  // Also capture constructor
  if (classBody.includes('constructor')) {
    methods.unshift('constructor')
  }
  
  return methods
}

function extractClassProperties(classBody) {
  const properties = []
  const seen = new Set()
  
  // Match property declarations
  const propertyRegex = /(?:public|private|protected|readonly|static|\s)+(\w+)(?:\?)?(?:\s*:\s*[^=;\n]+)?(?:\s*=\s*[^;\n]+)?[;\n]/g
  let match
  
  while ((match = propertyRegex.exec(classBody)) !== null) {
    const name = match[1]
    // Filter out keywords and common false positives
    if (!seen.has(name) && 
        !['constructor', 'return', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'function', 'class', 'new', 'this'].includes(name)) {
      seen.add(name)
      properties.push(name)
    }
  }
  
  return properties
}

function extractInterfaces(content) {
  const interfaces = []
  const seen = new Set()
  
  const interfaceRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[\w,\s<>]+)?\s*\{/g
  let match
  
  while ((match = interfaceRegex.exec(content)) !== null) {
    const name = match[1]
    if (seen.has(name)) continue
    seen.add(name)
    
    const startIndex = match.index + match[0].length - 1
    const body = extractBracedContent(content, startIndex)
    const definition = `interface ${name} {\n${body.substring(0, 500)}${body.length > 500 ? '\n  // ...' : ''}\n}`
    
    interfaces.push({ name, definition })
  }
  
  return interfaces
}

function extractTypes(content) {
  const types = []
  const seen = new Set()
  
  const typeRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?type\s+(\w+)(?:<[^>]+>)?\s*=\s*([^;]+);/g
  let match
  
  while ((match = typeRegex.exec(content)) !== null) {
    const name = match[1]
    if (seen.has(name)) continue
    seen.add(name)
    
    const definition = match[0].substring(0, 500) + (match[0].length > 500 ? '...' : '')
    types.push({ name, definition })
  }
  
  return types
}

function extractConstants(content) {
  const constants = []
  const seen = new Set()
  
  // Match UPPER_CASE constants
  const constantRegex = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?\s*=\s*([^;\n]+)/g
  let match
  
  while ((match = constantRegex.exec(content)) !== null) {
    const name = match[1]
    if (seen.has(name)) continue
    seen.add(name)
    
    const definition = match[0].substring(0, 200) + (match[0].length > 200 ? '...' : '')
    constants.push({ name, definition })
  }
  
  return constants
}

function extractVueComponent(content) {
  const props = []
  const emits = []
  
  // Extract defineProps
  const propsMatch = content.match(/defineProps(?:<([^>]+)>)?\s*\(\s*(?:\{([^}]+)\}|\[([^\]]+)\])?\s*\)/s)
  if (propsMatch) {
    const propsContent = propsMatch[1] || propsMatch[2] || propsMatch[3] || ''
    const propNames = propsContent.match(/(\w+)(?:\s*[?:])/g) || []
    props.push(...propNames.map(p => p.replace(/[?:]/g, '').trim()))
  }
  
  // Extract defineEmits
  const emitsMatch = content.match(/defineEmits(?:<([^>]+)>)?\s*\(\s*(?:\[([^\]]+)\])?\s*\)/s)
  if (emitsMatch) {
    const emitsContent = emitsMatch[1] || emitsMatch[2] || ''
    const emitNames = emitsContent.match(/'([^']+)'/g) || []
    emits.push(...emitNames.map(e => e.replace(/'/g, '')))
  }
  
  return { props, emits }
}

async function generateApiIndex(generatedFiles) {
  const indexContent = `# API Reference

Welcome to the Harmony API documentation. This documentation is automatically generated from the source code.

## Overview

\`\`\`mermaid
graph TB
    subgraph "Frontend Architecture"
        COMPOSABLES[Composables]
        STORES[Pinia Stores]
        SERVICES[Services]
        UTILS[Utilities]
    end
    
    subgraph "UI Layer"
        VIEWS[Views]
        LAYOUTS[Layouts]
    end
    
    subgraph "Supporting"
        CONFIG[Configuration]
        TYPES[Types]
        DIRECTIVES[Directives]
        ROUTER[Router]
    end
    
    VIEWS --> COMPOSABLES
    VIEWS --> STORES
    COMPOSABLES --> SERVICES
    STORES --> SERVICES
    SERVICES --> UTILS
\`\`\`

## Categories

${Object.entries(generatedFiles).map(([category, files]) => {
  if (files.length === 0) return ''
  
  const categoryTitles = {
    services: 'Services',
    stores: 'Pinia Stores',
    composables: 'Vue Composables',
    types: 'Types & Interfaces',
    utils: 'Utilities',
    config: 'Configuration',
    directives: 'Directives',
    layouts: 'Layouts',
    router: 'Router',
    views: 'Views'
  }
  
  return `### ${categoryTitles[category] || category}

${files.length} files documented.

${files.map(f => `- [${f.name}](/api/${f.path})`).join('\n')}
`
}).filter(Boolean).join('\n')}

---

*Last generated: ${new Date().toISOString()}*
`

  await fs.writeFile(path.join(DOCS_API_DIR, 'index.md'), indexContent)
  console.log('\n📄 Generated API index')
}
