/**
 * Scratch-style category colours: [primary, secondary, tertiary]. Keys are Blockly block-style names; the
 * built-in Blockly blocks already use logic_blocks, loop_blocks, math_blocks, text_blocks, variable_blocks
 * and procedure_blocks, so recolouring those styles recolours them too.
 */
export const PALETTE = {
  event_blocks: ['#FFBF00', '#E6AC00', '#CC9900'],
  market_blocks: ['#4C97FF', '#4280D7', '#3373CC'],
  account_blocks: ['#5CB1D6', '#47A8D1', '#2E8EB8'],
  indicator_blocks: ['#9966FF', '#855CD6', '#774DCB'],
  logic_blocks: ['#FFAB19', '#EC9C13', '#CF8B17'],
  loop_blocks: ['#FFAB19', '#EC9C13', '#CF8B17'],
  math_blocks: ['#59C059', '#46B946', '#389438'],
  text_blocks: ['#59C059', '#46B946', '#389438'],
  variable_blocks: ['#FF8C1A', '#FF8000', '#DB6E00'],
  procedure_blocks: ['#FF6680', '#FF4D6A', '#FF3355'],
  action_blocks: ['#CF63CF', '#C94FC9', '#BD42BD'],
} as const;

export type BlockStyleName = keyof typeof PALETTE;
