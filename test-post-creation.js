#!/usr/bin/env node

// Quick test script to verify post creation works after the fixes
const { createClient } = require('@supabase/supabase-js')

const supabaseUrl = process.env.VITE_SUPABASE_URL || 'http://localhost:8000'
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || 'your-anon-key'

const supabase = createClient(supabaseUrl, supabaseKey)

async function testPostCreation() {
  console.log('🧪 Testing post creation with fixed schema...')
  
  try {
    // Test if posts table is accessible
    console.log('📋 Testing posts table access...')
    const { data: posts, error: postsError } = await supabase
      .from('posts')
      .select('id, author_id, content')
      .limit(1)
    
    if (postsError) {
      console.error('❌ Posts table access failed:', postsError.message)
      return
    }
    
    console.log('✅ Posts table accessible')
    
    // Test if profiles table is accessible  
    console.log('📋 Testing profiles table access...')
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles') 
      .select('id, username')
      .limit(1)
      
    if (profilesError) {
      console.error('❌ Profiles table access failed:', profilesError.message)
      return
    }
    
    console.log('✅ Profiles table accessible')
    console.log('✅ Basic database connectivity confirmed')
    
    // Note: Can't test authenticated operations without proper auth
    console.log('ℹ️ Full post creation test requires authenticated user session')
    
  } catch (error) {
    console.error('❌ Test failed:', error.message)
  }
}

testPostCreation()