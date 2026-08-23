/**
 * Invariant 7: images are filesystem objects, never base64 blobs in
 * SQLite. This predicate is the single place that check lives — both
 * Punch.selfiePath and IncidentPhoto.filePath validate against it, so the
 * rule can't drift between the two call sites.
 */
export function isValidFilesystemPath(path: string): boolean {
  return path.trim().length > 0 && !path.startsWith('data:');
}
