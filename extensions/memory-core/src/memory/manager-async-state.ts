// Memory Core plugin module implements manager async state behavior.
export function startAsyncSearchSync(params: {
  enabled: boolean;
  dirty: boolean;
  sessionsDirty: boolean;
  nonblocking?: boolean;
  sync: (params: { reason: string }) => Promise<void>;
  onError: (err: unknown) => void;
}): Promise<void> | void {
  if (!params.enabled || (!params.dirty && !params.sessionsDirty)) {
    return;
  }
  if (params.nonblocking) {
    // A deadline-bounded caller (nonblocking) can enumerate and parse a large
    // transcript corpus. Keep the existing sync admission/close ownership while
    // letting indexed searches proceed.
    void params.sync({ reason: "search" }).catch(params.onError);
    return;
  }
  try {
    const sync = params.sync({ reason: "search" });
    return sync.catch((err: unknown) => {
      params.onError(err);
    });
  } catch (err: unknown) {
    params.onError(err);
  }
}

export async function awaitPendingManagerWork(params: {
  pendingSync?: Promise<void> | null;
  pendingProviderInit?: Promise<void> | null;
  onError?: (err: unknown) => void;
}): Promise<void> {
  if (params.pendingSync) {
    try {
      await params.pendingSync;
    } catch (err: unknown) {
      params.onError?.(err);
    }
  }
  if (params.pendingProviderInit) {
    try {
      await params.pendingProviderInit;
    } catch (err: unknown) {
      params.onError?.(err);
    }
  }
}
