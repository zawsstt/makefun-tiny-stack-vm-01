// Tiny stack VM: ISA v1 in full. 32-bit wrapping values, 256-value stack,
// 64-deep call stack, 256 words of memory, ten traps with their own exit codes,
// 1,000,000-step and 65,536-byte output limits. A trap keeps prior output.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STACK_MAX = 256, CALLS_MAX = 64, MEM_WORDS = 256;
const STEP_LIMIT = 1_000_000, OUT_MAX = 65_536;

// Opcode shape: immediate bytes, values popped, values pushed.
const immOf = new Uint8Array(256);
const popOf = new Uint8Array(256);
const pushOf = new Uint8Array(256);
const known = new Uint8Array(256);
const set = (a: number, b: number, imm: number, pops: number, pushes: number): void => {
  for (let o = a; o <= b; o++) { immOf[o] = imm; popOf[o] = pops; pushOf[o] = pushes; known[o] = 1; }
};
set(0x00, 0x00, 0, 0, 0); // HALT
set(0x01, 0x01, 1, 0, 1); // PUSH8
set(0x02, 0x02, 4, 0, 1);
set(0x03, 0x03, 0, 1, 0); // POP
set(0x04, 0x04, 0, 1, 2); // DUP
set(0x05, 0x05, 0, 2, 2); // SWAP
set(0x06, 0x06, 0, 2, 3); // OVER
set(0x07, 0x07, 0, 3, 3); // ROT
set(0x10, 0x16, 0, 2, 1); // ADD SUB MUL DIV MOD DIVU MODU
set(0x17, 0x17, 0, 1, 1); // NEG
set(0x18, 0x1a, 0, 2, 1); // AND OR XOR
set(0x1b, 0x1b, 0, 1, 1); // NOT
set(0x1c, 0x1e, 0, 2, 1); // SHL SHR SHRU
set(0x20, 0x22, 0, 2, 1); // EQ LT LTU
set(0x30, 0x30, 2, 0, 0); // JMP
set(0x31, 0x32, 2, 1, 0); // JZ JNZ
set(0x33, 0x33, 2, 0, 0); // CALL
set(0x34, 0x34, 0, 0, 0); // RET
set(0x40, 0x40, 0, 1, 1); // LOAD
set(0x41, 0x41, 0, 2, 0); // STORE
set(0x50, 0x51, 0, 1, 0); // PRINT PUTC
set(0x52, 0x52, 0, 0, 1); // IN
set(0x53, 0x53, 0, 1, 0); // EXIT

function run(prog: Uint8Array, input: Uint8Array): { out: Uint8Array; code: number } {
  const n = prog.length;
  const st = new Int32Array(STACK_MAX);
  let sp = 0;
  const cs = new Int32Array(CALLS_MAX);
  let cp = 0;
  const mem = new Int32Array(MEM_WORDS);
  const out = new Uint8Array(OUT_MAX);
  let olen = 0, ipos = 0, pc = 0, steps = 0;
  const finish = (code: number) => ({ out: out.slice(0, olen), code });

  for (;;) {
    if (steps === STEP_LIMIT) return finish(10);
    if (pc < 0 || pc >= n) return finish(9);
    const op = prog[pc];
    if (!known[op]) return finish(5);
    const imm = immOf[op];
    if (pc + imm >= n) return finish(9);
    steps++;
    const next = pc + 1 + imm;
    const pops = popOf[op];
    if (sp < pops) return finish(2);
    if (sp - pops + pushOf[op] > STACK_MAX) return finish(3);
    pc = next;

    switch (op) {
      case 0x00: return finish(0); // HALT
      case 0x01: st[sp++] = (prog[next - 1] << 24) >> 24; break;
      case 0x02: st[sp++] = prog[next - 4] | (prog[next - 3] << 8) | (prog[next - 2] << 16) | (prog[next - 1] << 24); break;
      case 0x03: sp--; break; // POP
      case 0x04: st[sp] = st[sp - 1]; sp++; break; // DUP
      case 0x05: { const t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; break; } // SWAP
      case 0x06: st[sp] = st[sp - 2]; sp++; break; // OVER
      case 0x07: { const a = st[sp - 3]; st[sp - 3] = st[sp - 2]; st[sp - 2] = st[sp - 1]; st[sp - 1] = a; break; } // ROT
      case 0x17: st[sp - 1] = -st[sp - 1] | 0; break;
      case 0x1b: st[sp - 1] = ~st[sp - 1]; break; // NOT
      case 0x30: case 0x31: case 0x32: {
        const rel = ((prog[next - 2] | (prog[next - 1] << 8)) << 16) >> 16;
        let take = op === 0x30;
        if (op !== 0x30) { const v = st[--sp]; take = op === 0x31 ? v === 0 : v !== 0; }
        if (take) pc = next + rel;
        break;
      }
      case 0x33:
        if (cp === CALLS_MAX) return finish(7);
        cs[cp++] = next;
        pc = prog[next - 2] | (prog[next - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return finish(8);
        pc = cs[--cp];
        break;
      case 0x40: { // LOAD
        const addr = st[sp - 1];
        if (addr < 0 || addr >= MEM_WORDS) return finish(6);
        st[sp - 1] = mem[addr];
        break;
      }
      case 0x41: {
        const addr = st[sp - 1];
        const v = st[sp - 2];
        if (addr < 0 || addr >= MEM_WORDS) return finish(6);
        sp -= 2;
        mem[addr] = v;
        break;
      }
      case 0x50: {
        const s = String(st[sp - 1]);
        if (olen + s.length > OUT_MAX) return finish(11);
        sp--;
        for (let i = 0; i < s.length; i++) out[olen++] = s.charCodeAt(i);
        break;
      }
      case 0x51:
        if (olen + 1 > OUT_MAX) return finish(11);
        out[olen++] = st[--sp] & 255;
        break;
      case 0x52: st[sp++] = ipos < input.length ? input[ipos++] : -1; break;
      case 0x53: return finish(st[--sp] & 255);
      default: {
        const b = st[sp - 1];
        const a = st[sp - 2];
        let r: number;
        switch (op) {
          case 0x10: r = (a + b) | 0; break; // ADD
          case 0x11: r = (a - b) | 0; break; // SUB
          case 0x12: r = Math.imul(a, b); break;
          case 0x13:
            if (b === 0) return finish(4);
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
            break;
          case 0x14:
            if (b === 0) return finish(4);
            r = b === -1 ? 0 : (a % b) | 0;
            break;
          case 0x15:
            if (b === 0) return finish(4);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16:
            if (b === 0) return finish(4);
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 0x18: r = a & b; break; // AND
          case 0x19: r = a | b; break; // OR
          case 0x1a: r = a ^ b; break; // XOR
          case 0x1c: r = a << (b & 31); break; // SHL
          case 0x1d: r = a >> (b & 31); break;
          case 0x1e: r = (a >>> (b & 31)) | 0; break;
          case 0x20: r = a === b ? 1 : 0; break; // EQ
          case 0x21: r = a < b ? 1 : 0; break;
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
        }
        sp -= 2;
        st[sp++] = r;
        break;
      }
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(
    new Uint8Array(readFileSync(join(I, id, 'program.bin'))),
    new Uint8Array(readFileSync(join(I, id, 'input.bin'))),
  );
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.code}\n`);
}
