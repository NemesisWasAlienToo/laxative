/** A single annotation. Notes never live in the source file they point at. */
export interface Note {
  /** Stable short id, used as the target of `[[...]]` references. */
  id: string;
  title: string;
  /** Markdown. May contain `[[other-note-id]]` references. */
  body: string;
  /** Workspace-relative, posix-separated path of the annotated file. */
  file: string;
  /** 0-based line of the anchor. */
  line: number;
  /** 0-based column of the anchor within that line. */
  character: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NoteStoreFile {
  version: 1;
  notes: Note[];
}

export const STORE_VERSION = 1 as const;
