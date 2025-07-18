#!/bin/bash

# Test script for the emoji API endpoint
# Usage: ./test-emoji-api.sh [emoji_id]

EMOJI_ID=${1:-"0231b736-3acb-4812-8823-0b6be44907d5"}
BASE_URL="http://localhost:5173"

echo "Testing emoji API endpoint..."
echo "URL: ${BASE_URL}/emojis/${EMOJI_ID}"
echo ""

curl -X GET \
  -H "Accept: application/activity+json" \
  -H "Content-Type: application/activity+json" \
  "${BASE_URL}/emojis/${EMOJI_ID}" \
  | jq . || echo "Error: Make sure jq is installed for pretty JSON formatting"

echo ""
echo "Test completed."
