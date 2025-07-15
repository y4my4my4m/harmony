#!/bin/bash

# Federation Test Script
# Tests the mention extraction and federation functionality

echo "🧪 Testing Federation Mention Processing"
echo "========================================"

# Test 1: Check if mention utilities work
echo ""
echo "📋 Test 1: Mention Extraction"
echo "Testing with: '@tester004@mastodon.social hey there!'"

# You can run this in browser console:
cat << 'EOF'
// Run this in browser console to test mention extraction:
import { extractMentions } from '/src/utils/mentionUtils.ts';
const mentions = extractMentions('@tester004@mastodon.social hey there!');
console.log('Extracted mentions:', mentions);
EOF

echo ""
echo "📡 Test 2: WebFinger Resolution"
echo "Testing WebFinger lookup for mastodon.social user"

# Test WebFinger lookup
curl -s -H "Accept: application/jrd+json" \
  "https://mastodon.social/.well-known/webfinger?resource=acct:tester004@mastodon.social" \
  | jq '.' || echo "WebFinger test failed or jq not installed"

echo ""
echo "📬 Test 3: Database Check"
echo "Check for remote users in database:"

# Note: This requires database access
cat << 'EOF'
-- Run this SQL query in your Supabase dashboard:
SELECT username, domain, is_local, federated_id, inbox_url 
FROM profiles 
WHERE is_local = false 
ORDER BY created_at DESC 
LIMIT 5;
EOF

echo ""
echo "🚀 Test 4: Manual Federation Test"
echo "To test federation:"
echo "1. Create a post with: '@tester004@mastodon.social hey there!'"
echo "2. Check browser console for federation logs"
echo "3. Check database for new remote user entries"
echo "4. Monitor network tab for outbound HTTP requests"

echo ""
echo "🔍 Expected Results:"
echo "- Console should show mention extraction logs"
echo "- New remote user should appear in database"
echo "- HTTP POST to tester004's inbox on mastodon.social"
echo "- ActivityPub Create activity in request body"

echo ""
echo "💡 Debugging Tips:"
echo "- Check browser dev tools console for logs"
echo "- Monitor Network tab for federation requests"
echo "- Check Supabase logs for edge function activity"
echo "- Verify nginx is routing /users/ correctly"
