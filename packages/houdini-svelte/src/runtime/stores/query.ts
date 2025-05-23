import type { FetchContext } from '$houdini/runtime/client/plugins/fetch'
import { getCurrentConfig } from '$houdini/runtime/lib/config'
import * as log from '$houdini/runtime/lib/log'
import { extractPageInfo } from '$houdini/runtime/lib/pageInfo'
import { cursorHandlers, offsetHandlers } from '$houdini/runtime/lib/pagination'
import type {
	CachePolicies,
	GraphQLVariables,
	GraphQLObject,
	MutationArtifact,
	QueryArtifact,
	QueryResult,
	CursorHandlers,
	OffsetHandlers,
	PageInfo,
} from '$houdini/runtime/lib/types'
import { CompiledQueryKind, CachePolicy, ArtifactKind } from '$houdini/runtime/lib/types'
import type { LoadEvent } from '@sveltejs/kit'
import { get, derived } from 'svelte/store'
import type { Subscriber } from 'svelte/store'

import type { PluginArtifactData } from '../../plugin/artifactData'
import type { HoudiniSvelteConfig } from '../../plugin/config'
import { clientStarted, isBrowser } from '../adapter'
import { getClient, initClient } from '../client'
import { getSession } from '../session'
import type {
	ClientFetchParams,
	LoadEventFetchParams,
	QueryStoreFetchParams,
	RequestEventFetchParams,
} from '../types'
import { BaseStore } from './base'

export class QueryStore<
	_Data extends GraphQLObject,
	_Input extends GraphQLVariables
