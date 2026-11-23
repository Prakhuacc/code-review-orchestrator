/**
 * Builds test fixtures directly from Zod (v3) schemas, so the schema tests follow
 * src/types automatically: if a field is added or an enum changes, the fixtures change too.
 *
 *  - buildValid(schema)            -> smallest object that satisfies the schema
 *  - buildValid(schema, { includeOptional: true, arrayLength: 1 }) -> every field populated
 *  - collectLeaves(schema)         -> paths of string / number / enum / boolean fields
 *  - objectShape / requiredKeys    -> top-level structure helpers
 */
import type { ZodTypeAny } from 'zod';

type Def = { typeName?: string } & Record<string, unknown>;
type Check = { kind: string; value?: number; inclusive?: boolean; regex?: RegExp };
type Path = Array<string | number>;

export interface BuildOptions {
  includeOptional?: boolean;
  arrayLength?: number;
}

export interface Leaf {
  path: Path;
  kind: 'string' | 'number' | 'enum' | 'boolean';
  schema: ZodTypeAny;
}

export interface NumberBounds {
  min?: { value: number; inclusive: boolean };
  max?: { value: number; inclusive: boolean };
  isInt: boolean;
}

const WRAPPERS = new Set(['ZodOptional', 'ZodNullable', 'ZodDefault', 'ZodReadonly', 'ZodCatch']);
const MAX_DEPTH = 15;

export function defOf(schema: ZodTypeAny): Def {
  return (schema as unknown as { _def: Def })._def;
}

/** Removes optional/nullable/default/effects wrappers. */
export function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const def = defOf(current);
    if (def.typeName && WRAPPERS.has(def.typeName)) current = def.innerType as ZodTypeAny;
    else if (def.typeName === 'ZodEffects') current = def.schema as ZodTypeAny;
    else if (def.typeName === 'ZodBranded') current = def.type as ZodTypeAny;
    else break;
  }
  return current;
}

export function objectShape(schema: ZodTypeAny): Record<string, ZodTypeAny> | null {
  const def = defOf(unwrap(schema));
  if (def.typeName !== 'ZodObject') return null;
  return (def.shape as () => Record<string, ZodTypeAny>)();
}

export function requiredKeys(schema: ZodTypeAny): string[] {
  const shape = objectShape(schema) ?? {};
  return Object.entries(shape)
    .filter(([, field]) => !field.isOptional())
    .map(([key]) => key);
}

export function numberBounds(schema: ZodTypeAny): NumberBounds {
  const checks = (defOf(unwrap(schema)).checks as Check[] | undefined) ?? [];
  const bounds: NumberBounds = { isInt: false };
  for (const check of checks) {
    if (check.kind === 'int') bounds.isInt = true;
    if (check.kind === 'min' && check.value !== undefined) {
      if (!bounds.min || check.value > bounds.min.value) {
        bounds.min = { value: check.value, inclusive: check.inclusive ?? true };
      }
    }
    if (check.kind === 'max' && check.value !== undefined) {
      if (!bounds.max || check.value < bounds.max.value) {
        bounds.max = { value: check.value, inclusive: check.inclusive ?? true };
      }
    }
  }
  return bounds;
}

function sampleNumber(schema: ZodTypeAny): number {
  const { min, max, isInt } = numberBounds(schema);
  const step = isInt ? 1 : 0.5;
  let value = 0;
  if (min) value = min.inclusive ? min.value : min.value + step;
  else if (max && max.value <= 0) value = max.inclusive ? max.value : max.value - step;
  if (max && (value > max.value || (!max.inclusive && value >= max.value))) {
    value = max.inclusive ? max.value : max.value - step;
  }
  return isInt ? Math.ceil(value) : value;
}

