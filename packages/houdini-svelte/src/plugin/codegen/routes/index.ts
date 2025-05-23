import type { OperationDefinitionNode } from 'graphql'
import type { Config, GenerateHookInput } from 'houdini'
import { fs, path } from 'houdini'

import { plugin_config } from '../../config'
import type { Framework } from '../../kit'
import { walk_routes } from '../../kit'
import { houdini_afterLoad_fn, houdini_before_load_fn, houdini_on_error_fn } from '../../naming'
import { route_params } from '../../routing'
import { type_route_dir, stores_directory_name, store_suffix } from '../../storeConfig'

export default async function svelteKitGenerator(
	framework: Framework,
	{ config }: GenerateHookInput
) {
	// this generator creates the locally imported type definitions.
	// the component type generator will handle
	if (framework !== 'kit') {
		return
	}

	await walk_routes(config, framework, {
		async route({
			dirpath,
			svelteTypeFilePath,
			layoutQueries,
			pageQueries,
			componentQueries,
			layoutExports,
			pageExports,
		}) {
			const relativePath = path.relative(config.routesDir, dirpath)
			const target = path.join(type_route_dir(config), relativePath, config.typeRootFile)

			const houdiniRelative = path.relative(target, config.typeRootDir)

			const queryNames: string[] = []
			const uniquePageQueries: OperationDefinitionNode[] = []
			for (const query of pageQueries) {
				if (!queryNames.includes(query.name!.value)) {
					queryNames.push(query.name!.value)
					uniquePageQueries.push(query)
				}
			}

			const layoutNames: string[] = []
			const uniqueLayoutQueries: OperationDefinitionNode[] = []
			for (const layout of layoutQueries) {
				if (!layoutNames.includes(layout.name!.value)) {
					layoutNames.push(layout.name!.value)
					uniqueLayoutQueries.push(layout)
				}
			}

			const componentNames: string[] = []
			const uniqueComponentQueries: {
				query: OperationDefinitionNode
				componentPath: string
			}[] = []
			for (const component of componentQueries) {
				if (!componentNames.includes(component.query.name!.value)) {
					componentNames.push(component.query.name!.value)
					uniqueComponentQueries.push(component)
				}
			}

			if (
				// Include path doesn't include js
				!config.include.some((path) => path.includes('js')) &&
				// And the plugin isn't configured to run in static mode
				!plugin_config(config).static &&
				// User uses layout/page queries
				(uniquePageQueries.length > 0 || uniqueLayoutQueries.length > 0)
			) {
				console.error(
					`⚠️ You are using at least one page/layout query but aren't "include"ing .js files in your config. \n 
					This will cause houdini to not pick up the generated files and prevent it from working as expected.`
				)
			}

			// read the svelte-kit $types.d.ts file into a string
			let skTypeString = await fs.readFile(svelteTypeFilePath)

			//if the file is truthy (not empty)
			if (skTypeString) {
				//get the type imports for file

				const pageTypeImports = getTypeImports(houdiniRelative, config, uniquePageQueries)
				const layoutTypeImports = getTypeImports(
					houdiniRelative,
					config,
					uniqueLayoutQueries
				)
				const componentQueryTypeImports = getComponentTypeImports(
					dirpath,
					config,
					uniqueComponentQueries
				)

				// Util bools for ensuring no unnecessary types
				const beforePageLoad = pageExports.includes(houdini_before_load_fn)
				const afterPageLoad = pageExports.includes(houdini_afterLoad_fn)
				const onPageError = pageExports.includes(houdini_on_error_fn)

				const beforeLayoutLoad = layoutExports.includes(houdini_before_load_fn)
				const afterLayoutLoad = layoutExports.includes(houdini_afterLoad_fn)
				const onLayoutError = layoutExports.includes(houdini_on_error_fn)

				const layout_append_VariablesFunction = append_VariablesFunction(
					'Layout',
					dirpath,
					config,
					uniqueLayoutQueries
				)
				const page_append_VariablesFunction = append_VariablesFunction(
					'Page',
					dirpath,
					config,
					uniquePageQueries
				)

				const component_append_VariablesFunction = append_ComponentVariablesFunction(
					dirpath,
					config,
					uniqueComponentQueries
				)

				const layout_append_beforeLoad = append_beforeLoad(beforeLayoutLoad, 'Layout')
				const page_append_beforeLoad = append_beforeLoad(beforePageLoad, 'Page')

				const layout_append_afterLoad = append_afterLoad(
					afterLayoutLoad,
					'Layout',
					layoutQueries
				)
				const page_append_afterLoad = append_afterLoad(afterPageLoad, 'Page', pageQueries)

				const layout_append_onError = append_onError(
					onLayoutError,
					'Layout',
					//if there are not inputs to any query, we won't define a LoadInput in our error type
					layoutQueries.filter((x) => x.variableDefinitions?.length).length > 0
				)
				const page_append_onError = append_onError(
					onPageError,
					'Page',
					//if there are not inputs to any query, we won't define a LoadInput in our error type
					pageQueries.filter((x) => x.variableDefinitions?.length).length > 0
				)

				//default sktype string is defined as imports \n\n utility \n\n exports
				const splitString = skTypeString.split('\n\n')

				//name our sections
				let typeImports = splitString[0]
				let utilityTypes =
					splitString[1] +
					`
						type MakeOptional<Target, Keys extends keyof Target> = Omit<Target, Keys> & {
							[Key in Keys]?: Target[Key] | undefined | null
						}
					`
				let typeExports = splitString[2]

				// lots of comparisons but helpful to prevent unnecessary imports
				// define function imports e.g. import { VariableFunction, AfterLoadFunction, BeforeLoadFunction } from 'relativePath'
				// will not include unnecessary imports.
				const functionImportsToBring = []
				if (
					layout_append_VariablesFunction !== '' ||
					page_append_VariablesFunction !== ''
				) {
					functionImportsToBring.push('VariableFunction')
				}
				if (afterLayoutLoad || afterPageLoad) {
					functionImportsToBring.push('AfterLoadFunction')
				}
				if (beforeLayoutLoad || beforePageLoad) {
					functionImportsToBring.push('BeforeLoadFunction')
				}

				const functionImports =
					functionImportsToBring.length > 0
						? `\nimport type { ${functionImportsToBring.join(
								', '
						  )} } from '${houdiniRelative}/plugins/houdini-svelte/runtime/types';`
						: ''

				// mutate typeImports with our functionImports, layout/pageStores, $result, $input,
				typeImports = typeImports
					.concat(functionImports)
					.concat(layoutTypeImports)
					.concat(pageTypeImports)
					.concat(componentQueryTypeImports)

				// if we need Page/LayoutParams, generate this type.
				// verify if necessary. might not be.
				const layoutParams = `${
					layoutQueries.length > 0 && !utilityTypes.includes('LayoutParams')
						? "\ntype LayoutParams = LayoutLoadEvent['params'];"
						: ''
				}`

				//page params are necessary though.
				const pageParams = `${
					pageQueries.length > 0 && !utilityTypes.includes('PageParams')
						? "\ntype PageParams = PageLoadEvent['params'];"
						: ''
				}`

				// mutate utilityTypes with our layoutParams, pageParams.
				utilityTypes = utilityTypes
					.concat(layoutParams)
					.concat(pageParams)
					//replace all instances of $types.js with $houdini to ensure type inheritence.
					//any type imports will always be in the utilityTypes block
					.replaceAll(/\$types\.js/gm, '$houdini')

				// main bulk of the work done here.
				typeExports = typeExports
					//we define the loadInput, checks if any queries have imports
					.concat(append_loadInput([...layoutQueries, ...pageQueries]))
					//define beforeLoad and afterLoad types layout always first
					.concat(layout_append_beforeLoad)
					.concat(page_append_beforeLoad)
					.concat(layout_append_afterLoad)
					.concat(page_append_afterLoad)
					.concat(layout_append_onError)
					.concat(page_append_onError)
					.concat(layout_append_VariablesFunction)
					.concat(page_append_VariablesFunction)
					.concat(component_append_VariablesFunction)
					//match all between 'LayoutData =' and ';' and combine additional types
					.replace(
						//regex to append our generated stores to the existing
						//match all between 'LayoutData =' and ';' and combine additional types
						/(?<=LayoutData = )([\s\S]*?)(?=;)/,
						`Expand<$1 & { ${layoutQueries
							.map((query) => {
								const name = query.name!.value

								return [name, name + store_suffix(config)].join(': ')
							})
							.join('; ')} }${internal_append_TypeDataExtra(
							beforeLayoutLoad,
							afterLayoutLoad,
							onLayoutError
						)}>`
					)
					.replace(
						//regex to append our generated stores to the existing
						//match all between 'PageData =' and ';' and combine additional types
						/(?<=PageData = )([\s\S]*?)(?=;)/,
						`Expand<$1 & { ${pageQueries
							.map((query) => {
								const name = query.name!.value

								return [name, name + store_suffix(config)].join(': ')
							})
							.join('; ')} }${internal_append_TypeDataExtra(
							beforePageLoad,
							afterPageLoad,
							onPageError
						)}>`
					)

				//make dir of target if not exist
				await fs.mkdirp(path.dirname(target))
				// write the file
				await fs.writeFile(target, [typeImports, utilityTypes, typeExports].join('\n\n'))

				if (typeExports.includes('proxy')) {
					const proxyDir = path.dirname(svelteTypeFilePath)
					const proxyDirContent = await fs.readdir(proxyDir)
					const proxyFiles = proxyDirContent.filter((name) => name.includes('proxy'))
					for (const element of proxyFiles) {
						const src = path.join(proxyDir, element)
						const dest = path.join(path.dirname(target), element)
						await fs.copyFile(src, dest)
					}
				}
			}
		},
	})
}

