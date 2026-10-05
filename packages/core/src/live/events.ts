import type { TopicValue } from './topics'

/**
 * A change, as published by the `zenstackLive` ORM plugin. It stays on the server: subscribers
 * only receive the topics it matched.
 */
export interface ChangeEvent {
  model: string
  action: 'create' | 'update' | 'delete'
  /**
   * Values of the key fields (id and foreign keys) of the changed records, before and after the
   * change. Missing when they couldn't be read: the event then matches every topic of the model.
   */
  keys?: Record<string, TopicValue[]>
}

/** A batch of changes, as yielded by the `$changes` procedure: the subscriber's matched topics. */
export interface ChangeBatch {
  changes: {
    model: string
    action: ChangeEvent['action']
    topics: string[]
    /**
     * Ids of the updated records the subscriber can read (`update` only, single-field ids): live
     * infinite queries then refetch only the pages holding them.
     */
    ids?: TopicValue[]
  }[]
}

/** Event map used with an `@orpc/publisher` `Publisher`. */
export type ZenStackChangeEvents = Record<string, ChangeEvent>

/** Default publisher channel. */
export const DEFAULT_CHANGES_CHANNEL = 'zenstack:changes'

/** Structural subset of `@orpc/publisher`'s `Publisher` used by zenstack-orpc. */
export interface ChangesPublisher {
  publish(event: string, payload: ChangeEvent): Promise<void>
  subscribe(
    event: string,
    options?: { signal?: AbortSignal | null; lastEventId?: string | undefined },
  ): AsyncIterable<ChangeEvent>
}
