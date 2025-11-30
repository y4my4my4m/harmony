#!/usr/bin/env node

import { promises as fs } from 'fs'
import path from 'path'

const CONFIG_FILE = 'docs/.vitepress/config.ts'
const COMPONENTS_DIR = 'docs/components'
const API_DIR = 'docs/api'

console.log('🔧 Syncing VitePress configuration with generated docs...')

// Category configuration
const API_CATEGORIES = {
  composables: { title: 'Vue Composables', collapsed: true },
  config: { title: 'Configuration', collapsed: true },
  directives: { title: 'Directives', collapsed: true },
  layouts: { title: 'Layouts', collapsed: true },
  router: { title: 'Router', collapsed: true },
  services: { 
    title: 'Services', 
    collapsed: true,
    subCategories: {
      'core': 'Core Services',
      'encryption': 'Encryption Services',
      'federation': 'Federation Services'
    }
  },
  stores: { title: 'Pinia Stores', collapsed: true },
  types: { title: 'Types & Interfaces', collapsed: true },
  utils: { title: 'Utilities', collapsed: true },
  views: { title: 'Views', collapsed: true }
}

const COMPONENT_CATEGORIES = {
  'Core Components': [],
  'Chat Components': [],
  'Server Management': [],
  'User Interface': [],
  'Media & Content': [],
  'Modals & Dialogs': [],
  'ActivityPub': [],
  'Voice & Video': [],
  'Settings': [],
  'Other Components': []
}

// ============== API Sidebar Generation ==============

async function scanApiDirectory() {
  const apiSidebar = [
    {
      text: 'Overview',
      items: [
        { text: 'API Reference', link: '/api/' }
      ]
    }
  ]

  for (const [category, config] of Object.entries(API_CATEGORIES)) {
    const categoryPath = path.join(API_DIR, category)
    
    try {
      const stat = await fs.stat(categoryPath)
      if (!stat.isDirectory()) continue
      
      const items = await scanCategoryDirectory(categoryPath, category, config)
      
      if (items.length > 0) {
        apiSidebar.push({
          text: config.title,
          collapsed: config.collapsed,
          items
        })
      }
    } catch (error) {
      // Category doesn't exist, skip
      continue
    }
  }

  return apiSidebar
}

async function scanCategoryDirectory(categoryPath, category, config) {
  const items = []
  const entries = await fs.readdir(categoryPath, { withFileTypes: true })
  
  // Separate files and directories
  const files = entries.filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md')
  const dirs = entries.filter(e => e.isDirectory())
  
  // Add regular files first
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.basename(file.name, '.md')
    items.push({
      text: formatTitle(name),
      link: `/api/${category}/${name}`
    })
  }
  
  // If there are subcategories defined, create nested structure
  if (config.subCategories && dirs.length > 0) {
    for (const dir of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
      const subCategoryTitle = config.subCategories[dir.name] || formatTitle(dir.name)
      const subItems = await scanSubDirectory(path.join(categoryPath, dir.name), category, dir.name)
      
      if (subItems.length > 0) {
        items.push({
          text: subCategoryTitle,
          collapsed: true,
          items: subItems
        })
      }
    }
  }
  
  return items
}

async function scanSubDirectory(dirPath, category, subDir) {
  const items = []
  
  try {
    const files = await fs.readdir(dirPath)
    const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'index.md').sort()
    
    for (const file of mdFiles) {
      const name = path.basename(file, '.md')
      items.push({
        text: formatTitle(name),
        link: `/api/${category}/${subDir}/${name}`
      })
    }
  } catch (error) {
    // Directory doesn't exist or error reading
  }
  
  return items
}

// ============== Component Sidebar Generation ==============

