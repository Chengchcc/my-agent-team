// Crockford's Base32 alphabet (no I, L, O, U)
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const ULID_TOTAL_LEN = TIME_LEN + RANDOM_LEN;

let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(time: number, length: number): string {
  let str = '';
  for (let i = length - 1; i >= 0; i--) {
    const mod = time % ENCODING_LEN;
    str = ENCODING[mod] + str;
    time = (time - mod) / ENCODING_LEN;
  }
  return str;
}

function encodeRandom(length: number): number[] {
  const random: number[] = [];
  for (let i = 0; i < length; i++) {
    random[i] = Math.floor(Math.random() * ENCODING_LEN);
  }
  return random;
}

function incrementRandom(random: number[]): number[] {
  const newRandom = [...random];
  for (let i = newRandom.length - 1; i >= 0; i--) {
    if (newRandom[i] === ENCODING_LEN - 1) {
      newRandom[i] = 0;
    } else {
      newRandom[i]!++;
      break;
    }
  }
  return newRandom;
}

export function generateULID(seedTime?: number): string {
  const time = seedTime ?? Date.now();

  if (time < 0) {
    throw new Error('Time must be >= 0');
  }

  let random: number[];

  if (time === lastTime) {
    random = incrementRandom(lastRandom);
  } else {
    random = encodeRandom(RANDOM_LEN);
  }

  lastTime = time;
  lastRandom = random;

  const timeStr = encodeTime(time, TIME_LEN);
  const randomStr = random.map(r => ENCODING[r]).join('');

  return timeStr + randomStr;
}

export function isValidULID(id: string): boolean {
  if (typeof id !== 'string' || id.length !== ULID_TOTAL_LEN) {
    return false;
  }
  return id.split('').every(c => ENCODING.includes(c));
}

export function ulidTimestamp(id: string): number {
  if (!isValidULID(id)) {
    throw new Error('Invalid ULID');
  }
  const timeStr = id.slice(0, TIME_LEN);
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    time = time * ENCODING_LEN + (ENCODING.indexOf(timeStr[i]!) ?? 0);
  }
  return time;
}