function sampleString(schema: ZodTypeAny): string {
  const checks = (defOf(unwrap(schema)).checks as Check[] | undefined) ?? [];
  const kinds = new Set(checks.map((c) => c.kind));
  if (kinds.has('datetime')) return '2025-01-01T00:00:00.000Z';
  if (kinds.has('date')) return '2025-01-01';
  if (kinds.has('email')) return 'dev@example.com';
  if (kinds.has('url')) return 'https://github.com/udacity/cd14715-simple-todo-app';
  if (kinds.has('uuid')) return '123e4567-e89b-12d3-a456-426614174000';

  let value = 'sample';
  const regexCheck = checks.find((c) => c.kind === 'regex' && c.regex);
  if (regexCheck?.regex) {
    const regex = new RegExp(regexCheck.regex.source, regexCheck.regex.flags.replace('g', ''));
    const candidates = ['sample', 'src/index.ts', 'abc123', 'A', '1', 'v1.0.0', 'abc'];
    value = candidates.find((candidate) => regex.test(candidate)) ?? value;
  }

  const exact = checks.find((c) => c.kind === 'length')?.value;
  if (exact !== undefined) return 'x'.repeat(exact);
  const minLength = Math.max(0, ...checks.filter((c) => c.kind === 'min').map((c) => c.value ?? 0));
  const maxLength = Math.min(Infinity, ...checks.filter((c) => c.kind === 'max').map((c) => c.value ?? Infinity));
  if (value.length < minLength) value = value.padEnd(minLength, 'x');
  if (value.length > maxLength) value = value.slice(0, maxLength);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildValid(schema: ZodTypeAny, options: BuildOptions = {}, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  const next = (s: ZodTypeAny): unknown => buildValid(s, options, depth + 1);
  const def = defOf(schema);

  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape)) {
        if (field.isOptional() && !options.includeOptional) continue;
        out[key] = next(unwrap(field));
      }
      return out;
    }
    case 'ZodString':
      return sampleString(schema);
    case 'ZodNumber':
      return sampleNumber(schema);
    case 'ZodBigInt':
      return BigInt(0);
    case 'ZodBoolean':
      return true;
    case 'ZodDate':
      return new Date('2025-01-01T00:00:00.000Z');
    case 'ZodNull':
      return null;
    case 'ZodAny':
    case 'ZodUnknown':
      return 'sample';
    case 'ZodArray': {
      const minLength = (def.minLength as { value: number } | null)?.value ?? 0;
      const maxLength = (def.maxLength as { value: number } | null)?.value ?? Infinity;
      const exact = (def.exactLength as { value: number } | null)?.value;
      const length = exact ?? Math.min(Math.max(minLength, options.arrayLength ?? 0), maxLength);
      return Array.from({ length }, () => next(def.type as ZodTypeAny));
    }
    case 'ZodEnum':
      return (def.values as unknown[])[0];
    case 'ZodNativeEnum': {
      const values = Object.values(def.values as Record<string, string | number>);
      const numeric = values.filter((v) => typeof v === 'number');
      return numeric.length > 0 ? numeric[0] : values[0];
    }
    case 'ZodLiteral':
      return def.value;
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const opts = def.options as ZodTypeAny[] | Map<unknown, ZodTypeAny>;
      const first = Array.isArray(opts) ? opts[0] : [...opts.values()][0];
      return first ? next(first) : undefined;
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodReadonly':
    case 'ZodCatch':
      return next(def.innerType as ZodTypeAny);
    case 'ZodDefault':
      return (def.defaultValue as () => unknown)();
    case 'ZodEffects':
      return next(def.schema as ZodTypeAny);
    case 'ZodBranded':
      return next(def.type as ZodTypeAny);
    case 'ZodLazy':
      return next((def.getter as () => ZodTypeAny)());
    case 'ZodPipeline':
      return next(def.in as ZodTypeAny);
    case 'ZodTuple':
      return (def.items as ZodTypeAny[]).map(next);
    case 'ZodRecord':
      return {};
    case 'ZodMap':
      return new Map();
    case 'ZodSet':
      return new Set();
    case 'ZodIntersection': {
      const left = next(def.left as ZodTypeAny);
      const right = next(def.right as ZodTypeAny);
      return isPlainObject(left) && isPlainObject(right) ? { ...left, ...right } : left;
    }
    default:
      return undefined;
  }
}

/** Every string/number/enum/boolean field reachable through objects and arrays (index 0). */
export function collectLeaves(schema: ZodTypeAny, path: Path = [], out: Leaf[] = [], depth = 0): Leaf[] {
  if (depth > MAX_DEPTH) return out;
  const inner = unwrap(schema);
  const def = defOf(inner);
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      for (const [key, field] of Object.entries(shape)) collectLeaves(field, [...path, key], out, depth + 1);
      break;
    }
    case 'ZodArray':
      collectLeaves(def.type as ZodTypeAny, [...path, 0], out, depth + 1);
      break;
    case 'ZodString':
      out.push({ path, kind: 'string', schema: inner });
      break;
    case 'ZodNumber':
      out.push({ path, kind: 'number', schema: inner });
      break;
    case 'ZodEnum':
    case 'ZodNativeEnum':
      out.push({ path, kind: 'enum', schema: inner });
      break;
    case 'ZodBoolean':
      out.push({ path, kind: 'boolean', schema: inner });
      break;
    default:
      break;
  }
  return out;
}

export function setAtPath<T>(value: T, path: Path, newValue: unknown): T {
  const clone = structuredClone(value);
  let cursor = clone as unknown as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    cursor = cursor[key] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1];
  if (last !== undefined) cursor[last] = newValue;
  return clone;
}

export function deleteKey<T>(value: T, key: string): T {
  const clone = structuredClone(value) as Record<string, unknown>;
  delete clone[key];
  return clone as T;
}

export function formatPath(path: Path): string {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('').replace(/^\./, '');
}
