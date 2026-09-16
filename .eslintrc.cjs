module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    'import/no-restricted-paths': [
      'error',
      {
        zones: [
          // packages/core cannot import from packages/providers or apps/api
          {
            target: './packages/core',
            from: './packages/providers',
            message: 'Boundary violation: packages/core must not import from packages/providers.',
          },
          {
            target: './packages/core',
            from: './apps',
            message: 'Boundary violation: packages/core must not import from apps.',
          },
          // packages/providers cannot import from apps
          {
            target: './packages/providers',
            from: './apps',
            message: 'Boundary violation: packages/providers must not import from apps.',
          },
        ],
      },
    ],
  },
  ignorePatterns: ['dist', 'node_modules', '*.d.ts'],
};
