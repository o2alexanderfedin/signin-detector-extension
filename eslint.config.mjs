// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // `scripts/audit-privacy.mjs` (npm run audit:privacy) is a
          // plain standalone Node script, deliberately outside the main
          // TS project (like this config file itself) -- see the
          // matching `disableTypeChecked` block below.
          allowDefaultProject: ['eslint.config.mjs', 'scripts/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['eslint.config.mjs', 'scripts/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // `scripts/audit-privacy.mjs` runs standalone under plain Node (not
    // bundled/transformed), so it needs real Node globals (`console`,
    // `process`) rather than this project's browser/webworker-oriented
    // `lib` (see tsconfig.json).
    files: ['scripts/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    ignores: ['.output/**', '.wxt/**', 'node_modules/**'],
  },
);
