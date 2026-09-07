import * as vscode from 'vscode';

/**
 * Webviews fail silently: a blocked script or a zero-sized canvas looks exactly
 * like an empty note. Each webview reports what it actually put on screen, so
 * "is it even rendering?" is a question with an answer.
 */
export class Diagnostics {
  private readonly reports = new Map<string, Record<string, unknown>>();

  record(surface: string, data: Record<string, unknown>): void {
    this.reports.set(surface, { ...data, at: new Date().toISOString() });
  }

  snapshot(): Record<string, Record<string, unknown>> {
    return Object.fromEntries(this.reports);
  }

  /** Human-readable summary, shown by the Show Rendering Diagnostics command. */
  describe(): string {
    if (this.reports.size === 0) {
      return 'No webview has reported yet. Open a note or the graph first.';
    }
    return [...this.reports]
      .map(([surface, data]) => `${surface}: ${JSON.stringify(data)}`)
      .join('\n');
  }
}

export async function showDiagnostics(diagnostics: Diagnostics): Promise<void> {
  const summary = diagnostics.describe();
  const choice = await vscode.window.showInformationMessage(
    'Laxative rendering diagnostics',
    { modal: true, detail: summary },
    'Copy'
  );
  if (choice === 'Copy') {
    await vscode.env.clipboard.writeText(summary);
  }
}
