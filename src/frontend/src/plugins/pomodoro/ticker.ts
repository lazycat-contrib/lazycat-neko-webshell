type PomodoroTickerOptions = {
  shouldRender: () => boolean;
  onRender: () => void;
};

export function createPomodoroTicker(options: PomodoroTickerOptions) {
  let timer: number | undefined;

  function tick() {
    if (options.shouldRender()) {
      options.onRender();
    }
  }

  return {
    start() {
      tick();
      window.clearInterval(timer);
      timer = window.setInterval(tick, 1000);
    },
  };
}