async function scanComponentFiles() {
  const componentsByCategory = JSON.parse(JSON.stringify(COMPONENT_CATEGORIES))
  
  try {
    await scanComponentDirectory(COMPONENTS_DIR, componentsByCategory)
    
    // Sort components within each category
    Object.keys(componentsByCategory).forEach(key => {
      componentsByCategory[key].sort((a, b) => a.title.localeCompare(b.title))
    })
    
    const totalComponents = Object.values(componentsByCategory).reduce((sum, arr) => sum + arr.length, 0)
    console.log(`📊 Found ${totalComponents} component files`)
    
    return componentsByCategory
    
  } catch (error) {
    console.log('⚠️  Components directory not found, skipping...')
    return {}
  }
}

async function scanComponentDirectory(dirPath, categories, prefix = '') {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Recursively scan subdirectories
      const subPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
      await scanComponentDirectory(path.join(dirPath, entry.name), categories, subPrefix)
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md' && entry.name !== 'generated-index.md') {
      const fileName = path.basename(entry.name, '.md')
      const title = formatTitle(fileName)
      const linkPath = prefix ? `/components/${prefix}/${fileName}` : `/components/${fileName}`
      
      const component = {
        title,
        link: linkPath,
        fileName
      }
      
      // Categorize based on filename and path patterns
      categorizeComponent(component, prefix, categories)
    }
  }
}

function categorizeComponent(component, prefix, categories) {
  const lowerName = component.fileName.toLowerCase()
  const lowerPrefix = prefix.toLowerCase()
  
  // Check prefix first for subdirectory-based categorization
  if (lowerPrefix.includes('activitypub')) {
    categories['ActivityPub'].push(component)
  } else if (lowerPrefix.includes('voice')) {
    categories['Voice & Video'].push(component)
  } else if (lowerPrefix.includes('settings')) {
    categories['Settings'].push(component)
  } else if (lowerPrefix.includes('chat')) {
    categories['Chat Components'].push(component)
  } else if (lowerName.includes('chat') || lowerName.includes('message') || lowerName.includes('richtext')) {
    categories['Chat Components'].push(component)
  } else if (lowerName.includes('server') || lowerName.includes('channel') || lowerName.includes('create')) {
    categories['Server Management'].push(component)
  } else if (lowerName.includes('user') || lowerName.includes('auth') || lowerName.includes('profile')) {
    categories['User Interface'].push(component)
  } else if (lowerName.includes('emoji') || lowerName.includes('file') || lowerName.includes('gif') || 
             lowerName.includes('markdown') || lowerName.includes('preview') || lowerName.includes('media')) {
    categories['Media & Content'].push(component)
  } else if (lowerName.includes('modal') || lowerName.includes('confirmation') || 
             lowerName.includes('invite') || lowerName.includes('context') || lowerName.includes('dialog')) {
    categories['Modals & Dialogs'].push(component)
  } else if (lowerName.includes('navigation') || lowerName.includes('sidebar') || 
             lowerName.includes('header') || lowerName.includes('main') || lowerName.includes('layout')) {
    categories['Core Components'].push(component)
  } else {
    categories['Other Components'].push(component)
  }
}

// ============== Config Generation ==============

function formatTitle(filename) {
  // Convert filename to readable title
  return filename
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase to spaces
    .replace(/[-_]/g, ' ') // Replace dashes and underscores
    .replace(/^./, str => str.toUpperCase()) // Capitalize first letter
    .replace(/\b\w/g, l => l.toUpperCase()) // Capitalize each word
    .trim()
}

