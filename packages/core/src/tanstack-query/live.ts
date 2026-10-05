import { getEventMeta } from '@orpc/client'
import type { QueryClient } from '@tanstack/query-core'
import type { SchemaDef } from '@zenstackhq/orm/schema'
import type { ChangeBatch } from '../live/events'
import { type LiveTopic, queryTopics, topicKey, topicValue } from '../live/topics'
import { delegateTables } from '../schema-utils'
import { getZenStackQueries } from './cache'

/** Query `meta` flag marking live queries. */
export const LIVE_META_KEY = 'zenstackLive'

export type ChangesCall = (
  input: { topics: LiveTopic[] },
  options: { signal: AbortSignal; lastEventId?: string },
) => Promise<AsyncIterable<ChangeBatch>>

type LiveQuery = ReturnType<typeof getZenStackQueries>[number]['query']

export interface LiveManagerOptions {
  schema: SchemaDef
  root: readonly string[]
  changes: ChangesCall
  /** Delay before (re)subscribing after the set of watched topics changes (ms). @default 50 */
  debounce?: number
  /** Invalidates every live query after a reconnection, in case events were missed. @default true */
  resyncOnReconnect?: boolean
  /**
   * Minimum delay between two refetches of a live query (ms). The first change refetches right
   * away; changes arriving during the delay are merged into one refetch at its end. Overridable
   * per query with `liveOptions({ throttle })`. @default 0
   */
  throttle?: number
}

/** `meta[LIVE_META_KEY]` of a live query. */
export interface LiveQueryMeta {
  throttle?: number
}

function backoff(failures: number): number {
  return 250 + Math.random() * Math.min(1000 * 2 ** failures, 15_000)
}

/**
 * Keeps one `$changes` subscription per `QueryClient`, covering the topics of the live queries
 * currently observed (see `queryTopics`: `message.findMany({ where: { conversationId } })`
 * watches that conversation's messages only), and invalidates the live queries whose topics
 * changed.
 *
 * Changes carry no data: affected queries refetch through their regular, policy-checked procedure.
 */
export class LiveManager {
  private readonly queryClient: QueryClient
  private readonly options: LiveManagerOptions
  private topics = ''
  private controller: AbortController | undefined
  private lastEventId: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly unsubscribe: () => void
  /**
   * Last refetch and pending throttled refetch, per query hash: of the whole query, or of some
   * pages of an infinite query.
   */
  private readonly throttled = new Map<
    string,
    { last: number; timer?: ReturnType<typeof setTimeout>; pages?: Set<number> | 'all' }
  >()

