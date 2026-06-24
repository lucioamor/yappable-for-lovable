// Debounces rapidly changing values, keeps only the latest one, and never runs
// more than one asynchronous task at a time.
(function (root) {
  "use strict";

  function createLatestTask(options) {
    const delayMs = Math.max(0, Number(options.delayMs) || 0);
    const work = options.work;
    const commit = options.commit;
    const isValid = options.isValid || (() => true);
    const onError = options.onError || (() => {});
    const setTimer = options.setTimeout || setTimeout;
    const clearTimer = options.clearTimeout || clearTimeout;

    let generation = 0;
    let timer = null;
    let pending = null;
    let running = false;

    async function flush() {
      if (running || !pending) return;
      const job = pending;
      pending = null;
      if (job.token !== generation || !isValid(job.context)) return;

      running = true;
      try {
        const result = await work(job.value, job.context);
        if (job.token === generation && isValid(job.context)) {
          commit(result, job.value, job.context);
        }
      } catch (error) {
        if (job.token === generation && isValid(job.context)) onError(error);
      } finally {
        running = false;
        // A newer value may have finished its debounce while work was running.
        if (pending && !timer) void flush();
      }
    }

    function schedule(value, context) {
      const token = ++generation;
      pending = { value, context, token };
      if (timer) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        void flush();
      }, delayMs);
      return token;
    }

    function cancel() {
      generation++;
      pending = null;
      if (timer) clearTimer(timer);
      timer = null;
    }

    return { schedule, cancel };
  }

  const api = { createLatestTask };
  root.LovableLatestTask = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
