// Shared ESLint flat config for machina-sports Next.js / TypeScript repos.
// Each repo extends this via its local `eslint.config.mjs`.

import next from '@next/eslint-plugin-next';
import tseslint from 'typescript-eslint';

export default [
  ...tseslint.configs.recommended,
  {
    plugins: { '@next/next': next },
    rules: {
      ...next.configs['core-web-vitals'].rules,

      // Component hygiene — discourage local copies of design-system components.
      // Repos that opt into @machina-sports/ds should override the message via
      // their own eslint.config.mjs to allow safe escapes (e.g. ds-internal/).
      'no-restricted-imports': [
        'warn',
        {
          patterns: [
            {
              group: ['../../components/*', '../../../components/*'],
              message:
                'Reach for @machina-sports/ds first; deep relative imports of components suggest duplication.',
            },
          ],
        },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    ignores: ['.next/**', 'node_modules/**', 'dist/**', 'out/**', 'coverage/**', 'build/**'],
  },
];
