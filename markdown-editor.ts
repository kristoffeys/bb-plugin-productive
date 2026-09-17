export type MarkdownFormat =
  | 'heading'
  | 'bold'
  | 'italic'
  | 'bulleted-list'
  | 'checklist'
  | 'link'
  | 'code';

export type MarkdownEdit = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

const WRAPPED_FORMATS: Readonly<
  Record<Extract<MarkdownFormat, 'bold' | 'italic' | 'link' | 'code'>, {
    prefix: string;
    suffix: string;
    placeholder: string;
  }>
> = {
  bold: { prefix: '**', suffix: '**', placeholder: 'bold text' },
  italic: { prefix: '_', suffix: '_', placeholder: 'italic text' },
  link: { prefix: '[', suffix: '](https://)', placeholder: 'link text' },
  code: { prefix: '`', suffix: '`', placeholder: 'code' }
};

const LINE_PREFIXES: Readonly<
  Record<Extract<MarkdownFormat, 'heading' | 'bulleted-list' | 'checklist'>, string>
> = {
  heading: '## ',
  'bulleted-list': '- ',
  checklist: '- [ ] '
};

export function applyMarkdownFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  format: MarkdownFormat
): MarkdownEdit {
  if (format in WRAPPED_FORMATS) {
    const { prefix, suffix, placeholder } = WRAPPED_FORMATS[
      format as keyof typeof WRAPPED_FORMATS
    ];
    const selected = value.slice(selectionStart, selectionEnd) || placeholder;
    const replacement = `${prefix}${selected}${suffix}`;
    return {
      value: `${value.slice(0, selectionStart)}${replacement}${value.slice(selectionEnd)}`,
      selectionStart: selectionStart + prefix.length,
      selectionEnd: selectionStart + prefix.length + selected.length
    };
  }

  const lineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
  const followingBreak = value.indexOf('\n', selectionEnd);
  const lineEnd = followingBreak === -1 ? value.length : followingBreak;
  const selectedLines = value.slice(lineStart, lineEnd) || 'List item';
  const prefix = LINE_PREFIXES[format as keyof typeof LINE_PREFIXES];
  const replacement = selectedLines
    .split('\n')
    .map(line => `${prefix}${line}`)
    .join('\n');

  return {
    value: `${value.slice(0, lineStart)}${replacement}${value.slice(lineEnd)}`,
    selectionStart: lineStart,
    selectionEnd: lineStart + replacement.length
  };
}
