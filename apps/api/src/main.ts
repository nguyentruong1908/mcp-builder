import { createApp } from './app.js';
import { config } from './config.js';

async function bootstrap() {
  const app = await createApp();
  await app.listen(config.port);
  console.log(`MCP Builder API on http://localhost:${config.port}/api · data: ${config.dataDir} · codex model: ${config.codexModel}`);
}

void bootstrap();
