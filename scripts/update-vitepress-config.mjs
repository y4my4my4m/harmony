#!/usr/bin/env node

import { promises as fs } from 'fs'
import path from 'path'

const DOCS_API_DIR = 'docs/api'
const CONFIG_FILE = 'docs/.vitepress/config.ts'

console.log('🔄 Updating VitePress configuration with generated API docs...')

async function generateSidebarConfig() {
  const categories = await fs.readdir(DOCS_API_DIR, { withFileTypes: true })
  const apiSidebar = []

  for (const category of categories) {
    if (!category.isDirectory()) continue
    
    const categoryName = category.name
    const categoryPath = path.join(DOCS_API_DIR, categoryName)
    const files = await fs.readdir(categoryPath)
    
    const items = files
      .filter(file => file.endsWith('.md'))
      .sort()
      .map(file => {
        const name = path.basename(file, '.md')
        return {
          text: formatTitle(name),
          link: `/api/${categoryName}/${name}`
        }
      })

    if (items.length > 0) {
      apiSidebar.push({
        text: formatCategoryTitle(categoryName),
        collapsed: true,
        items
      })
    }
  }

  return apiSidebar
}

function formatTitle(filename) {
  // Convert filename to readable title
  return filename
    .split(/(?=[A-Z])/) // Split on capital letters
    .join(' ')
    .replace(/^./, str => str.toUpperCase()) // Capitalize first letter
    .replace(/([a-z])([A-Z])/g, '$1 $2') // Add space between camelCase
    .replace(/\b\w/g, l => l.toUpperCase()) // Capitalize each word
}

function formatCategoryTitle(category) {
  const titles = {
    'services': 'Core Services',
    'stores': 'Pinia Stores',
    'composables': 'Vue Composables',
    'types': 'Types & Interfaces',
    'utils': 'Utilities',
    'config': 'Configuration',
    'directives': 'Directives',
    'layouts': 'Layouts',
    'router': 'Router',
    'views': 'Views'
  }
  
  return titles[category] || category.charAt(0).toUpperCase() + category.slice(1)
}

async function updateVitePressConfig() {
  const configContent = await fs.readFile(CONFIG_FILE, 'utf-8')
  const apiSidebar = await generateSidebarConfig()
  
  // Create the sidebar configuration string
  const sidebarString = JSON.stringify(apiSidebar, null, 8)
    .replace(/"/g, "'")
    .replace(/'/g, "'")
  
  // Find and replace the '/api/': section
  const apiSectionRegex = /(\/api\/': \[[\s\S]*?\],)/
  const apiSectionMatch = configContent.match(apiSectionRegex)
  
  if (apiSectionMatch) {
    const newApiSection = `'/api/': [\n        {\n          text: 'Overview',\n          items: [\n            { text: 'API Reference', link: '/api/' }\n          ]\n        },\n        ...${sidebarString.replace(/^\[/, '').replace(/\]$/, '')}\n      ],`
    
    const updatedConfig = configContent.replace(apiSectionRegex, newApiSection)
    await fs.writeFile(CONFIG_FILE, updatedConfig)
    
    console.log('✅ VitePress configuration updated successfully!')
    console.log(`📊 Generated sidebar for ${apiSidebar.length} categories`)
  } else {
    console.log('⚠️  Could not find API sidebar section in config file')
  }
}

await updateVitePressConfig()
