import { createApp } from './app.js';
const { app } = await createApp();
await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3000) });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
