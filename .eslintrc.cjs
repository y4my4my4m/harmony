/* eslint-env node */
require('@rushstack/eslint-patch/modern-module-resolution')

module.exports = {
  root: true,
  extends: [
    'plugin:vue/vue3-essential',
    'eslint:recommended',
    '@vue/eslint-config-typescript',
    '@vue/eslint-config-prettier/skip-formatting'
  ],
  plugins: ['unused-imports'],
  parserOptions: {
    ecmaVersion: 'latest'
  },
  rules: {
    // Defer unused-import / unused-var detection to the unused-imports plugin
    // (auto-fixable for imports, underscore-prefix aware for variables).
    '@typescript-eslint/no-unused-vars': 'off',
    'no-unused-vars': 'off',
    'unused-imports/no-unused-imports': 'warn',
    'unused-imports/no-unused-vars': ['warn', {
      args: 'after-used',
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
      ignoreRestSiblings: true
    }],
    'vue/multi-word-component-names': ['error', {
      ignores: ['Avatar', 'Composer', 'Speaker']
    }]
  },
  overrides: [
    {
      files: [
        'scripts/**/*.{js,cjs,mjs,ts}',
        'bull-board/**/*.{js,cjs,mjs}',
        'dev/**/*.{js,cjs,mjs,ts}',
        'docker/**/*.{js,cjs,mjs}',
        '*.{cjs,mjs}',
        'vue-docgen.config.js',
        'vite.config.ts',
        'vite-plugin-selective-preload.ts',
        'vitest.*.ts',
        'playwright.config.ts'
      ],
      env: { node: true }
    }
  ]
}
