"use client";

import { useStream } from "@langchain/langgraph-sdk/react";
import { useEffect, useRef } from "react";
import { AGENT_URL, ASSISTANT_ID, type LiveBridgeHandle, type LiveEvent, type LiveValues, type WireMessage, live } from "@/lib/live";

/**
 * Renders nothing. Owns the stream to the LangGraph agent for one run and
 * pushes what it hears into the live store.
 */
export default function LiveBridge({ run }: { run: number }) {
  const options = {
    apiUrl: AGENT_URL,
    assistantId: ASSISTANT_ID,
    // The region agents' own messages stay out of the lead's chat. (The hook reads
    // this option but only types it for typed deep agents.)
    filterSubagentMessages: true,
    onCustomEvent: (data: unknown) => live?.event(run, data as LiveEvent),
    onError: (err: unknown) => live?.fail(run, err),
  };
  const stream = useStream<LiveValues>(options);
  const latest = useRef(stream);

  useEffect(() => {
    latest.current = stream;
    live?.sync(run, {
      values: stream.values,
      messages: stream.messages as unknown as WireMessage[],
      interrupt: stream.interrupt,
      isLoading: stream.isLoading,
      error: stream.error,
    });
  });

  useEffect(() => {
    const handle: LiveBridgeHandle = {
      submit: (input, resume) =>
        void latest.current.submit(input, {
          ...(resume === undefined ? {} : { command: { resume } }),
          // Simulation events are emitted inside the region agents.
          streamSubgraphs: true,
          streamMode: ["values", "messages-tuple", "custom"],
          optimisticValues: input?.messages ? (prev) => ({ messages: [...(prev.messages ?? []), ...input.messages!] }) : undefined,
        }),
      stop: () => void latest.current.stop(),
    };
    live?.attach(run, handle);
    // Deferred so React's double-invoked effects in development start one run, not two.
    const id = setTimeout(() => live?.begin(run), 0);
    return () => {
      clearTimeout(id);
      live?.detach(handle);
    };
  }, [run]);

  return null;
}
