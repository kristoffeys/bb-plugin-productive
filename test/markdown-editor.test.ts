import { describe, expect, it } from 'vitest';
import { applyMarkdownFormat } from '../markdown-editor.js';

describe('applyMarkdownFormat', () => {
  it('wraps a selection and keeps the selected text selected', () => {
    expect(applyMarkdownFormat('make this clear', 5, 9, 'bold')).toEqual({
      value: 'make **this** clear',
      selectionStart: 7,
      selectionEnd: 11
    });
  });

  it('inserts useful placeholder text when the selection is empty', () => {
    expect(applyMarkdownFormat('', 0, 0, 'link')).toEqual({
      value: '[link text](https://)',
      selectionStart: 1,
      selectionEnd: 10
    });
  });

  it('prefixes every selected line for list formats', () => {
    expect(applyMarkdownFormat('Before\nFirst\nSecond\nAfter', 7, 19, 'checklist')).toEqual({
      value: 'Before\n- [ ] First\n- [ ] Second\nAfter',
      selectionStart: 7,
      selectionEnd: 31
    });
  });
});
