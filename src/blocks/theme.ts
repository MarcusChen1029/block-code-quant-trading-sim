import * as Blockly from 'blockly';
import { PALETTE } from './palette';

const themes = new Map<'dark' | 'light', Blockly.Theme>();

/** Workspace colours per app theme (the blocks keep their Scratch category colours in both). */
const COMPONENTS: Record<'dark' | 'light', Blockly.Theme.ComponentStyle> = {
  dark: {
    workspaceBackgroundColour: '#161b26',
    toolboxBackgroundColour: '#111620',
    toolboxForegroundColour: '#e3e6ee',
    flyoutBackgroundColour: '#232a38',
    flyoutForegroundColour: '#e3e6ee',
    flyoutOpacity: 0.96,
    scrollbarColour: '#465066',
    insertionMarkerColour: '#ffffff',
    insertionMarkerOpacity: 0.3,
    selectedGlowColour: '#ffd54f',
  },
  light: {
    workspaceBackgroundColour: '#f7f8fb',
    toolboxBackgroundColour: '#ffffff',
    toolboxForegroundColour: '#1b2130',
    flyoutBackgroundColour: '#eceff5',
    flyoutForegroundColour: '#1b2130',
    flyoutOpacity: 0.97,
    scrollbarColour: '#b9c0ce',
    insertionMarkerColour: '#000000',
    insertionMarkerOpacity: 0.2,
    selectedGlowColour: '#f59e0b',
  },
};

/** The block workspace theme matching the app's dark or light colours; event blocks get a hat. */
export function quantTheme(mode: 'dark' | 'light' = 'dark'): Blockly.Theme {
  const cached = themes.get(mode);
  if (cached) return cached;
  const blockStyles: Record<string, Partial<Blockly.Theme.BlockStyle>> = {};
  for (const [name, [primary, secondary, tertiary]] of Object.entries(PALETTE)) {
    blockStyles[name] = { colourPrimary: primary, colourSecondary: secondary, colourTertiary: tertiary };
  }
  blockStyles.event_blocks = { ...blockStyles.event_blocks, hat: 'cap' };
  const name = `quant-${mode}`;
  const theme = Blockly.Theme.defineTheme(name, {
    name,
    base: Blockly.Themes.Classic,
    blockStyles,
    componentStyles: COMPONENTS[mode],
    fontStyle: { family: "system-ui, -apple-system, 'Segoe UI', sans-serif", size: 11 },
  });
  themes.set(mode, theme);
  return theme;
}
