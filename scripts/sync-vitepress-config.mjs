#!/usr/bin/env node

import { promises as fs } from 'fs'
import path from 'path'

const CONFIG_FILE = 'docs/.vitepress/config.ts'
const COMPONENTS_DIR = 'docs/components'

console.log('🔧 Syncing VitePress configuration with generated component docs...')

async function scanComponentFiles() {
  const componentsByCategory = {
    'Core Components': [],
    'Chat Components': [],
    'Server Management': [],
    'User Interface': [],
    'Media & Content': [],
    'Modals & Dialogs': [],
    'Other Components': []
  }
  
  try {
    const files = await fs.readdir(COMPONENTS_DIR)
    const mdFiles = files.filter(file => file.endsWith('.md') && file !== 'index.md')
    
    for (const file of mdFiles) {
      const fileName = path.basename(file, '.md')
      const title = fileName
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^./, str => str.toUpperCase())
      
      const component = {
        title,
        link: `/components/${fileName}`,
        fileName
      }
      
      // Categorize based on filename patterns
      const lowerName = fileName.toLowerCase()
      
      if (lowerName.includes('chat') || lowerName.includes('message') || lowerName.includes('richtext')) {
        componentsByCategory['Chat Components'].push(component)
      } else if (lowerName.includes('server') || lowerName.includes('channel') || lowerName.includes('create')) {
        componentsByCategory['Server Management'].push(component)
      } else if (lowerName.includes('user') || lowerName.includes('auth') || lowerName.includes('profile')) {
        componentsByCategory['User Interface'].push(component)
      } else if (lowerName.includes('emoji') || lowerName.includes('file') || lowerName.includes('gif') || 
                 lowerName.includes('markdown') || lowerName.includes('preview')) {
        componentsByCategory['Media & Content'].push(component)
      } else if (lowerName.includes('modal') || lowerName.includes('confirmation') || 
                 lowerName.includes('invite') || lowerName.includes('context')) {
        componentsByCategory['Modals & Dialogs'].push(component)
      } else if (lowerName.includes('navigation') || lowerName.includes('sidebar') || 
                 lowerName.includes('header') || lowerName.includes('main')) {
        componentsByCategory['Core Components'].push(component)
      } else {
        componentsByCategory['Other Components'].push(component)
      }
    }
    
    // Sort components within each category
    Object.keys(componentsByCategory).forEach(key => {
      componentsByCategory[key].sort((a, b) => a.title.localeCompare(b.title))
    })
    
    const totalComponents = Object.values(componentsByCategory).reduce((sum, arr) => sum + arr.length, 0)
    console.log(`📊 Found ${totalComponents} component files categorized into ${Object.keys(componentsByCategory).filter(key => componentsByCategory[key].length > 0).length} categories`)
    
    return componentsByCategory
    
  } catch (error) {
    console.log('⚠️  Components directory not found, skipping...')
    return {}
  }
}

async function updateComponentsSection() {
  const componentsByCategory = await scanComponentFiles()
  
  if (Object.keys(componentsByCategory).length === 0) {
    console.log('⚠️  No component files found')
    return
  }
  
  // Build the new components section
  const componentsSection = [
    '        {',
    '          text: \'Overview\',',
    '          items: [',
    '            { text: \'Component Library\', link: \'/components/\' }',
    '          ]',
    '        }'
  ]
  
  // Add each category that has components
  Object.entries(componentsByCategory).forEach(([categoryName, components]) => {
    if (components.length > 0) {
      componentsSection.push(',')
      componentsSection.push('        {')
      componentsSection.push(`          text: '${categoryName}',`)
      componentsSection.push('          collapsed: true,')
      componentsSection.push('          items: [')
      
      components.forEach((comp, index) => {
        const comma = index < components.length - 1 ? ',' : ''
        componentsSection.push(`            { text: '${comp.title}', link: '${comp.link}' }${comma}`)
      })
      
      componentsSection.push('          ]')
      componentsSection.push('        }')
    }
  })
  
  const newComponentsConfig = componentsSection.join('\n')
  
  // Read the current config
  const configContent = await fs.readFile(CONFIG_FILE, 'utf-8')
  
  // Find and replace the '/components/': section
  const componentsRegex = /(\/components\/': \[[\s\S]*?\]),/
  const match = configContent.match(componentsRegex)
  
  if (match) {
    const newSection = `/components/': [\n${newComponentsConfig}\n      ],`
    const updatedConfig = configContent.replace(componentsRegex, newSection)
    
    await fs.writeFile(CONFIG_FILE, updatedConfig)
    console.log('✅ Components section updated successfully!')
    
    // Log categorization summary
    Object.entries(componentsByCategory).forEach(([categoryName, components]) => {
      if (components.length > 0) {
        console.log(`   📁 ${categoryName}: ${components.length} components`)
      }
    })
    
  } else {
    console.log('⚠️  Could not find components section in config')
    console.log('Current config structure:')
    // Debug: show what we're looking for
    const lines = configContent.split('\n')
    lines.forEach((line, i) => {
      if (line.includes("'/components/'")) {
        console.log(`Line ${i + 1}: ${line}`)
      }
    })
  }
}

await updateComponentsSection()
console.log('🎉 VitePress components configuration sync complete!')
