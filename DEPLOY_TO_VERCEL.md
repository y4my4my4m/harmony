# Deploy Harmony to Vercel

## One-Click Deployment

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyour-username%2Fharmony&env=SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY,INSTANCE_DOMAIN,INSTANCE_NAME&project-name=harmony&repository-name=harmony)

## Manual Setup

### 1. Prerequisites

- Vercel account
- Supabase project (free tier works)
- Custom domain (optional)

### 2. Fork the Repository

Fork this repository to your GitHub account.

### 3. Create Supabase Project

1. Go to [supabase.com](https://supabase.com)
2. Create a new project
3. Note your project URL and keys
4. Import the schema from `harmonious/supabase_schema_backup_latest.sql`

### 4. Deploy to Vercel

1. Click "New Project" in Vercel
2. Import your forked repository
3. Configure environment variables (see below)
4. Deploy!

### 5. Environment Variables

Required variables in Vercel:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
INSTANCE_DOMAIN=yourdomain.com
INSTANCE_NAME=Harmony
INSTANCE_DESCRIPTION=A federated social platform
CORS_ORIGIN=https://yourdomain.com
NODE_ENV=production
```

### 6. Add Custom Domain

1. Go to your Vercel project settings
2. Navigate to "Domains"
3. Add your custom domain
4. Configure DNS records as instructed

### 7. Enable Edge Functions

The backend API will automatically deploy as Vercel Edge Functions.

### 8. Post-Deployment Setup

1. Visit `https://yourdomain.com`
2. Register your admin account
3. Configure instance settings in admin panel

## Troubleshooting

### Backend not responding

- Check Vercel function logs
- Verify environment variables are set
- Ensure Supabase connection is working

### Frontend errors

- Clear browser cache
- Check console for errors
- Verify API_BASE_URL is correct

### Federation not working

- Verify INSTANCE_DOMAIN matches your actual domain
- Check that WebFinger endpoint is accessible: `https://yourdomain.com/.well-known/webfinger?resource=acct:username@yourdomain.com`
- Verify HTTP signatures are working in logs

## Cost Estimation

- **Vercel**: Free tier supports small instances, Pro ($20/mo) for production
- **Supabase**: Free tier includes 500MB database, 2GB storage
- **Total**: Can start completely free, scale as needed

## Support

For issues, please open a GitHub issue or join our community.

