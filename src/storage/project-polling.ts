const PROJECT_POLL_INTERVAL_MS = 120_000;

export function startProjectPolling(
  page: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>,
  check: (signal: AbortSignal, reason: 'poll' | 'edit') => Promise<void | boolean>,
  intervalMs = PROJECT_POLL_INTERVAL_MS,
) {
  let inFlight: AbortController | undefined;
  let lastCheckedAt: number | undefined;
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const schedule = (delay = intervalMs) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => { void tick('poll'); }, delay);
  };
  const cancel = () => {
    inFlight?.abort();
    inFlight = undefined;
  };
  const tick = async (reason: 'poll' | 'edit', minAge = 0) => {
    if (stopped || page.visibilityState !== 'visible' || inFlight
      || (lastCheckedAt !== undefined && Date.now() - lastCheckedAt < minAge)) return;
    const controller = new AbortController();
    inFlight = controller;
    const started = Date.now();
    let delay = intervalMs;
    try {
      const checked = await check(controller.signal, reason);
      if (!controller.signal.aborted && checked !== false) {
        lastCheckedAt = started;
        delay = Math.max(0, intervalMs - (Date.now() - started));
      }
    } finally {
      if (inFlight === controller) { inFlight = undefined; schedule(delay); }
    }
  };
  const visibilityChanged = () => {
    if (page.visibilityState === 'visible') void tick('poll');
    else cancel();
  };
  schedule();
  page.addEventListener('visibilitychange', visibilityChanged);
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    page.removeEventListener('visibilitychange', visibilityChanged);
    cancel();
  };
  return Object.assign(stop, {
    edited: () => { void tick('edit', 20_000); },
    reset: () => { cancel(); lastCheckedAt = undefined; schedule(); },
  });
}
