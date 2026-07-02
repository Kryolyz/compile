/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Seeded random number generator for reproducible games
 * 
 * Uses a simple Linear Congruential Generator (LCG) with seed.
 * This allows games to be replayed exactly given the same seed.
 */

// Current seeded RNG function (defaults to Math.random if no seed set)
let seededRandom: (() => number) | null = null;

// Current seed (for reference)
let currentSeed: number | null = null;

/**
 * Predefined constants for LCG
 * Values from ANSI C/C++ standard (glibc)
 */
const LCG_MULTIPLIER = 1103515245;
const LCG_INCREMENT = 12345;
const LCG_MODULUS = 2 ** 31;

/**
 * Create a seeded random function
 * Returns a function that generates numbers in [0, 1) range (like Math.random())
 */
export function createSeededRandom(seed: number): () => number {
    let state = Math.floor(seed) % LCG_MODULUS;
    
    return () => {
        state = (LCG_MULTIPLIER * state + LCG_INCREMENT) % LCG_MODULUS;
        return state / LCG_MODULUS;
    };
}

/**
 * Set the global random seed for the game
 * All subsequent randomization will use this seed
 */
export function setRandomSeed(seed: number): void {
    currentSeed = seed;
    seededRandom = createSeededRandom(seed);
    console.log(`[RNG] Seed set to: ${seed}`);
}

/**
 * Get the current seed (for saving/replaying)
 */
export function getRandomSeed(): number | null {
    return currentSeed;
}

/**
 * Reset to unseeded mode (uses Math.random)
 */
export function resetRandomSeed(): void {
    currentSeed = null;
    seededRandom = null;
    console.log('[RNG] Reset to Math.random()');
}

/**
 * Get a random number in [0, 1) range
 * Uses seeded RNG if seed is set, otherwise Math.random()
 */
export function random(): number {
    if (seededRandom) {
        return seededRandom();
    }
    return Math.random();
}

/**
 * Get a random integer in [0, max) range
 * Equivalent to Math.floor(Math.random() * max)
 */
export function randomInt(max: number): number {
    return Math.floor(random() * max);
}

/**
 * Shuffle an array using the seeded RNG
 * Uses Fisher-Yates algorithm
 */
export function shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/**
 * Pick a random element from an array
 */
export function randomPick<T>(array: T[]): T {
    if (array.length === 0) {
        throw new Error('Cannot pick from empty array');
    }
    return array[randomInt(array.length)];
}

/**
 * Weighted random selection
 * @param items - Array of [item, weight] pairs
 * @returns Randomly selected item (probability = weight / totalWeight)
 */
export function weightedRandom<T>(items: [T, number][]): T {
    const totalWeight = items.reduce((sum, [, weight]) => sum + weight, 0);
    let randomValue = random() * totalWeight;
    
    for (const [item, weight] of items) {
        randomValue -= weight;
        if (randomValue <= 0) {
            return item;
        }
    }
    
    // Fallback (should not reach here if weights are valid)
    return items[items.length - 1][0];
}
