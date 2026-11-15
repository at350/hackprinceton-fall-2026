"use client";

import { useStream } from "@langchain/langgraph-sdk/react";
import { useEffect, useRef, useState } from "react";
import { HANDOFF_NAMESPACE } from "@/lib/handoff";
import { AGENT_URL, ASSISTANT_ID, type LiveBridgeHandle, type LiveEvent, type LiveValues, type WireMessage, live } from "@/lib/live";

const STREAM_MODE = ["values", "messages-tuple", "custom"] as const;
const POLL_MS = 2000;

/**
 * Renders nothing. Owns the stream to the LangGraph agent for one run and
 * pushes what it hears into the live store. Once the pre-alert has gone out it
 * also follows the hand-off: the Store record, and runs the Photon bridge
 * starts on the same thread when the clinician texts back.
 */
export default function LiveBridge({ run }: { run: number }) {
  // The run's thread when a hot reload remounted this bridge. Dev aid: ?thread=<id> opens an
  // existing thread instead of waiting for Run scan.
  const [threadId, setThreadId] = useState<string | null>(
    () =>
      live.thread(run) ??
      (run === 0 && process.env.NODE_ENV !== "production" ? new URLSearchParams(location.search).get("thread") : null),
  );
  // Runs this page started; any other run on the thread is the bridge's.
  const own = useRef(new Set<string>());
  const options = {
    apiUrl: AGENT_URL,
    assistantId: ASSISTANT_ID,
    // The region agents' own messages stay out of the lead's chat. (The hook reads
    // this option but only types it for typed deep agents.)
    filterSubagentMessages: true,
    threadId,
    onThreadId: setThreadId,
    onCreated: (meta: { run_id: string }) => void own.current.add(meta.run_id),
    onCustomEvent: (data: unknown) => live.event(run, data as LiveEvent),
    onError: (err: unknown) => live.fail(run, err),
  };
  const stream = useStream<LiveValues>(options);
  const latest = useRef(stream);
  const synced = useRef<unknown[]>([]);

  useEffect(() => {
    if (threadId) live.setThread(run, threadId);
  }, [threadId, run]);

  useEffect(() => {
    latest.current = stream;
    const snap = {
      values: stream.values,
      messages: stream.messages as unknown as WireMessage[],
      interrupt: stream.interrupt,
      isLoading: stream.isLoading,
      error: stream.error,
    };
    // Only what changed: a re-render with the same data must not undo a thread-state read.
    const parts = [snap.values, snap.messages, snap.interrupt, snap.isLoading, snap.error];
    if (parts.every((p, i) => p === synced.current[i])) return;
    synced.current = parts;
    live.sync(run, snap);
  });

  // A hot reload rebuilds the hook: it comes back idle, without the thread's messages
  // or the run it was streaming (the store keeps what it showed). Join that run again,
  // or read the thread if it is over.
  const rejoining = useRef(false);
  useEffect(() => {
    if (!threadId || stream.isLoading || rejoining.current || !live.behind(run, stream.messages.length)) return;
    rejoining.current = true;
    const client = stream.client;
    void (async () => {
      try {
        const [newest] = await client.runs.list(threadId, { limit: 1 });
        if (newest?.status === "pending" || newest?.status === "running")
          await latest.current.joinStream(newest.run_id, undefined, { streamMode: [...STREAM_MODE] }).catch(() => {});
        if (!latest.current.isLoading) live.syncState(run, await client.threads.getState<LiveValues>(threadId), true);
      } catch {
        // The server is busy or down: the chat keeps what it showed.
      } finally {
        rejoining.current = false;
      }
    })();
  });

  useEffect(() => {
    const handle: LiveBridgeHandle = {
      submit: (input, resume) =>
        void latest.current.submit(input, {
          ...(resume === undefined ? {} : { command: { resume } }),
          // Simulation events are emitted inside the region agents.
          streamSubgraphs: true,
          streamMode: [...STREAM_MODE],
          // The run carries on when the stream drops (a hot reload), and a rejoin replays it from its start.
          streamResumable: true,
          // Always the thread's latest checkpoint. The hook would otherwise send its own branch
          // head, which a hot reload leaves stale: an approval then resumed from the start.
          checkpoint: null,
          optimisticValues: input?.messages ? (prev) => ({ messages: [...(prev.messages ?? []), ...input.messages!] }) : undefined,
        }),
      stop: () => void latest.current.stop(),
    };
    live.attach(run, handle);
    // Deferred so React's double-invoked effects in development start one run, not two.
    const id = setTimeout(() => live.begin(run), 0);
    return () => {
      clearTimeout(id);
      live.detach(handle);
    };
  }, [run]);

  // The hand-off, every 2 s once the pre-alert has gone out. Stops with this
  // component: a new scan mounts a new bridge on a new thread.
  useEffect(() => {
    if (!threadId) return;
    const store = live;
    const client = latest.current.client;
    const seen = new Set<string>();
    let reading = false;
    let following = false;

    // Delivery, read, reply and call change outside any run; the Store record has them.
    const readRecord = async () => {
      if (reading) return;
      reading = true;
      try {
        const item = await client.store.getItem(HANDOFF_NAMESPACE, threadId);
        store.setHandoffRecord(run, item?.value ?? null);
      } catch {
        // No record yet, or the server is busy: the next tick tries again.
      } finally {
        reading = false;
      }
    };

    // A run this page did not start is the bridge answering the clinician: join it.
    const followRuns = async () => {
      if (following || !store.idle(run) || latest.current.isLoading) return;
      following = true;
      try {
        const [newest] = await client.runs.list(threadId, { limit: 1 });
        if (!newest || own.current.has(newest.run_id) || seen.has(newest.run_id)) return;
        seen.add(newest.run_id);
        if (newest.status === "pending" || newest.status === "running") {
          // Replays the run from its start, so the clinician's message and Lucid's answer both arrive.
          await latest.current.joinStream(newest.run_id, undefined, { streamMode: [...STREAM_MODE] }).catch(() => {});
        }
        // Finished before we saw it, or the join failed: read the thread instead.
        if (!latest.current.isLoading && store.idle(run)) store.syncState(run, await client.threads.getState<LiveValues>(threadId));
      } catch {
        // The next tick tries again.
      } finally {
        following = false;
      }
    };

    const id = setInterval(() => {
      if (!store.handoffOpen(run)) return;
      void readRecord();
      void followRuns();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [threadId, run]);

  return null;
}