function getTypeImports(
	houdiniRelative: string,
	config: Config,
	queries: OperationDefinitionNode[]
) {
	return queries
		.map((query) => {
			const name = query.name!.value
			return `\nimport { ${name}$result, ${name}$input } from '${houdiniRelative}/${
				config.artifactDirectoryName
			}/${name}';\nimport { ${name}Store } from '${houdiniRelative}/plugins/houdini-svelte/${stores_directory_name()}/${name}';`
		})
		.join('\n')
}

// Copied and adapted from packages\houdini-svelte\src\plugin\codegen\components\index.ts
function getComponentTypeImports(
	dirpath: string,
	config: Config,
	queries: { query: OperationDefinitionNode; componentPath: string }[]
) {
	// Don't output anything if we don't have any component queries
	if (queries.length === 0) {
		return ''
	}

	let typeFile = "\nimport type { ComponentProps } from 'svelte'\n"
	return (
		typeFile +
		queries
			.map((query) => {
				const no_ext = path.parse(query.componentPath).name
				const file = path.parse(query.componentPath)

				return `
import ${no_ext} from './${file.base}'
import type { ${query.query.name!.value}$input } from '${path
					.relative(dirpath, path.join(config.artifactDirectory, query.query.name!.value))
					.replace('/$houdini', '')}'
`
			})
			.join('\n')
	)
}

