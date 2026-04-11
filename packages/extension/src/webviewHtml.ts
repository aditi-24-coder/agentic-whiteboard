import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export function boardHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const media = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  // No remote resources and no inline scripts. React applies inline styles through the CSSOM,
  // which `style-src` without 'unsafe-inline' still allows.
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${media('webview.css')}">
  <title>Agentic Whiteboard</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${media('webview.js')}"></script>
</body>
</html>`;
}
