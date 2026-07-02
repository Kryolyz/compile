import path from 'path';
import fs from 'fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev-only game log endpoint: the running game POSTs full-info log lines to
 * /__gamelog and they are appended to game-logs/<file> on disk. Used to
 * analyze real games against the AI. No effect on production builds.
 */
const gameLogServer = () => ({
    name: 'game-log-server',
    configureServer(server: any) {
        server.middlewares.use('/__gamelog', (req: any, res: any) => {
            if (req.method !== 'POST') {
                res.statusCode = 405;
                return res.end();
            }
            let body = '';
            req.on('data', (chunk: any) => { body += chunk; });
            req.on('end', () => {
                try {
                    const { filename, lines } = JSON.parse(body);
                    const safe = String(filename).replace(/[^a-zA-Z0-9_\-.]/g, '');
                    if (!safe || !Array.isArray(lines)) throw new Error('bad payload');
                    fs.mkdirSync('game-logs', { recursive: true });
                    fs.appendFileSync(path.join('game-logs', safe), lines.join('\n') + '\n', 'utf-8');
                    res.statusCode = 204;
                    res.end();
                } catch {
                    res.statusCode = 400;
                    res.end();
                }
            });
        });
    },
});

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      base: './',
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react(), gameLogServer()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      test: {
        globals: true,
        environment: 'node',
        include: ['**/*.test.ts'],
        setupFiles: ['./tests/setup.ts'],
      },
    };
});
