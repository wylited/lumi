import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/.next/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/src-tauri/target/**',
      '**/src-tauri/gen/**',
      '**/*.config.*',
      '**/next-env.d.ts',
      'apps/mobile/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/desktop/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
          message: 'No raw hex colour — every colour comes from @heli/tokens.',
        },
      ],
    },
  },
  {
    files: ['apps/server/**/*.{ts,tsx}', 'apps/desktop/src-tauri/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'error',
    },
  },
)
