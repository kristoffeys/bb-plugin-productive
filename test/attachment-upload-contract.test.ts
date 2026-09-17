import { describe, expect, it } from 'vitest';
import {
  MAX_UI_ATTACHMENT_BYTES,
  attachmentUploadInputSchema
} from '../contract.js';

describe('attachmentUploadInputSchema', () => {
  it('accepts a bounded base64 attachment payload', () => {
    expect(
      attachmentUploadInputSchema.parse({
        name: 'screenshot.png',
        contentType: 'image/png',
        base64: 'AQID'
      })
    ).toEqual({
      name: 'screenshot.png',
      contentType: 'image/png',
      base64: 'AQID'
    });
  });

  it('rejects malformed attachment encoding', () => {
    expect(() =>
      attachmentUploadInputSchema.parse({
        name: 'bad.bin',
        contentType: 'application/octet-stream',
        base64: 'not base64!'
      })
    ).toThrow();
  });

  it('keeps the browser upload ceiling at five MiB', () => {
    expect(MAX_UI_ATTACHMENT_BYTES).toBe(5 * 1024 * 1024);
  });
});
