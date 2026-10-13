import { defineConfig, type DefaultTheme } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

const REPO = 'https://github.com/y4my4my4m/harmony'

// Pages kept only so old deep links from mony.lol and elsewhere resolve.
const LEGACY = new Set([
  'self-hosting',
  'bot-api',
  'plugins/',
  'plugins/discord-bridge',
  'FEDERATION',
])

const sidebar: DefaultTheme.Sidebar = {
  '/use/': [
    {
      text: 'Use Harmony',
      items: [
        { text: 'Overview', link: '/use/' },
        { text: 'Getting started', link: '/use/getting-started' },
      ],
    },
    {
      text: 'Guides',
      items: [
        { text: 'Messages and threads', link: '/use/messages' },
        { text: 'Voice and video', link: '/use/voice-video' },
        { text: 'Notifications and apps', link: '/use/notifications-apps' },
        { text: 'Social', link: '/use/social' },
        { text: 'Privacy and security', link: '/use/privacy-security' },
        { text: 'Accessibility', link: '/use/accessibility' },
      ],
    },
    {
      text: 'Reference',
      items: [{ text: 'Keyboard shortcuts', link: '/use/keyboard-shortcuts' }],
    },
  ],
  '/run/': [
    {
      text: 'Run a server',
      items: [
        { text: 'Overview', link: '/run/' },
        { text: 'Setting up a server', link: '/run/setup' },
      ],
    },
    {
      text: 'Guides',
      items: [
        { text: 'Roles and permissions', link: '/run/roles-permissions' },
        { text: 'Moderation', link: '/run/moderation' },
        { text: 'Webhooks', link: '/run/webhooks' },
        { text: 'Discord bridge', link: '/run/discord-bridge' },
      ],
    },
  ],
  '/self-host/': [
    {
      text: 'Self-host',
      items: [
        { text: 'Overview', link: '/self-host/' },
        { text: 'Install', link: '/self-host/install' },
        { text: 'Update, backup, restore', link: '/self-host/update-backup' },
      ],
    },
    {
      text: 'Configure',
      items: [
        { text: 'Configuration reference', link: '/self-host/configuration' },
        { text: 'Email (SMTP)', link: '/self-host/email' },
        { text: 'OAuth sign-in', link: '/self-host/oauth' },
        { text: 'Voice and video', link: '/self-host/voice' },
        { text: 'Push notifications', link: '/self-host/push' },
        { text: 'Discord bridges', link: '/self-host/discord-bridges' },
      ],
    },
    {
      text: 'Operate',
      items: [
        { text: 'harmony CLI', link: '/self-host/cli' },
        { text: 'Monitoring', link: '/self-host/monitoring' },
        { text: 'Manual Docker Compose', link: '/self-host/docker-compose' },
        { text: 'Troubleshooting', link: '/self-host/troubleshooting' },
      ],
    },
  ],
  '/build/': [
    {
      text: 'Build',
      items: [
        { text: 'Overview', link: '/build/' },
        { text: 'Bot quickstart', link: '/build/bot-quickstart' },
      ],
    },
    {
      text: 'Reference',
      items: [
        { text: 'Gateway', link: '/build/gateway' },
        { text: 'REST API', link: '/build/rest' },
        { text: 'Webhooks API', link: '/build/webhooks' },
        { text: 'Permissions and rate limits', link: '/build/permissions-rate-limits' },
      ],
    },
    {
      text: 'Guides',
      items: [{ text: 'Writing a bridge', link: '/build/bridges' }],
    },
  ],
  '/federation/': [
    {
      text: 'Federation',
      items: [
        { text: 'Overview', link: '/federation/' },
        { text: 'ActivityPub reference', link: '/federation/reference' },
      ],
    },
  ],
  '/contribute/': [
    {
      text: 'Contribute',
      items: [
        { text: 'Development setup', link: '/contribute/' },
        { text: 'Architecture', link: '/contribute/architecture' },
        { text: 'Testing', link: '/contribute/testing' },
        { text: 'Database migrations', link: '/contribute/migrations' },
        { text: 'Release process', link: '/contribute/releases' },
        { text: 'Docs style', link: '/contribute/docs-style' },
      ],
    },
  ],
}

