import type {Options} from 'tsup'
// @ts-expect-error - Could not find a declaration file for module 'esbuild-plugin-license'. '/Users/mrbrown/src/github.com/bfra-me/github-action/node_modules/.pnpm/esbuild-plugin-license@1.2.3_esbuild@0.25.8/node_modules/esbuild-plugin-license/dist/index.mjs' implicitly has an 'any' type.
import esbuildPluginLicense, {type Dependency} from 'esbuild-plugin-license'

const config: Options = {
  banner: {
    js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
  },
  entry: {
    index: 'src/main.ts',
  },
  esbuildPlugins: [
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
  format: 'esm',
  noExternal: ['@actions/core'],
}

export default config
