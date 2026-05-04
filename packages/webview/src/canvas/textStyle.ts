import { DEFAULT_FONT_SIZE, type TextAlign, type TextStyle } from '@agentic-whiteboard/shared';
import type { SceneElement } from './types';

export interface EffectiveTextStyle {
  fontSize: number;
  bold: boolean;
  align: TextAlign;
}

const pick = (d: TextStyle, fontSize: number, bold: boolean, align: TextAlign) => ({
  fontSize: d.fontSize ?? fontSize,
  bold: d.bold ?? bold,
  align: d.align ?? align,
});

/**
 * The text style an element is drawn with, defaults filled in, or undefined for elements whose
 * text cannot be styled. The defaults are each element's original look.
 */
export function textStyleOf(el: SceneElement): EffectiveTextStyle | undefined {
  switch (el.kind) {
    case 'node':
      return el.data.kind === 'file'
        ? pick(el.data, 13, true, 'left')
        : pick(el.data, 15, true, 'center');
    case 'comment':
      return pick(el.data, 13, false, 'left');
    case 'shape':
      switch (el.data.type) {
        case 'text':
          return pick(el.data, DEFAULT_FONT_SIZE.text, false, 'left');
        case 'rect':
        case 'ellipse':
        case 'diamond':
          return pick(el.data, DEFAULT_FONT_SIZE.box, false, 'center');
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}