function append_VariablesFunction(
	type: `Page` | `Layout`,
	filepath: string,
	config: Config,
	queries: OperationDefinitionNode[]
) {
	const { params } = route_params(filepath)
	const garunteed_args = params.filter((param) => !param.optional).map((param) => param.name)

	return queries
		.map((query) => {
			const name = query.name!.value
			// if the query does not have any variables, don't include anything
			if (!query.variableDefinitions?.length) {
				return ''
			}

			// if a garunteed arg matches one of the args of the query, its not required
			// regardless of what the $input type says
			const make_optional: string[] = []
			for (const def of query.variableDefinitions) {
				if (garunteed_args.includes(def.variable.name.value)) {
					make_optional.push(`'${def.variable.name.value}'`)
				}
			}

			// build up the input type
			let input_type = `${name}$input`
			if (make_optional.length > 0) {
				input_type = `MakeOptional<${input_type}, ${make_optional.join(' | ')}>`
			}

			// define the variable function
			return `\nexport type ${config.variableFunctionName(
				name
			)} = VariableFunction<${type}Params, ${input_type}>;`
		})
		.join('\n')
}

// Copied and adapted from packages\houdini-svelte\src\plugin\codegen\components\index.ts
function append_ComponentVariablesFunction(
	filepath: string,
	config: Config,
	queries: { query: OperationDefinitionNode; componentPath: string }[]
) {
	return queries
		.map((query) => {
			const no_ext = path.parse(query.componentPath).name
			const prop_type = no_ext + 'Props'

			return `
type ${prop_type} = ComponentProps<${no_ext}>
export type ${config.variableFunctionName(
				query.query.name!.value
			)} = <_Props extends ${prop_type}>(args: { props: _Props }) => ${
				query.query.name!.value
			}$input
`
		})
		.join('\n')
}