function generateSidebarString(sidebar, indent = 8) {
  const spaces = ' '.repeat(indent)
  const innerSpaces = ' '.repeat(indent + 2)
  const itemSpaces = ' '.repeat(indent + 4)
  
  let result = '[\n'
  
  sidebar.forEach((section, sectionIndex) => {
    result += `${spaces}{\n`
    result += `${innerSpaces}text: '${section.text}',\n`
    
    if (section.collapsed !== undefined) {
      result += `${innerSpaces}collapsed: ${section.collapsed},\n`
    }
    
    result += `${innerSpaces}items: [\n`
    
    section.items.forEach((item, itemIndex) => {
      if (item.items) {
        // Nested group
        result += `${itemSpaces}{\n`
        result += `${itemSpaces}  text: '${item.text}',\n`
        if (item.collapsed !== undefined) {
          result += `${itemSpaces}  collapsed: ${item.collapsed},\n`
        }
        result += `${itemSpaces}  items: [\n`
        
        item.items.forEach((subItem, subIndex) => {
          const subComma = subIndex < item.items.length - 1 ? ',' : ''
          result += `${itemSpaces}    { text: '${subItem.text}', link: '${subItem.link}' }${subComma}\n`
        })
        
        result += `${itemSpaces}  ]\n`
        result += `${itemSpaces}}${itemIndex < section.items.length - 1 ? ',' : ''}\n`
      } else {
        // Regular item
        const comma = itemIndex < section.items.length - 1 ? ',' : ''
        result += `${itemSpaces}{ text: '${item.text}', link: '${item.link}' }${comma}\n`
      }
    })
    
    result += `${innerSpaces}]\n`
    result += `${spaces}}${sectionIndex < sidebar.length - 1 ? ',' : ''}\n`
  })
  
  result += `${' '.repeat(indent - 2)}]`
  
  return result
}

async function updateConfig() {
  // Generate API sidebar
  console.log('\n📂 Scanning API directory...')
  const apiSidebar = await scanApiDirectory()
  console.log(`   Found ${apiSidebar.length - 1} API categories`) // -1 for overview
  
  // Generate components sidebar
  console.log('\n📂 Scanning components directory...')
  const componentsByCategory = await scanComponentFiles()
  
  // Build components sidebar
  const componentsSidebar = [
    {
      text: 'Overview',
      items: [
        { text: 'Component Library', link: '/components/' }
      ]
    }
  ]
  
  Object.entries(componentsByCategory).forEach(([categoryName, components]) => {
    if (components.length > 0) {
      componentsSidebar.push({
        text: categoryName,
        collapsed: true,
        items: components.map(comp => ({
          text: comp.title,
          link: comp.link
        }))
      })
    }
  })
  
  // Read current config
  const configContent = await fs.readFile(CONFIG_FILE, 'utf-8')
  
  // Update API sidebar
  console.log('\n📝 Updating configuration...')
  let updatedConfig = configContent
  
  // Replace API sidebar
  const apiSidebarString = generateSidebarString(apiSidebar)
  const apiRegex = /('\/api\/'\s*:\s*)\[[\s\S]*?\](\s*,\s*\n\s*'\/components\/')/
  
  if (apiRegex.test(updatedConfig)) {
    updatedConfig = updatedConfig.replace(apiRegex, `$1${apiSidebarString}$2`)
    console.log('   ✅ API sidebar updated')
  } else {
    console.log('   ⚠️  Could not find API sidebar section')
  }
  
  // Replace components sidebar
  const componentsSidebarString = generateSidebarString(componentsSidebar)
  const componentsRegex = /('\/components\/'\s*:\s*)\[[\s\S]*?\](\s*,\s*\n\s*'\/flows\/')/
  
  if (componentsRegex.test(updatedConfig)) {
    updatedConfig = updatedConfig.replace(componentsRegex, `$1${componentsSidebarString}$2`)
    console.log('   ✅ Components sidebar updated')
  } else {
    console.log('   ⚠️  Could not find components sidebar section')
  }
  
  // Write updated config
  await fs.writeFile(CONFIG_FILE, updatedConfig)
  
  console.log('\n🎉 VitePress configuration sync complete!')
  
  // Print summary
  console.log('\n📊 Summary:')
  console.log(`   API categories: ${apiSidebar.length - 1}`)
  apiSidebar.slice(1).forEach(cat => {
    const count = cat.items.reduce((sum, item) => {
      return sum + (item.items ? item.items.length : 1)
    }, 0)
    console.log(`     - ${cat.text}: ${count} items`)
  })
  
  console.log(`   Component categories: ${Object.keys(componentsByCategory).filter(k => componentsByCategory[k].length > 0).length}`)
  Object.entries(componentsByCategory).forEach(([cat, items]) => {
    if (items.length > 0) {
      console.log(`     - ${cat}: ${items.length} components`)
    }
  })
}

await updateConfig()
