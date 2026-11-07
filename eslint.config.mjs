import nextConfig from 'eslint-config-next';

export default [
  ...nextConfig,
  {
    ignores: [
      'app/out/**',
      'app/out-canary/**',
      'app/.next/**',
      'pipeline/.work/**',
      'packages/scanner-cli/dist/**',
    ],
  },
  {
    files: [
      'contracts/**/*.{js,jsx,mjs,ts,tsx,mts,cts}',
      'pipeline/**/*.{js,jsx,mjs,ts,tsx,mts,cts}',
      'packages/scanner-core/**/*.{js,jsx,mjs,ts,tsx,mts,cts}',
      'packages/scanner-cli/**/*.{js,jsx,mjs,ts,tsx,mts,cts}',
    ],
    rules: {
      // These workspaces do not contain Next.js pages. The app keeps the
      // default rule from app/eslint.config.mjs.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
];
