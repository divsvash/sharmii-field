import { isValidFilesystemPath } from '../../src/shared/filesystemPath';

describe('isValidFilesystemPath', () => {
  it('accepts a file:// URI', () => {
    expect(isValidFilesystemPath('file:///data/selfies/a.jpg')).toBe(true);
  });

  it('rejects an empty or whitespace-only string', () => {
    expect(isValidFilesystemPath('')).toBe(false);
    expect(isValidFilesystemPath('   ')).toBe(false);
  });

  it('rejects a base64 data URI (invariant 7)', () => {
    expect(isValidFilesystemPath('data:image/jpeg;base64,/9j/4AAQSkZJRg==')).toBe(false);
  });
});