  constructor(queryClient: QueryClient, options: LiveManagerOptions) {
    this.queryClient = queryClient
    this.options = options
    this.unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === 'observerAdded' ||
        event.type === 'observerRemoved' ||
        event.type === 'removed'
      ) {
        if ((event.query.meta as any)?.[LIVE_META_KEY]) this.schedule()
      }
      if (event.type === 'removed') {
        clearTimeout(this.throttled.get(event.query.queryHash)?.timer)
        this.throttled.delete(event.query.queryHash)
      }
    })
    this.schedule()
  }

  /** Live queries currently observed by a component. */
  private liveQueries(): ReturnType<typeof getZenStackQueries> {
    return getZenStackQueries(this.queryClient, this.options.schema, this.options.root).filter(
      ({ query }) => (query.meta as any)?.[LIVE_META_KEY] && query.getObserversCount() > 0,
    )
  }

  private topicsOf(model: string, args: unknown): LiveTopic[] {
    return queryTopics(this.options.schema, model, args)
  }

  private schedule() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.sync(), this.options.debounce ?? 50)
  }

  private sync() {
    const topics = new Map<string, LiveTopic>()
    for (const { model, args } of this.liveQueries()) {
      for (const topic of this.topicsOf(model, args)) topics.set(topicKey(topic), topic)
    }
    const key = [...topics.keys()].sort().join('|')
    if (key === this.topics) return
    this.topics = key
    this.controller?.abort()
    this.controller = undefined
    if (topics.size > 0) void this.run([...topics.values()])
  }

  private async run(topics: LiveTopic[]) {
    const controller = new AbortController()
    this.controller = controller
    let failures = 0
    while (!controller.signal.aborted) {
      try {
        const iterator = await this.options.changes(
          { topics },
          { signal: controller.signal, lastEventId: this.lastEventId },
        )
        if (failures > 0 && this.options.resyncOnReconnect !== false) this.invalidateAll()
        failures = 0
        for await (const batch of iterator) {
          this.lastEventId = getEventMeta(batch)?.id ?? this.lastEventId
          this.apply(batch)
        }
        if (controller.signal.aborted) return
      } catch {
        if (controller.signal.aborted) return
      }
      failures++
      await new Promise((resolve) => setTimeout(resolve, backoff(failures)))
    }
  }

  private invalidateAll() {
    for (const { queryKey } of this.liveQueries()) {
      void this.queryClient.invalidateQueries({ queryKey, exact: true })
    }
  }

  /** Refreshes the live queries whose topics changed. */
  apply(batch: ChangeBatch) {
    for (const { model, args, type, query } of this.liveQueries()) {
      const topics = new Set(this.topicsOf(model, args).map(topicKey))
      const changes = batch.changes.filter((change) => change.topics.some((t) => topics.has(t)))
      if (changes.length === 0) continue
      this.refetch(
        query,
        model,
        type === 'infinite' ? this.changedPages(query, model, changes) : 'all',
      )
    }
  }

  /**
   * Pages of an infinite query holding the records a batch updated, or `'all'`. Only updates of
   * loaded records can be narrowed: creates and deletes shift the pages, and an update of a
   * record that isn't loaded may bring it into the list.
   */
  private changedPages(
    query: LiveQuery,
    model: string,
    changes: ChangeBatch['changes'],
  ): Set<number> | 'all' {
    const data = query.state.data as { pages?: unknown[] } | undefined
    const idFields = this.options.schema.models[model]?.idFields ?? []
    if (!Array.isArray(data?.pages) || idFields.length !== 1) return 'all'
    // Records of a `@@delegate` hierarchy share their ids.
    const tables = delegateTables(this.options.schema, model)
    const pages = new Set<number>()
    for (const change of changes) {
      if (change.action !== 'update' || !change.ids?.length || !tables.includes(change.model)) {
        return 'all'
      }
      for (const id of change.ids) {
        const page = data.pages.findIndex(
          (records) =>
            Array.isArray(records) &&
            records.some((record) => topicValue(record?.[idFields[0]]) === id),
        )
        if (page === -1) return 'all'
        pages.add(page)
      }
    }
    return pages
  }

  /** Refreshes a live query (or some of its pages), at most once per `throttle` window. */
  private refetch(query: LiveQuery, model: string, pages: Set<number> | 'all') {
    const meta = (query.meta as any)?.[LIVE_META_KEY] as LiveQueryMeta | true | undefined
    const throttle =
      (typeof meta === 'object' ? meta.throttle : undefined) ?? this.options.throttle ?? 0
    const state = this.throttled.get(query.queryHash) ?? { last: 0 }
    this.throttled.set(query.queryHash, state)
    // Pending changes are merged: some pages, or the whole query.
    state.pages =
      state.pages === 'all' || pages === 'all' ? 'all' : new Set([...(state.pages ?? []), ...pages])
    const run = () => {
      const pending = state.pages
      state.pages = undefined
      state.last = Date.now()
      if (pending === 'all' || !pending) this.invalidate(query)
      else void this.refetchPages(query, model, [...pending])
    }
    if (state.timer) return // a refetch is already scheduled: it will include this change
    const wait = throttle <= 0 ? 0 : state.last + throttle - Date.now()
    if (wait <= 0) return run()
    state.timer = setTimeout(() => {
      state.timer = undefined
      run()
    }, wait)
  }

  private invalidate(query: LiveQuery) {
    void this.queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true })
  }

  /**
   * Refetches some pages of an infinite query and swaps them in. When a page's bounds changed
   * (an updated record left the list or moved to another page), the whole query is refetched.
   */
  private async refetchPages(query: LiveQuery, model: string, pages: number[]) {
    const data = query.state.data as { pages: unknown[][]; pageParams: unknown[] }
    const queryFn = query.options.queryFn
    if (typeof queryFn !== 'function') return this.invalidate(query)
    const idField = this.options.schema.models[model]?.idFields[0]
    const bound = (records: unknown[], index: number) =>
      topicValue((records.at(index) as Record<string, unknown> | undefined)?.[idField ?? ''])
    try {
      const fresh = (await Promise.all(
        pages.map((page) =>
          queryFn({
            queryKey: query.queryKey,
            pageParam: data.pageParams[page],
            signal: new AbortController().signal,
            meta: query.meta,
            client: this.queryClient,
            direction: 'forward',
          } as any),
        ),
      )) as unknown[][]
      // Refreshed in the meantime: nothing to swap.
      if (query.state.data !== data) return
      const sameBounds = pages.every((page, i) => {
        const [before, after] = [data.pages[page], fresh[i]]
        return (
          Array.isArray(after) &&
          after.length === before.length &&
          bound(after, 0) === bound(before, 0) &&
          bound(after, -1) === bound(before, -1)
        )
      })
      if (!sameBounds) return this.invalidate(query)
      const next = [...data.pages]
      pages.forEach((page, i) => {
        next[page] = fresh[i]
      })
      this.queryClient.setQueryData(query.queryKey, { ...data, pages: next })
    } catch {
      this.invalidate(query)
    }
  }

  dispose() {
    clearTimeout(this.timer)
    for (const { timer } of this.throttled.values()) clearTimeout(timer)
    this.controller?.abort()
    this.unsubscribe()
  }
}
