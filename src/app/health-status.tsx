"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

export function HealthStatus() {
  const trpc = useTRPC();
  const { data, isPending, isError } = useQuery({
    ...trpc.health.ping.queryOptions(),
    retry: 1, // show "unreachable" quickly instead of after three slow retries
  });

  let label = "checking…";
  if (isError) label = "unreachable";
  else if (!isPending) label = data.status;

  return (
    <p className="text-sm text-zinc-600 dark:text-zinc-400">
      API: <span data-testid="api-status">{label}</span>
    </p>
  );
}
