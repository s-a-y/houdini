import type { Document } from 'houdini'
import { fs, path } from 'houdini'
import { mockCollectedDoc } from 'houdini/test'
import * as recast from 'recast'
import * as typeScriptParser from 'recast/parsers/typescript'
import { test, expect } from 'vitest'

import runPipeline from '..'
import '../..'
import { test_config } from '../../../test'
import { stores_directory } from '../../storeConfig'

test('generates a store for every fragment', async function () {
	const config = await test_config()
	const pluginRoot = config.pluginDirectory('test-plugin')

	// the documents to test
	const docs: Document[] = [
		mockCollectedDoc(`fragment TestFragment1 on User { id }`),
		mockCollectedDoc(`fragment TestFragment2 on User { id }`),
	]

	// execute the generator
	await runPipeline({ config, documents: docs, pluginRoot, framework: 'kit' })

	// look up the files in the artifact directory
	const files = await fs.readdir(stores_directory(pluginRoot))

	// and they have the right names
	expect(files).toEqual(expect.arrayContaining(['TestFragment1.js', 'TestFragment2.js']))
	// and type definitions exist
	expect(files).toEqual(expect.arrayContaining(['TestFragment1.d.ts', 'TestFragment2.d.ts']))

	const contents = await fs.readFile(path.join(stores_directory(pluginRoot), 'TestFragment1.js'))
	const parsed = recast.parse(contents!, {
		parser: typeScriptParser,
	}).program

	await expect(parsed).toMatchInlineSnapshot(
		`
		import { FragmentStore } from '../runtime/stores/fragment'
		import artifact from '$houdini/artifacts/TestFragment1'


		// create the fragment store

		export class TestFragment1Store extends FragmentStore {
			constructor() {
				super({
					artifact,
					storeName: "TestFragment1Store",
					variables: true,
					
				})
			}
		}
	`
	)
})
