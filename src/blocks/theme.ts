import * as Blockly from 'blockly';
import { CANVAS_COLORS, type Theme } from '../ui/theme';
import { PALETTE } from './palette';

const themes: Partial<Record<Theme, Blockly.Theme>> = {};

/** Workspace colours that match the app in dark or light, with Scratch category colours; event blocks get a hat. */
export function quantTheme(kind: Theme = 'dark'): Blockly.Theme {
  const cached = themes[kind];
  if (cached) return cached;
  const c = CANVAS_COLORS[kind];
  const blockStyles: Record<string, Partial<Blockly.Theme.BlockStyle>> = {};
  for (const [name, [primary, secondary, tertiary]] of Object.entries(PALETTE)) {
    blockStyles[name] = { colourPrimary: primary, colourSecondary: secondary, colourTertiary: tertiary };
  }
  blockStyles.event_blocks = { ...blockStyles.event_blocks, hat: 'cap' };
  const theme = Blockly.Theme.defineTheme(`quant-${kind}`, {
    name: `quant-${kind}`,
    base: Blockly.Themes.Classic,
    blockStyles,
    componentStyles: {
      workspaceBackgroundColour: c.workspace,
      toolboxBackgroundColour: c.toolbox,
      toolboxForegroundColour: c.text,
      flyoutBackgroundColour: c.flyout,
      flyoutForegroundColour: c.text,
      flyoutOpacity: 0.95,
      scrollbarColour: c.scrollbar,
      insertionMarkerColour: kind === 'dark' ? '#ffffff' : '#3b4258',
      insertionMarkerOpacity: 0.3,
      selectedGlowColour: '#ffd54f',
    },
    fontStyle: { family: "system-ui, -apple-system, 'Segoe UI', sans-serif", size: 11 },
  });
  themes[kind] = theme;
  return theme;
}
