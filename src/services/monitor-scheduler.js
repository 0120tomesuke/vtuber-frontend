export function startMonitorScheduler({ monitorService, logger = console, tickMs = 30_000 }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await monitorService.run();
      if (!result.skipped) logger.info('Monitor run completed.', result);
    } catch (error) {
      logger.error('Unhandled monitor scheduler error.', error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), tickMs);
  return () => clearInterval(timer);
}