function append_loadInput(queries: OperationDefinitionNode[]) {
	return `${
		queries.filter((q) => q.variableDefinitions?.length).length
			? `\ntype LoadInput = { ${queries
					.filter((query) => query.variableDefinitions?.length)
					.map((query) => {
						// if the query does not have any variables, don't include anything
						const name = query.name!.value

						return [name, name + '$input'].join(': ')
					})
					.join('; ')} };`
			: ''
	}`
}

function append_afterLoad(
	afterLoad: boolean,
	type: `Page` | `Layout`,
	queries: OperationDefinitionNode[]
) {
	return afterLoad
		? `
type AfterLoadReturn = Awaited<ReturnType<typeof import('./+${type.toLowerCase()}').${houdini_afterLoad_fn}>>;
type AfterLoadData = {
	${internal_append_afterLoad(queries)}
};

export type AfterLoadEvent = {
	event: ${type}LoadEvent
	data: AfterLoadData
	input: ${queries.filter((q) => q.variableDefinitions?.length).length ? 'LoadInput' : '{}'}
};
`
		: ''
}

function internal_append_afterLoad(queries: OperationDefinitionNode[]) {
	return `${queries
		.map((query) => {
			// if the query does not have any variables, don't include anything
			const name = query.name!.value

			return [name, name + '$result'].join(': ')
		})
		.join(';\n\t')}`
}

function append_beforeLoad(beforeLoad: boolean, type: 'Layout' | 'Page') {
	return beforeLoad
		? `
export type BeforeLoadEvent = ${type}LoadEvent;
type BeforeLoadReturn = Awaited<ReturnType<typeof import('./+${type.toLowerCase()}').${houdini_before_load_fn}>>;
`
		: ''
}

function append_onError(onError: boolean, type: 'Layout' | 'Page', hasLoadInput: boolean) {
	return onError
		? `
type OnErrorReturn = Awaited<ReturnType<typeof import('./+${type.toLowerCase()}').${houdini_on_error_fn}>>;
export type OnErrorEvent =  { event: Kit.LoadEvent, input: ${
				hasLoadInput ? 'LoadInput' : '{}'
		  }, error: Kit.HttpError };
`
		: ''
}

function internal_append_TypeDataExtra(beforeLoad: boolean, afterLoad: boolean, onError: boolean) {
	return `${beforeLoad ? ' & BeforeLoadReturn' : ''}${afterLoad ? ' & AfterLoadReturn' : ''}${
		onError ? ' & OnErrorReturn' : ''
	}`
}
