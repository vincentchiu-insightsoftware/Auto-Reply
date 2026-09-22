import { readFileSync } from 'node:fs';
import type { Persona } from '../types.js';

export function loadPersona(path: string): Persona {
  const p = JSON.parse(readFileSync(path, 'utf8')) as Partial<Persona>;
  for (const k of ['id', 'version', 'language', 'name'] as const) if (typeof p[k] !== 'string') throw new Error(`persona.${k} missing`);
  for (const k of ['personality', 'speaking_style', 'catchphrases', 'avoid_phrases'] as const)
    if (!Array.isArray(p[k])) throw new Error(`persona.${k} must be array`);
  return { ...(p as Persona), voice_id: p.voice_id ?? null };
}

export function loadReference(path: string | null, maxChars: number): string[] {
  if (!path) return [];
  const text = readFileSync(path, 'utf8');
  const clipped = Array.from(text).slice(0, maxChars).join('');
  return clipped
    .split(/\n(?=## )/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
