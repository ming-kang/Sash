// Biome lints TypeScript sources; this config covers what it cannot parse:
// Vue single-file components. Essentials plus a few high-signal correctness
// rules — styling stays with Biome and the design tokens.
import pluginVue from "eslint-plugin-vue";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "web/src/assets/fonts/**",
      "**/*.test.ts",
    ],
  },
  ...pluginVue.configs["flat/essential"],
  {
    files: ["web/**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
      },
    },
    rules: {
      // Icon is an intentional one-word primitive of the design system.
      "vue/multi-word-component-names": ["error", { ignores: ["App", "Icon"] }],
      // RouterLink/RouterView are registered globally by vue-router.
      "vue/no-undef-components": ["error", { ignorePatterns: ["RouterLink", "RouterView"] }],
      "vue/no-unused-refs": "error",
      "vue/no-useless-template-attributes": "error",
      "vue/prefer-true-attribute-shorthand": "error",
      "vue/require-toggle-inside-transition": "error",
      "vue/no-v-html": "error",
    },
  },
);
