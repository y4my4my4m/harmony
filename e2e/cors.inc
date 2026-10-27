# No Kong in this stack; nginx emits the CORS headers Kong supplies in a Supabase deployment.
# PostgREST and GoTrue each emit `Access-Control-Allow-Origin: *`. Duplicate values of that
# header are a hard CORS failure, so upstream headers are hidden and replaced, not added to.
# `*` is invalid for credentialed requests.
# `always` keeps the headers on 4xx/5xx; without it an auth failure surfaces as a CORS error.
# The tus headers are storage's resumable uploads (/storage/v1/upload/resumable): a page reads
# Location after creation and Upload-Offset after PATCH and HEAD, which @tus/server exposes
# upstream and Kong passes through.
proxy_hide_header Access-Control-Allow-Origin;
proxy_hide_header Access-Control-Allow-Credentials;
proxy_hide_header Access-Control-Allow-Methods;
proxy_hide_header Access-Control-Allow-Headers;
proxy_hide_header Access-Control-Expose-Headers;
proxy_hide_header Access-Control-Max-Age;

add_header Access-Control-Allow-Origin $http_origin always;
add_header Access-Control-Allow-Credentials true always;
add_header Access-Control-Allow-Methods 'GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS' always;
add_header Access-Control-Allow-Headers 'authorization, apikey, content-type, x-client-info, accept, accept-profile, content-profile, prefer, range, x-supabase-api-version, x-upsert, cache-control, x-metadata, tus-resumable, upload-length, upload-offset, upload-metadata, upload-defer-length, upload-concat, x-signature' always;
add_header Access-Control-Expose-Headers 'content-range, content-profile, content-location, range-unit, x-supabase-api-version, location, upload-offset, upload-length, upload-expires, tus-resumable, tus-version, tus-max-size, tus-extension' always;
add_header Access-Control-Max-Age 3600 always;
