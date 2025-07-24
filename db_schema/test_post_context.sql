-- Test script for the new post context unification
-- Run this after applying post_context_unification.sql

-- Test 1: Get a post in minimal context (just the post itself)
SELECT 'Test 1: Minimal Context' as test_name;
-- Replace 'your-post-id-here' with an actual post ID from your database
SELECT get_post_with_context('0b0b7fc6-342f-479b-9461-fc53bebad2db'::uuid, '67750a0f-7514-43ed-a5ed-89ac873a08f0'::uuid, 'minimal');

-- Test 2: Get a post with full thread context
SELECT 'Test 2: Full Thread Context' as test_name;
SELECT get_post_with_context('0b0b7fc6-342f-479b-9461-fc53bebad2db'::uuid, '67750a0f-7514-43ed-a5ed-89ac873a08f0'::uuid, 'thread');

-- Test 3: Get ancestors only (posts this is replying to)
SELECT 'Test 3: Ancestors Only' as test_name;
SELECT get_post_with_context('0b0b7fc6-342f-479b-9461-fc53bebad2db'::uuid, '67750a0f-7514-43ed-a5ed-89ac873a08f0'::uuid, 'ancestors');

-- Test 4: Get descendants only (replies to this post)
SELECT 'Test 4: Descendants Only' as test_name;
SELECT get_post_with_context('0b0b7fc6-342f-479b-9461-fc53bebad2db'::uuid, '67750a0f-7514-43ed-a5ed-89ac873a08f0'::uuid, 'descendants');
-- SELECT get_post_with_context('your-post-id-here'::uuid, 'your-user-id-here'::uuid, 'descendants');

-- Test 5: Test with highlight and max depth
SELECT 'Test 5: With Highlight and Max Depth' as test_name;
-- SELECT get_post_with_context('your-post-id-here'::uuid, 'your-user-id-here'::uuid, 'thread', 'reply-id-to-highlight'::uuid, 5);

-- Test 6: Test error handling with non-existent post
SELECT 'Test 6: Error Handling' as test_name;
SELECT get_post_with_context('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'minimal');
