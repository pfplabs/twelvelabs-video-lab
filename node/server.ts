import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inventoryResponse } from './api.ts';
import { FixtureInventoryProvider, type InventoryProvider } from './providers.ts';

const template = readFileSync(new URL('../ui/inventory.html', import.meta.url), 'utf8');
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[char]!);

export function renderInventory(provider: InventoryProvider) {
  const { status, payload } = inventoryResponse(provider);
  let content: string;
  if ('error' in payload) {
    content = '<p role="alert">Inventory unavailable. Could not load inventory; processing status is unknown.</p>';
  } else {
    content = `<p>${payload.videos.length} items · ${payload.eligible_count} eligible for analysis</p>`;
    if (!payload.videos.length) content += '<p>No videos in inventory.</p>';
    else {
      const headers = ['Filename', 'Status', 'Detail', 'Analysis', 'Duration', 'Source', 'License', 'Attribution'];
      const rows = payload.videos.map(video => '<tr>' + [video.filename, video.status,
        video.status_detail, video.analysis_eligible ? 'Eligible' : 'Not eligible',
        `${video.duration_seconds}s`, video.source, video.license, video.attribution]
        .map(value => `<td>${escape(value)}</td>`).join('') + '</tr>').join('');
      content += '<div class="scroll"><table><caption>Video processing inventory</caption><thead><tr>' +
        headers.map(label => `<th scope="col">${label}</th>`).join('') +
        `</tr></thead><tbody>${rows}</tbody></table></div>`;
    }
  }
  return { status, html: template.replace('{{content}}', () => content) };
}

export function makeServer(provider: InventoryProvider) {
  return createServer((request, response) => {
    if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }); response.end(); return; }
    let status: number, body: string, type: string;
    if (request.url === '/api/inventory') {
      const result = inventoryResponse(provider);
      status = result.status; body = JSON.stringify(result.payload); type = 'application/json';
    } else if (request.url === '/') {
      const result = renderInventory(provider);
      status = result.status; body = result.html; type = 'text/html';
    } else { response.writeHead(404); response.end(); return; }
    response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    response.end(body);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = makeServer(new FixtureInventoryProvider(new URL('../fixtures/inventory.json', import.meta.url)));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Offline Node inventory: http://127.0.0.1:${port}`));
}
