import MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';
import { Note } from './core/types';
import { expandRefs } from './core/refs';

// `html: false` keeps raw HTML out of the webview; notes are plain markdown.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

function resolver(notes: readonly Note[], href: (note: Note) => string) {
  return (id: string) => {
    const target = notes.find((n) => n.id === id);
    return target ? { href: href(target), label: target.title } : undefined;
  };
}

export function commandUri(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

/** HTML for the note webview. `[[refs]]` become `laxative:<id>` links. */
export function renderHtml(body: string, notes: readonly Note[]): string {
  return md.render(expandRefs(body, resolver(notes, (n) => `laxative:${n.id}`)));
}

/** Hover card shown on an annotated line, with working action links. */
export function hoverMarkdown(notesOnLine: readonly Note[], all: readonly Note[]): vscode.MarkdownString {
  const hover = new vscode.MarkdownString();
  hover.isTrusted = true;
  hover.supportHtml = false;
  notesOnLine.forEach((note, index) => {
    if (index > 0) {
      hover.appendMarkdown('\n\n---\n\n');
    }
    const resolve = resolver(all, (n) => commandUri('laxative.openNote', [n.id]));
    hover.appendMarkdown(`**$(comment) ${note.title}**\n\n`);
    hover.appendMarkdown(expandRefs(note.body, resolve));
    hover.appendMarkdown(
      `\n\n[$(book) Open](${commandUri('laxative.openNote', [note.id])})` +
        ` &nbsp;·&nbsp; [$(edit) Edit](${commandUri('laxative.editNote', [note.id])})` +
        ` &nbsp;·&nbsp; [$(trash) Delete](${commandUri('laxative.deleteNote', [note.id])})`
    );
  });
  return hover;
}
