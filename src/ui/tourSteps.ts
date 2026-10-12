/** One stop of the guided tour. `target` is a `[data-tour]` name; null centres the card on the page. */
export interface TourStep {
  target: string | null;
  title: string;
  text: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  { target: null, title: 'Welcome to Quant Sim!', text: 'Here you build a trading robot out of puzzle blocks and test it with pretend money. This 1-minute tour shows where everything is. You can leave any time.' },
  { target: 'mode', title: 'Backtest or Live', text: 'Backtest replays the past super fast, like a time machine. Live practices on prices that are happening right now. Both use pretend money.' },
  { target: 'market', title: 'Choose what to test on', text: 'Pick a coin, how long one candle lasts, when the replay starts and how much pretend money you begin with.' },
  { target: 'starter', title: 'Start from a ready-made robot', text: 'Not sure where to begin? Load an example strategy here. You can change every block in it afterwards.' },
  { target: 'strategy', title: 'Build your robot', text: 'Snap blocks together to tell your robot when to buy and sell. Open a block group on the left and drag blocks onto the grid. Hover a block to read what it does.' },
  { target: 'run', title: 'Press Run', text: 'The computer replays the past and your robot trades along the way. Try it now!' },
  { target: 'chart', title: 'Watch the chart', text: 'Each candle is a chunk of time: green went up, red went down. Arrows show every time your robot bought or sold.' },
  { target: 'results', title: 'Read the score card', text: 'The sentence at the top says how it went in plain words. The cards below explain themselves when you hover over them.' },
  { target: 'view', title: 'Make room', text: 'Every panel can be hidden or shown full page. Use the View menu, or the buttons in each panel’s header.' },
  { target: 'help', title: 'Stuck? Ask Help', text: 'Help explains every button, lists the trading words in simple language and shows the keyboard shortcuts. Have fun!' },
];

/** The steps whose target is on screen now (a hidden panel's step is skipped); the intro and outro always stay. */
export function availableSteps(steps: readonly TourStep[], isVisible: (target: string) => boolean): TourStep[] {
  return steps.filter((s) => s.target === null || isVisible(s.target));
}

/** Index after pressing Next (+1) or Back (-1); null when Back is pressed on the first step. Past the last step means "done". */
export function stepAfter(index: number, direction: 1 | -1): number | null {
  const next = index + direction;
  return next < 0 ? null : next;
}
