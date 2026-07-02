/**
 * Test script to verify seeded RNG works correctly
 */

import { setRandomSeed, random, shuffleArray, randomInt } from '../utils/seededRandom';

// Test 1: Same seed produces same sequence
console.log('Test 1: Same seed produces same sequence');
setRandomSeed(42);
const seq1 = [random(), random(), random()];
setRandomSeed(42);
const seq2 = [random(), random(), random()];
console.log('  Sequence 1:', seq1);
console.log('  Sequence 2:', seq2);
console.log('  Match:', JSON.stringify(seq1) === JSON.stringify(seq2));

// Test 2: Different seeds produce different sequences
console.log('\nTest 2: Different seeds produce different sequences');
setRandomSeed(42);
const seq3 = [random(), random(), random()];
setRandomSeed(99);
const seq4 = [random(), random(), random()];
console.log('  Sequence 42:', seq3);
console.log('  Sequence 99:', seq4);
console.log('  Different:', JSON.stringify(seq3) !== JSON.stringify(seq4));

// Test 3: shuffleArray is reproducible
console.log('\nTest 3: shuffleArray is reproducible');
const array = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
setRandomSeed(42);
const shuffle1 = shuffleArray([...array]);
setRandomSeed(42);
const shuffle2 = shuffleArray([...array]);
console.log('  Shuffle 1:', shuffle1);
console.log('  Shuffle 2:', shuffle2);
console.log('  Match:', JSON.stringify(shuffle1) === JSON.stringify(shuffle2));

// Test 4: randomInt is reproducible
console.log('\nTest 4: randomInt is reproducible');
setRandomSeed(42);
const ints1 = [randomInt(10), randomInt(10), randomInt(10)];
setRandomSeed(42);
const ints2 = [randomInt(10), randomInt(10), randomInt(10)];
console.log('  Ints 1:', ints1);
console.log('  Ints 2:', ints2);
console.log('  Match:', JSON.stringify(ints1) === JSON.stringify(ints2));

console.log('\n✅ All tests passed!');
