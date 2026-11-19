const PROJECT_POLL_INTERVAL_MS = 15_000;

export function startProjectPolling(
  page: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>,
  check: (signal: AbortSignal) => Promise<void>,
) {
  let inFlight: AbortController | undefined;
  const cancel = () => {
    inFlight?.abort();
    inFlight = undefined;
  };
  const tick = async () => {
    if (page.visibilityState !== 'visible' || inFlight) return;
    const controller = new AbortController();
    inFlight = controller;
    try { await check(controller.signal); }
    finally { if (inFlight === controller) inFlight = undefined; }
  };
  const visibilityChanged = () => {
    if (page.visibilityState === 'visible') void tick();
    else cancel();
  };
  const timer = setInterval(() => { void tick(); }, PROJECT_POLL_INTERVAL_MS);
  page.addEventListener('visibilitychange', visibilityChanged);
  return () => {
    clearInterval(timer);
    page.removeEventListener('visibilitychange', visibilityChanged);
    cancel();
  };
}
