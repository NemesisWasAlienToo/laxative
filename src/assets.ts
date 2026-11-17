import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { NOTES_DIR } from './core/noteFiles';
import { NOTE_SCHEME } from './noteDocuments';

/**
 * Images in notes. `![](x.png)` is looked for in `.laxative/` first and then in
 * the project root, so `assets/x.png` is an image kept with the notes and
 * `docs/diagram.png` is one already in the project. Web images and `data:`
 * images are left as they are.
 *
 * Pasted or dropped images are saved in `.laxative/assets/`, and the link to
 * them written where the cursor is.
 */

export const ASSETS_DIR = 'assets';

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp'
};
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

function root(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** Inside `folder`, not above it: `../../etc/x` is not an image in the project. */
function inside(folder: vscode.Uri, file: vscode.Uri): boolean {
  const relative = path.posix.relative(folder.path, file.path);
  return relative !== '' && !relative.startsWith('..') && !path.posix.isAbsolute(relative);
}

function exists(uri: vscode.Uri): boolean {
  // Only local files can be checked without waiting; anywhere else the first
  // place is taken on trust.
  return uri.scheme !== 'file' || fs.existsSync(uri.fsPath);
}

/**
 * The file an image link in a note points at, or undefined when it is a web
 * or `data:` image (left alone) or points outside the project.
 */
export function resolveImage(src: string): vscode.Uri | undefined {
  const base = root();
  if (!base || src === '' || HAS_SCHEME.test(src) || src.startsWith('//')) {
    return undefined;
  }
  let relative: string;
  try {
    relative = decodeURIComponent(src.split(/[?#]/)[0]);
  } catch {
    relative = src;
  }
  relative = relative.replace(/\\/g, '/');
  const fromRoot = relative.startsWith('/');
  relative = relative.replace(/^\/+/, '').replace(/^(\.\/)+/, '');
  const candidates = fromRoot
    ? [vscode.Uri.joinPath(base, relative)]
    : [vscode.Uri.joinPath(base, NOTES_DIR, relative), vscode.Uri.joinPath(base, relative)];
  const usable = candidates.filter((uri) => inside(base, uri));
  return usable.find(exists) ?? undefined;
}

/** `![alt](src "title")` in markdown, with the link's own parts. */
const IMAGE_LINK = /(!\[[^\]]*\]\()\s*(<[^>]*>|[^)\s]+)(\s+"[^"]*")?\s*\)/g;

/** The body with each local image link swapped for what `link` makes of it. */
export function rewriteImages(body: string, link: (uri: vscode.Uri) => string): string {
  return body.replace(IMAGE_LINK, (whole, open: string, src: string, title: string | undefined) => {
    const target = resolveImage(src.replace(/^<|>$/g, ''));
    return target ? `${open}${link(target)}${title ?? ''})` : whole;
  });
}

/** A file name not yet used in `.laxative/assets/`. */
async function freeName(folder: vscode.Uri, wanted: string): Promise<string> {
  const ext = path.extname(wanted);
  const stem = path.basename(wanted, ext).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
  for (let i = 0; i < 1000; i++) {
    const name = i === 0 ? `${stem}${ext}` : `${stem}-${i}${ext}`;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, name));
    } catch {
      return name;
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** Saves an image in `.laxative/assets/` and returns its link, `assets/<name>`. */
export async function saveAsset(name: string, data: Uint8Array): Promise<string | undefined> {
  const base = root();
  if (!base) {
    return undefined;
  }
  const folder = vscode.Uri.joinPath(base, NOTES_DIR, ASSETS_DIR);
  await vscode.workspace.fs.createDirectory(folder);
  const free = await freeName(folder, name);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, free), data);
  return `${ASSETS_DIR}/${encodeURI(free)}`;
}

function markdownFor(link: string, alt: string): string {
  return `![${alt.replace(/[[\]]/g, '')}](${link})`;
}

/**
 * The links for whatever was pasted or dropped: images files in the project
 * are linked where they are, anything else is copied into `.laxative/assets/`.
 */
async function linksFor(data: vscode.DataTransfer): Promise<string[]> {
  const base = root();
  const links: string[] = [];
  const uriList = await data.get('text/uri-list')?.asString();
  if (uriList) {
    for (const line of uriList.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(line, true);
      } catch {
        continue;
      }
      if (!IMAGE_FILE.test(uri.path)) {
        continue;
      }
      const alt = path.basename(uri.path).replace(IMAGE_FILE, '');
      if (base && inside(base, uri)) {
        const notes = vscode.Uri.joinPath(base, NOTES_DIR);
        const relative = inside(notes, uri)
          ? path.posix.relative(notes.path, uri.path)
          : '/' + path.posix.relative(base.path, uri.path);
        links.push(markdownFor(encodeURI(relative), alt));
        continue;
      }
      try {
        const saved = await saveAsset(path.basename(uri.path), await vscode.workspace.fs.readFile(uri));
        if (saved) {
          links.push(markdownFor(saved, alt));
        }
      } catch {
        // Unreadable: nothing to link.
      }
    }
    if (links.length > 0) {
      return links;
    }
  }
  for (const [mime, item] of data) {
    const ext = IMAGE_TYPES[mime];
    const file = ext ? item.asFile() : undefined;
    if (!file) {
      continue;
    }
    const name = file.name && IMAGE_FILE.test(file.name) ? file.name : `pasted-${stamp()}.${ext}`;
    const saved = await saveAsset(name, await file.data());
    if (saved) {
      links.push(markdownFor(saved, path.basename(name).replace(IMAGE_FILE, '')));
    }
  }
  return links;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

/**
 * Pasting and dropping images into a note's editor. Dropping works on every
 * VS Code this extension supports; pasting an image needs a newer one (the
 * paste API arrived later), and is simply not offered on an older one.
 */
export function registerImageInput(): vscode.Disposable[] {
  const selector: vscode.DocumentSelector = { scheme: NOTE_SCHEME };
  const disposables: vscode.Disposable[] = [
    vscode.languages.registerDocumentDropEditProvider(selector, {
      async provideDocumentDropEdits(_document, _position, data) {
        const links = await linksFor(data);
        return links.length > 0 ? new vscode.DocumentDropEdit(links.join('\n')) : undefined;
      }
    })
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = vscode as any;
  if (typeof api.languages.registerDocumentPasteEditProvider === 'function' && api.DocumentDropOrPasteEditKind) {
    const kind = api.DocumentDropOrPasteEditKind.Empty.append('laxative', 'image');
    disposables.push(
      api.languages.registerDocumentPasteEditProvider(
        selector,
        {
          async provideDocumentPasteEdits(
            _document: vscode.TextDocument,
            _ranges: readonly vscode.Range[],
            data: vscode.DataTransfer
          ) {
            const links = await linksFor(data);
            return links.length > 0
              ? [new api.DocumentPasteEdit(links.join('\n'), 'Insert image', kind)]
              : undefined;
          }
        },
        { providedPasteEditKinds: [kind], pasteMimeTypes: [...Object.keys(IMAGE_TYPES), 'text/uri-list', 'files'] }
      )
    );
  }
  return disposables;
}

/** Laxative: Insert Image… — picks image files and links them at the cursor. */
export async function insertImage(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== NOTE_SCHEME) {
    void vscode.window.showInformationMessage('Laxative: open a note for editing first.');
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    defaultUri: root(),
    filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] },
    openLabel: 'Insert'
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const data = new vscode.DataTransfer();
  data.set('text/uri-list', new vscode.DataTransferItem(picked.map((uri) => uri.toString()).join('\r\n')));
  const links = await linksFor(data);
  if (links.length > 0) {
    await editor.edit((edit) => edit.replace(editor.selection, links.join('\n')));
  }
}
