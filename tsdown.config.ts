// @ts-expect-error - Could not find a declaration file for module 'esbuild-plugin-license'. '/Users/mrbrown/src/github.com/bfra-me/github-action/node_modules/.pnpm/esbuild-plugin-license@1.2.3_esbuild@0.25.8/node_modules/esbuild-plugin-license/dist/index.mjs' implicitly has an 'any' type.
import esbuildPluginLicense, {type Dependency} from 'esbuild-plugin-license'
import {defineConfig} from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts', 'src/setup.ts'],
  fixedExtension: false,
  clean: false, // Workaround for esbuild-plugin-license issue
  minify: true,
  plugins: [
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    esbuildPluginLicense({
      thirdParty: {
        output: {
          file: 'licenses.txt',
          template: (dependencies: Dependency[]) =>
            dependencies
              // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
              .map(({packageJson, licenseText}) => `${packageJson.name}\n${packageJson.license}\n${licenseText}`)
              .join('\n\n'),
        },
      },
    }),
  ],
  noExternal: [
    '@actions/cache',
    '@actions/core',
    '@actions/exec',
    '@actions/github',
    '@actions/tool-cache',
    '@bfra.me/es',
    '@octokit/auth-app',
  ],
})
