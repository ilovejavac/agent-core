# Agent Core

## Agent Events

See the [frontend event integration guide](FRONTEND_EVENTS.md) for JSON shapes, rendering rules, and a multi-turn example.

`AgentEvent` is a hand-written contract shared by adapters, history stores, and listeners. Event IDs identify individual events. `seq` increases for the lifetime of an adapter instance, and `timestamp` records conversion time in Unix milliseconds.

Oh My Pi keeps the same `runId` across `run.paused` and `run.resumed`. A new Pi run after a terminal event gets a new ID. Disposing the adapter ends any still-open run as cancelled. Automatic retry events report scheduled attempts and their overall outcome. Manual and automatic context compaction report start and end, including skips and cancellations. Idle compaction has no `runId`.

Apply live `message.delta` by `messageId` and `partIndex`. Live `message.ended` marks completion with `messageId` and `role`. Assistant completions carry per-message `usage` in both the live and stored events. Read complete content, including thinking summaries, from the stored `message.ended` event. Tool updates carry replaceable snapshots and use `toolCallId` to correlate concurrent calls.

`AgentEventListener` batches text and thinking deltas for up to 16 ms by default, with no character limit per batch. Switching message parts or receiving `message.ended`, `turn.ended`, or `run.ended` queues the pending text immediately. Tool calls, progress, and results go straight to the listener's send queue and can arrive while a text batch is still collecting.

Create the manager with `createManager(store, life)` and bind one listener per session with `manager.bindListener(sessionId, listener)`. A duplicate bind leaves the current listener active and returns a no-op cleanup function. Call the returned function when the connection closes. The binding lasts until explicitly removed, including across submissions and session restarts. In a multi-Pod deployment, bind on the manager running the session or forward events from that Pod through the application.

History stores receive the original non-delta events. Live delivery proceeds independently of history writes. The listener's `seq` orders live delivery within each binding and running session. Load the stored events for historical playback or to recover complete messages after reconnecting.

When `createManager` opens or reopens a session, it loads that session's events in append order and uses completed messages and tool results to seed the in-memory Pi context before processing input. Restoration does not emit historical events. Compaction summaries and provider-native metadata are unavailable in the stored event format.

## Active Sessions

`await manager.getActiveSessions()` returns the active `{sessionId, ownerId}` records from `AgentLife`, including other Pods when the adapter uses shared liveness records. The in-memory adapter supports this query. Custom adapters can implement `AgentLife.getActiveSessions()` using the same liveness rules as `alive`. The manager returns an empty list if the adapter omits this method.

## Session Close

`SessionManager.close(id)` gracefully drains the session. A close from another Pod uses the shared `HistoryStore` pending queue and waits up to 30 seconds for disposal to finish or for the targeted owner to leave. It throws on timeout or if the owner reports a disposal failure.

For multi-Pod deployments, all managers must use the same pending queues and shared `AgentLife` liveness records. Store the `ownerId` passed to `AgentLife.report`, return it from `alive`, and implement `release` to clear the record when its owner matches. This scopes a close to the running instance even if the session is later reopened. A `HistoryStore` adapter must round-trip each `PendingMessage` variant under its `session` key, including the reply queues under the reserved `@agent-core/close/` prefix. Adapters can expire close requests and replies using their `expiresAt` timestamps. Update all Pod versions and store adapters before routing cross-Pod close requests.
