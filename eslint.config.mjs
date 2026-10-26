import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/**", "esbuild.config.mjs", "version-bump.mjs"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			globals: { ...globals.browser },
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.*"] },
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
]);