> extends BaseStore<_Data, _Input, QueryArtifact> {
	// whether the store requires variables for input
	variables: boolean

	// identify it as a query store
	kind = CompiledQueryKind

	// if there is a load in progress when the CSF triggers we need to stop it
	protected loadPending = false

	// the string identifying the store
	protected storeName: string

	constructor({ artifact, storeName, variables }: StoreConfig<_Data, _Input, QueryArtifact>) {
		// all queries should be with fetching: true by default (because auto fetching)
		// except for manual queries, which should be false, it will be manualy triggered
		const fetching = artifact.pluginData['houdini-svelte']?.isManualLoad !== true

		super({
			artifact,
			fetching,
			// only initialize the store if it was automatically loaded
			initialize: !artifact.pluginData['houdini-svelte'].isManualLoad,
		})

		this.storeName = storeName
		this.variables = variables
	}

	/**
	 * Fetch the data from the server
	 */
	fetch(params?: RequestEventFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>>
	fetch(params?: LoadEventFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>>
	fetch(params?: ClientFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>>
	fetch(params?: QueryStoreFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>>
	async fetch(args?: QueryStoreFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>> {
		const client = await initClient()

		this.setup(false)

		// validate and prepare the request context for the current environment (client vs server)
		// make a shallow copy of the args so we don't mutate the arguments that the user hands us
		const { policy, params, context } = await fetchParams(this.artifact, this.storeName, args)

		// if we aren't on the browser but there's no event there's a big mistake
		if (!isBrowser && !(params && 'fetch' in params) && (!params || !('event' in params))) {
			// prettier-ignore
			log.error(contextError(this.storeName))

			throw new Error('Error, check above logs for help.')
		}

		// identify if this is a CSF or load
		const isLoadFetch = Boolean('event' in params && params.event)
		const isComponentFetch = !isLoadFetch

		// if there is a pending load, don't do anything
		if (this.loadPending && isComponentFetch) {
			log.error(`⚠️ Encountered fetch from your component while ${this.storeName}.load was running.
This will result in duplicate queries. If you are trying to ensure there is always a good value, please a CachePolicy instead.`)

			return get(this.observer)
		}

		// a component fetch is _always_ blocking
		if (isComponentFetch) {
			params.blocking = true
		}

		// blocking
		const config = getCurrentConfig()
		const config_svelte = (config.plugins as any)['houdini-svelte'] as HoudiniSvelteConfig
		const pluginArtifact = this.artifact.pluginData['houdini-svelte'] as
			| PluginArtifactData
			| undefined

		// Blocking strategy... step by step... Let's respect the order & priority
		let need_to_block = false
		// 0/ Check if the config make sense
		if (
			client.throwOnError_operations.includes('all') ||
			client.throwOnError_operations.includes('query')
		) {
			// if explicitly set to not_always_blocking, we can't throw, so warn the user.
			if (config_svelte.defaultRouteBlocking === false) {
				log.info(
					'[Houdini] ⚠️ throwOnError with operation "all" or "query", is not compatible with defaultRouteBlocking set to "false"'
				)
			}
		}

		// 1/ Check config
		if (config_svelte.defaultRouteBlocking === true) {
			need_to_block = true
		}

		// 2/ ThrowOnError
		if (
			client.throwOnError_operations.includes('all') ||
			client.throwOnError_operations.includes('query')
		) {
			need_to_block = true
		}

		// 3/ Artifact
		if (pluginArtifact?.set_blocking === true) {
			need_to_block = true
		} else if (pluginArtifact?.set_blocking === false) {
			need_to_block = false
		}

		// 4/ params
		if (params?.blocking === true) {
			need_to_block = true
		} else if (params?.blocking === false) {
			need_to_block = false
		}

		// the fetch is happening in a load
		if (isLoadFetch) {
			this.loadPending = true
		}

		// if the query has a loading state, we never block for the request on the client
		if (isBrowser && this.artifact.enableLoadingState) {
			need_to_block = false
		}

		// we might not want to actually wait for the fetch to resolve
		const fakeAwait = clientStarted && isBrowser && !need_to_block

		// spreading the default variables frist so that if the user provides one of these params themselves,
		// those params get overwritten with the correct value
		const usedVariables = {
			...this.artifact.input?.defaults,
			...params.variables,
		}

		// we want to try to load cached data before we potentially fake the await
		// this makes sure that the UI feels snappy as we click between cached pages
		// (no loaders)
		const refersToCache = policy !== CachePolicy.NetworkOnly && policy !== CachePolicy.NoCache
		if (refersToCache && fakeAwait) {
			await this.observer.send({
				fetch: context.fetch,
				variables: usedVariables,
				metadata: params.metadata,
				session: context.session,
				policy: CachePolicy.CacheOnly,
				// if the CacheOnly request doesn't give us anything,
				// don't update the store
				silenceEcho: true,
				abortController: params.abortController,
			})
		}

		// if the query is a live query, we don't really care about network policies any more
		// since CacheOrNetwork behaves the same as CacheAndNetwork
		const request = this.observer.send({
			fetch: context.fetch,
			variables: usedVariables,
			metadata: params.metadata,
			session: context.session,
			policy: policy,
			stuff: {},
		})

		// if we have to track when the fetch is done,
		request
			.then((val) => {
				this.loadPending = false
				params.then?.(val.data)
			})
			.catch(() => {})
		if (!fakeAwait) {
			await request
		}

		// the store will have been updated already since we waited for the response
		return get(this.observer)
	}
}

// the parameters we will be passed from the generator
export type StoreConfig<_Data extends GraphQLObject, _Input, _Artifact> = {
	artifact: _Artifact & { pluginData: { 'houdini-svelte': PluginArtifactData } }
	storeName: string
	variables: boolean
}

export async function fetchParams<_Data extends GraphQLObject, _Input>(
	artifact: QueryArtifact | MutationArtifact,
	storeName: string,
	params?: QueryStoreFetchParams<_Data, _Input>
): Promise<{
	context: FetchContext
	policy: CachePolicies | undefined
	params: QueryStoreFetchParams<_Data, _Input>
}> {
	// figure out the right policy
	let policy = params?.policy
	if (!policy && artifact.kind === ArtifactKind.Query) {
		// use the artifact policy as the default, otherwise prefer the cache over the network
		policy = artifact.policy ?? CachePolicy.CacheOrNetwork
	}

	// figure out the right fetch to use
	let fetchFn: LoadEvent['fetch'] | null = null

	if (params) {
		if ('fetch' in params && params.fetch) {
			fetchFn = params.fetch
		} else if ('event' in params && params.event && 'fetch' in params.event) {
			fetchFn = params.event.fetch
		}
	}

	// if we still don't have a fetch function, use the global one (node and browsers both have fetch)
	if (!fetchFn) {
		fetchFn = globalThis.fetch.bind(globalThis)
	}

	let session: any = undefined
	// cannot re-use the variable from above
	// we need to check for ourselves to satisfy typescript
	if (params && 'event' in params && params.event) {
		session = await getSession(params.event)
	} else if (isBrowser) {
		session = await getSession()
	} else {
		log.error(contextError(storeName))
		throw new Error('Error, check above logs for help.')
	}

	return {
		context: {
			fetch: fetchFn!,
			metadata: params?.metadata ?? {},
			session,
		},
		policy,
		params: params ?? {},
	}
}

const contextError = (storeName: string) => `
	${log.red(`Missing event args in load function`)}.

Please remember to pass event to fetch like so:

import type { LoadEvent } from '@sveltejs/kit';

// in a load function...
export async function load(${log.yellow('event')}: LoadEvent) {
	return {
		...load_${storeName}({ ${log.yellow('event')}, variables: { ... } })
	};
}

// in a server-side mutation:
await mutation.mutate({ ... }, ${log.yellow('{ event }')})
`

export type CursorStoreResult<
	_Data extends GraphQLObject,
	_Input extends GraphQLVariables
> = QueryResult<_Data, _Input> & { pageInfo: PageInfo }

// both cursor paginated stores add a page info to their subscribe
export class QueryStoreCursor<
	_Data extends GraphQLObject,
	_Input extends GraphQLVariables
> extends QueryStore<_Data, _Input> {
	// all paginated stores need to have a flag to distinguish from other query stores
	paginated = true

	constructor(config: StoreConfig<_Data, _Input, QueryArtifact>) {
		super(config)
	}

	#_handlers: CursorHandlers<_Data, _Input> | null = null
	async #handlers(): Promise<CursorHandlers<_Data, _Input>> {
		if (this.#_handlers) {
			return this.#_handlers
		}

		// initialize the client before we compute the handlers
		await initClient()

		// we're going to use a separate observer for the page loading
		const paginationObserver = getClient().observe<_Data, _Input>({
			artifact: this.artifact,
		})

		this.#_handlers = cursorHandlers<_Data, _Input>({
			artifact: this.artifact,
			getState: () => get(this.observer).data,
			getVariables: () => get(this.observer).variables!,
			fetch: super.fetch.bind(this),
			getSession: getSession,
			fetchUpdate: async (args, updates) => {
				await initClient()
				return paginationObserver.send({
					...args,
					cacheParams: {
						applyUpdates: updates,
						disableSubscriptions: true,
						...args?.cacheParams,
					},
				})
			},
		})

		return this.#_handlers
	}

	fetch(params?: RequestEventFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>>
	fetch(params?: LoadEventFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>>
	fetch(params?: ClientFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>>
	fetch(params?: QueryStoreFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>>
	async fetch(args?: QueryStoreFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>> {
		const handlers = await this.#handlers()
		return await handlers.fetch.call(this, args)
	}

	async loadPreviousPage(
		args?: Parameters<Required<CursorHandlers<_Data, _Input>>['loadPreviousPage']>[0]
	): Promise<QueryResult<_Data, _Input>> {
		const handlers = await this.#handlers()
		try {
			return await handlers.loadPreviousPage(args)
		} catch (e) {
			const err = e as Error
			// if the error is an abort error then we don't want to throw
			if (err.name === 'AbortError') {
				return get(this.observer)
			} else {
				throw err
			}
		}
	}

	async loadNextPage(
		args?: Parameters<CursorHandlers<_Data, _Input>['loadNextPage']>[0]
	): Promise<QueryResult<_Data, _Input>> {
		const handlers = await this.#handlers()
		try {
			return await handlers.loadNextPage(args)
		} catch (e) {
			const err = e as Error
			// if the error is an abort error then we don't want to throw
			if (err.name === 'AbortError') {
				return get(this.observer)
			} else {
				throw err
			}
		}
	}

	subscribe(
		run: Subscriber<CursorStoreResult<_Data, _Input>>,
		invalidate?: ((value?: CursorStoreResult<_Data, _Input> | undefined) => void) | undefined
	): () => void {
		const combined = derived([{ subscribe: super.subscribe.bind(this) }], ([$parent]) => {
			return {
				// @ts-ignore
				...$parent,
				pageInfo: extractPageInfo($parent.data, this.artifact.refetch!.path),
			}
		})

		return combined.subscribe(run, invalidate)
	}
}

export class QueryStoreOffset<
	_Data extends GraphQLObject,
	_Input extends GraphQLVariables
> extends QueryStore<_Data, _Input> {
	// all paginated stores need to have a flag to distinguish from other query stores
	paginated = true

	async loadNextPage(args?: Parameters<OffsetHandlers<_Data, _Input>['loadNextPage']>[0]) {
		const handlers = await this.#handlers()
		return await handlers.loadNextPage.call(this, args)
	}

	fetch(params?: RequestEventFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>>
	fetch(params?: LoadEventFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>>
	fetch(params?: ClientFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>>
	fetch(params?: QueryStoreFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>>
	async fetch(args?: QueryStoreFetchParams<_Data, _Input>): Promise<QueryResult<_Data, _Input>> {
		const handlers = await this.#handlers()
		return await handlers.fetch.call(this, args)
	}

	#_handlers: OffsetHandlers<_Data, _Input> | null = null
	async #handlers(): Promise<OffsetHandlers<_Data, _Input>> {
		if (this.#_handlers) {
			return this.#_handlers
		}

		// initialize the client
		await initClient()

		// we're going to use a separate observer for the page loading
		const paginationObserver = getClient().observe<_Data, _Input>({
			artifact: this.artifact,
		})
		this.#_handlers = offsetHandlers<_Data, _Input>({
			artifact: this.artifact,
			storeName: this.name,
			fetch: super.fetch.bind(this),
			getState: () => get(this.observer).data,
			getVariables: () => get(this.observer).variables!,
			getSession: getSession,
			fetchUpdate: async (args) => {
				await initClient()
				return paginationObserver.send({
					...args,
					variables: {
						...args?.variables,
					},
					cacheParams: {
						applyUpdates: ['append'],
					},
				})
			},
		})
		return this.#_handlers
	}
}