export default withMermaid(
  defineConfig({
    title: 'Harmony Docs',
    titleTemplate: ':title · Harmony Docs',
    description:
      'Documentation for Harmony, the open-source federated chat app: using it, running a server, self-hosting an instance, building bots and bridges.',
    lang: 'en',
    // Output directories of the retired generators and local notes listed in .gitignore.
    srcExclude: [
      'api/**',
      'components/**',
      'generated/**',
      'guide/**',
      'SETTINGS_NAVIGATION_GUIDE.md',
      'VITEPRESS_SETUP.md',
    ],
    cleanUrls: true,
    lastUpdated: true,
    // Fails the build on links to pages that do not exist; localhost URLs in prose are examples.
    ignoreDeadLinks: 'localhostLinks',
    sitemap: {
      hostname: 'https://docs.mony.lol',
      // Legacy URL stubs redirect elsewhere and stay out of the sitemap.
      transformItems: (items) => items.filter((item) => !LEGACY.has(item.url.replace(/\.html$/, ''))),
    },

    head: [
      ['link', { rel: 'icon', type: 'image/png', href: '/logo.png' }],
      ['meta', { name: 'theme-color', content: '#FBF8F1', media: '(prefers-color-scheme: light)' }],
      ['meta', { name: 'theme-color', content: '#17191E', media: '(prefers-color-scheme: dark)' }],
      ['meta', { property: 'og:site_name', content: 'Harmony Docs' }],
      ['meta', { property: 'og:type', content: 'website' }],
    ],

    // Plugin switches to Mermaid's 'dark' theme while <html> has the .dark class;
    // custom.css recolours both themes with the docs inks. Labels are measured
    // in the font named here, so it matches the body face.
    mermaid: {
      theme: 'neutral',
      themeVariables: {
        fontFamily: "'Instrument Sans Variable', ui-sans-serif, system-ui, sans-serif",
        fontSize: '15px',
      },
    },

    markdown: {
      lineNumbers: false,
      theme: {
        light: 'github-light',
        dark: 'github-dark',
      },
    },

    themeConfig: {
      logo: { src: '/logo.png', alt: '' },
      siteTitle: 'Harmony Docs',

      nav: [
        { text: 'Use', link: '/use/', activeMatch: '^/use/' },
        { text: 'Run a server', link: '/run/', activeMatch: '^/run/' },
        { text: 'Self-host', link: '/self-host/', activeMatch: '^/self-host/' },
        { text: 'Build', link: '/build/', activeMatch: '^/build/' },
        { text: 'Federation', link: '/federation/', activeMatch: '^/federation/' },
        { text: 'Contribute', link: '/contribute/', activeMatch: '^/contribute/' },
        { text: 'Changelog', link: '/changelog' },
      ],

      sidebar,

      outline: { level: [2, 3], label: 'On this page' },

      socialLinks: [{ icon: 'github', link: REPO, ariaLabel: 'Harmony on GitHub' }],

      editLink: {
        pattern: `${REPO}/edit/master/docs/:path`,
        text: 'Edit this page on GitHub',
      },

      lastUpdated: {
        text: 'Last updated',
        formatOptions: { dateStyle: 'medium' },
      },

      footer: {
        message: 'AGPL-3.0 · Harmony contributors',
      },

      search: {
        provider: 'local',
        options: {
          // Legacy URL stubs carry `search: false` in their frontmatter.
          detailedView: true,
        },
      },
    },

    // 5173 is the web app's dev server and 3001 the federation backend's. DOCS_PORT runs a second copy.
    vite: {
      server: {
        port: Number(process.env.DOCS_PORT) || 5190,
      },
    },
  }),
)
