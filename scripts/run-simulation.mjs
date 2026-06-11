/**
 * AI-vs-AI simulation runner.
 *
 * Usage:   npm run simulate -- <games> <ai1> <ai2>
 * Example: npm run simulate -- 100 hard medium
 *
 *  - ai1 / ai2: easy | normal | medium | hard   (medium = normal)
 *  - ai1 is PLAYER 1 (takes the first turn), ai2 is PLAYER 2
 *  - Logs: sim-results/<timestamp>_<ai1>-vs-<ai2>/game-NNN_winner-X.log
 */
import { spawnSync } from 'child_process';

const games = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '10';
const ai1 = process.argv[3] || 'hard';
const ai2 = process.argv[4] || 'normal';

console.log(`Starting AI simulation: ${ai1} (Player 1) vs ${ai2} (Player 2), ${games} games...`);

const result = spawnSync(
    'npx',
    ['vitest', 'run', 'tests/ai-simulation.test.ts'],
    {
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, SIM_GAMES: games, SIM_AI1: ai1, SIM_AI2: ai2 },
    }
);

process.exit(result.status ?? 0);
