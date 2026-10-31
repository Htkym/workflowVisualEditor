import babelParser from '@babel/eslint-parser';
import stylistic from '@stylistic/eslint-plugin';

export default [{
  files: ['src/**/*.ts', 'webview/**/*.ts'],
  languageOptions: {
    parser: babelParser,
    parserOptions: {
      requireConfigFile: false,
      babelOptions: {
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ['typescript'] },
      },
    },
  },
  plugins: { '@stylistic': stylistic },
  rules: {
    '@stylistic/nonblock-statement-body-position': ['error', 'below'],
    '@stylistic/indent': ['error', 2],
    '@stylistic/no-trailing-spaces': 'error',
  },
}];
