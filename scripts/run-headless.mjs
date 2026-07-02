#!/usr/bin/env node

/**
 * Headless AI vs AI simulation CLI
 * 
 * Usage:
 *   node scripts/run-headless.mjs hard normal 10
 *   node scripts/run-headless.mjs --ai1=hard --ai2=normal --games=10 --seed=12345
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse arguments
const args = process.argv.slice(2);
let ai1 = 'hard';
let ai2 = 'normal';
let games = 10;
let seed = undefined;

// Parse positional args: ai1 ai2 games
if (args.length >= 1 && !args[0].startsWith('--')) ai1 = args[0];
if (args.length >= 2 && !args[1].startsWith('--')) ai2 = args[1];
if (args.length >= 3 && !args[2].startsWith('--')) games = parseInt(args[2], 10);

// Parse named args: --ai1=hard --ai2=normal --games=10 --seed=12345
for (const arg of args) {
    if (arg.startsWith('--')) {
        const [key, value] = arg.slice(2).split('=');
        if (key === 'ai1') ai1 = value;
        if (key === 'ai2') ai2 = value;
        if (key === 'games') games = parseInt(value, 10);
        if (key === 'seed') seed = parseInt(value, 10);
    }
}

console.log(`Starting headless simulation: AI1=${ai1} vs AI2=${ai2}, ${games} games${seed ? ` (seed=${seed})` : ''}...`);
console.log(`Working directory: ${process.cwd()}`);
console.log(``);

// Run via vitest (reuse existing ai-simulation.test.ts)
const env = { 
    ...process.env, 
    SIM_GAMES: games.toString(),
    SIM_AI1: ai1,
    SIM_AI2: ai2,
};
if (seed !== undefined) {
    env.SIM_SEED = seed.toString();
}

const result = spawnSync(
    'npx',
    ['vitest', 'run', 'tests/ai-simulation.test.ts'],
    {
        stdio: 'inherit',
        shell: true,
        env,
        cwd: join(__dirname, '..'), // Project root
    }
);

process.exit(result.status ?? 0);
