import nextConfig from 'eslint-config-next';

// `eslint-config-next` supplies the TypeScript parser in its exported `next/typescript`
// entry; reuse that declared package instead of importing transitive `typescript-eslint`.
const nextTypeScriptParser = nextConfig.find((entry) => entry.name === 'next/typescript').languageOptions.parser;

const config = [
  ...nextConfig,
  {
    ignores: ['test-results/**', 'out/**', 'out-canary/**', '.next/**'],
  },
  {
    // `eslint-config-next` applies its TypeScript parser to `.ts`/`.tsx` only, so a
    // declaration module (`*.d.mts`) fell through to the Babel parser and failed on
    // an ambient declaration (`export const X: number;`). These files are TypeScript.
    files: ['**/*.d.mts', '**/*.d.cts'],
    languageOptions: { parser: nextTypeScriptParser, parserOptions: { sourceType: 'module' } },
  },
];

export default config;
