# OAuth Provider Configuration

This guide explains how to configure which OAuth providers are displayed on the login/register screens.

## Overview

The auth component automatically detects which OAuth providers are enabled and only displays those buttons. If no OAuth providers are enabled, the OAuth section and "or" divider are hidden entirely.

## Configuration Methods

### Method 1: Database Configuration (Recommended)

Store OAuth provider configuration in the `instance_config` table:

#### Option A: Array Format
```sql
-- Enable Google and GitHub only
INSERT INTO instance_config (config_key, config_value, description)
VALUES ('oauth_providers', '["google", "github"]'::jsonb, 'Enabled OAuth providers')
ON CONFLICT (config_key) 
DO UPDATE SET config_value = EXCLUDED.config_value;
```

#### Option B: Object Format (with true/false flags)
```sql
-- Enable Google and Twitch, disable GitHub
INSERT INTO instance_config (config_key, config_value, description)
VALUES ('oauth_providers', '{"google": true, "twitch": true, "github": false}'::jsonb, 'Enabled OAuth providers')
ON CONFLICT (config_key) 
DO UPDATE SET config_value = EXCLUDED.config_value;
```

#### Option C: Comma-separated String
```sql
-- Simple comma-separated list
INSERT INTO instance_config (config_key, config_value, description)
VALUES ('oauth_providers', '"google,twitch,github"'::jsonb, 'Enabled OAuth providers')
ON CONFLICT (config_key) 
DO UPDATE SET config_value = EXCLUDED.config_value;
```

### Method 2: Environment Variable

Add to your `.env` file:

```env
VITE_ENABLED_OAUTH_PROVIDERS=google,twitch,github
```

Or for only Google:
```env
VITE_ENABLED_OAUTH_PROVIDERS=google
```

### Method 3: Default Behavior

If no configuration is found, **all available providers are shown** by default:
- Google
- Twitch  
- GitHub

## Available Provider IDs

- `google` - Google OAuth
- `twitch` - Twitch OAuth
- `github` - GitHub OAuth

## Examples

### Enable Only Google
```sql
INSERT INTO instance_config (config_key, config_value, description)
VALUES ('oauth_providers', '["google"]'::jsonb, 'Enabled OAuth providers')
ON CONFLICT (config_key) 
DO UPDATE SET config_value = EXCLUDED.config_value;
```

### Enable Google and Twitch
```sql
INSERT INTO instance_config (config_key, config_value, description)
VALUES ('oauth_providers', '["google", "twitch"]'::jsonb, 'Enabled OAuth providers')
ON CONFLICT (config_key) 
DO UPDATE SET config_value = EXCLUDED.config_value;
```

### Disable All OAuth (Show Only Email/Password)
```sql
INSERT INTO instance_config (config_key, config_value, description)
VALUES ('oauth_providers', '[]'::jsonb, 'Enabled OAuth providers')
ON CONFLICT (config_key) 
DO UPDATE SET config_value = EXCLUDED.config_value;
```

## Important Notes

1. **Provider IDs are case-insensitive** - `"Google"`, `"google"`, and `"GOOGLE"` all work
2. **The "or" divider is automatically hidden** if no OAuth providers are enabled
3. **Configuration is checked on page load** - changes require a page refresh
4. **This only controls UI display** - you must still configure OAuth in Supabase for the buttons to actually work

## Admin Panel Integration

You can also manage OAuth providers through the Admin Panel (if you add UI for it):

```typescript
// In AdminPanel.vue or similar
await adminService.setInstanceConfig(
  'oauth_providers',
  ['google', 'github'], // or { google: true, twitch: false, github: true }
  adminUserId
)
```

## Troubleshooting

### All providers showing when they shouldn't
- Check that `oauth_providers` config exists in `instance_config` table
- Verify the JSON format is correct
- Check browser console for parsing errors

### No providers showing
- Verify at least one provider ID matches the available providers
- Check that provider IDs are spelled correctly
- Ensure the config value is valid JSON

### Providers not working
- Remember: This config only controls **display**. You must still:
  1. Configure OAuth in Supabase (Studio or environment variables)
  2. Set up OAuth apps with the providers (Google Cloud, Twitch Dev, GitHub)
  3. Add correct redirect URIs in provider settings

