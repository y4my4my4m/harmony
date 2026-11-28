/* eslint-env node */
//Literal UI text in templates. Text belongs in src/locales/*.json through t().
module.exports = {
  root: true,
  parser: require.resolve('vue-eslint-parser'),
  parserOptions: {
    parser: require.resolve('@typescript-eslint/parser'),
    ecmaVersion: 'latest',
    sourceType: 'module',
    extraFileExtensions: ['.vue']
  },
  //Plugins of .eslintrc.cjs load with their rules off, so inline directives naming them resolve.
  plugins: ['@intlify/vue-i18n', 'vue', 'unused-imports', '@typescript-eslint'],
  //Developer-only pages: /demo routes and an unmounted debug panel.
  ignorePatterns: ['src/components/demo/**', 'src/components/debug/**'],
  rules: {
    '@intlify/vue-i18n/no-raw-text': ['error', {
      ignoreNodes: ['code', 'pre', 'kbd', 'samp'],
      attributes: {
        '/.+/': ['title', 'placeholder', 'aria-label', 'alt', 'label', 'description', 'header', 'tooltip',
          'subtitle', 'confirm-text', 'cancel-text', 'empty-text']
      },
      //Text without a letter, a hex colour, a URL or scheme, an address, a domain or file name.
      ignorePattern: '^(\\P{L}*|#[0-9a-fA-F]{3,8}|(https?|wss?)://\\S*|[\\w.+-]+@[\\w-]+\\.[\\w.]+|[\\w-]*(\\.[\\w-]+)+)$',
      //Names, codes and units every locale writes the same, and labels of other services' own interfaces.
      ignoreText: [
        'Harmony', 'Discord', 'Matrix', '· Discord', 'Twemoji', 'KLIPY', 'Stripe', 'Cloudflare Turnstile', 'hCaptcha',
        'Docker Desktop', 'Docker Engine', 'harmony-discord-bridge', '· Google (FCM)', '· UnifiedPush',
        'Customers choose what to pay', 'Developers → Webhooks',
        'GIF', 'URL', 'ID', 'OK', 'API', 'JSON', 'HTTP', 'HRTF', 'PTT', 'ALT', 'SHA-256', 'USD', 'EUR', 'GBP', 'JPY',
        'ms', 'px', 'MB', 'x', 'v', 'Aa', 'Alt+↑', 'Alt+↓',
        '@everyone', '#general:example.org', 'DELETE', 'data', 'info', 'whsec_...'
      ]
    }]
  }
}
