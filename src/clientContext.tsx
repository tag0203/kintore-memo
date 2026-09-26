import { createContext, useContext, type ReactNode } from "react";
import type { WorkoutLogClient } from "./data/client";

const ClientContext = createContext<WorkoutLogClient | null>(null);

export function ClientProvider({
  client,
  children,
}: {
  client: WorkoutLogClient;
  children: ReactNode;
}) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useClient(): WorkoutLogClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("記録クライアントがありません");
  return client;
}
