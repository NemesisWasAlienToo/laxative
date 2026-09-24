/** A single annotation. Notes never live in the source file they point at. */
export interface Note {
  /** Stable short id, used as the target of `[[...]]` references. */
  id: string;
  title: string;
  /** Markdown. May contain `[[other-note-id]]` references. */
  body: string;
  /**
   * Where the note points, when it points anywhere. A note with no location is
   * just a note: it belongs to the workspace rather than to a line of code,
   * nothing is drawn in an editor for it, and it is still linked, tagged,
   * searched and shown in the graph like any other.
   *
   * All three travel together: a note has a location or it has none.
   */
  file?: string;
  /** 0-based line of the anchor. */
  line?: number;
  /** 0-based column of the anchor within that line. */
  character?: number;
  tags: string[];
  /**
   * Which note file this note was read from. Assigned when the store loads a
   * file and never written to disk: the file a note is in is where it is, not
   * something it carries.
   */
  store?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteStoreFile {
  version: 1;
  notes: Note[];
}

export const STORE_VERSION = 1 as const;
