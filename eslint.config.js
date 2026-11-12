import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import gandalf from './eslint-plugin-gandalf/index.js';

export default tseslint.config(
  { ignores: ['dist/', '.venv/', 'node_modules/', '.superpowers/', 'eslint-plugin-gandalf/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: { gandalf },
    rules: {
      'gandalf/no-direct-fetch': 'warn',
      'gandalf/no-useeffect-derived-state': 'warn',
      'gandalf/no-business-logic-in-jsx': 'warn',
    },
  },
);
