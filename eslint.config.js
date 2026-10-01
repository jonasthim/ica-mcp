import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'spike/out/', 'drizzle/', '.claude/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Browser modules served from /admin/assets (plain JS, no bundler): only the browser globals they use.
  {
    files: ['src/admin/assets/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: Object.fromEntries(['document', 'navigator', 'location', 'fetch', 'setTimeout', 'Element', 'HTMLFormElement', 'HTMLDialogElement', 'HTMLInputElement'].map((g) => [g, 'readonly'])),
    },
  },
  { files: ['src/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/consistent-type-imports': 'error' } },
);
