# No Kong in this stack; nginx emits the CORS headers Kong supplies in a Supabase deployment.
# PostgREST and GoTrue each emit `Access-Control-Allow-Origin: *`. Duplicate values of that
# header are a hard CORS failure, so upstream headers are hidden and replaced, not added to.
# `*` is invalid for credentialed requests.
# `always` keeps the headers on 4xx/5xx; without it an auth failure surfaces as a CORS error.
proxy_hide_header Access-Control-Allow-Origin;
proxy_hide_header Access-Control-Allow-Credentials;
proxy_hide_header Access-Control-Allow-Methods;
proxy_hide_header Access-Control-Allow-Headers;
proxy_hide_header Access-Control-Expose-Headers;
proxy_hide_header Access-Control-Max-Age;

add_header Access-Control-Allow-Origin $http_origin always;
add_header Access-Control-Allow-Credentials true always;
add_header Access-Control-Allow-Methods 'GET, POST, PATCH, PUT, DELETE, OPTIONS' always;
add_header Access-Control-Allow-Headers 'authorization, apikey, content-type, x-client-info, accept, accept-profile, content-profile, prefer, range, x-supabase-api-version' always;
add_header Access-Control-Expose-Headers 'content-range, content-profile, content-location, range-unit, x-supabase-api-version' always;
add_header Access-Control-Max-Age 3600 always;
