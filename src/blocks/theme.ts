import * as Blockly from 'blockly';
import { PALETTE } from './palette';

let theme: Blockly.Theme | null = null;

/** Dark workspace (matches the app) with Scratch category colours; event blocks get a hat. */
export function quantTheme(): Blockly.Theme {
  if (theme) return theme;
  const blockStyles: Record<string, Partial<Blockly.Theme.BlockStyle>> = {};
  for (const [name, [primary, secondary, tertiary]] of Object.entries(PALETTE)) {
    blockStyles[name] = { colourPrimary: primary, colourSecondary: secondary, colourTertiary: tertiary };
  }
  blockStyles.event_blocks = { ...blockStyles.event_blocks, hat: 'cap' };
  theme = Blockly.Theme.defineTheme('quant-dark', {
    name: 'quant-dark',
    base: Blockly.Themes.Classic,
    blockStyles,
    componentStyles: {
      workspaceBackgroundColour: '#1e222d',
      toolboxBackgroundColour: '#131722',
      toolboxForegroundColour: '#d1d4dc',
      flyoutBackgroundColour: '#2a2e39',
      flyoutForegroundColour: '#d1d4dc',
      flyoutOpacity: 0.95,
      scrollbarColour: '#434651',
      insertionMarkerColour: '#ffffff',
      insertionMarkerOpacity: 0.3,
      selectedGlowColour: '#ffd54f',
    },
    fontStyle: { family: "system-ui, -apple-system, 'Segoe UI', sans-serif", size: 11 },
  });
  return theme;
}
