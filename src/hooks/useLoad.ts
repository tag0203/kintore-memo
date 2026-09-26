import { useEffect, useState } from "react";

interface LoadState<T> {
  status: "loading" | "ready" | "error";
  data: T | null;
  error: string | null;
  reload: () => void;
}

export function useLoad<T>(loader: () => Promise<T>, deps: readonly unknown[]): LoadState<T> {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<Omit<LoadState<T>, "reload">>({
    status: "loading",
    data: null,
    error: null,
  });

  useEffect(() => {
    let live = true;
    setState((current) => ({ status: "loading", data: current.data, error: null }));
    loader()
      .then((data) => {
        if (live) setState({ status: "ready", data, error: null });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({
          status: "error",
          data: null,
          error: error instanceof Error ? error.message : "読み込みに失敗しました",
        });
      });
    return () => {
      live = false;
    };
    // loader is recreated each render; deps identify the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  return {
    ...state,
    reload: () => setTick((value) => value + 1),
  };
}
