import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZodError, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  CodeQualityResultSchema,
  RefactoringSuggestionSchema,
  ReviewReportSchema,
  TestCoverageResultSchema,
} from '../src/types/index.js';
import { schemaForPrompt, toSdkJsonSchema } from '../src/utils/json-schema.js';
import {
  buildValid,
  collectLeaves,
  defOf,
  deleteKey,
  formatPath,
  numberBounds,
  objectShape,
  requiredKeys,
  setAtPath,
  unwrap,
} from './helpers/zod-fixtures.js';

const SCHEMAS: Array<[string, ZodTypeAny]> = [
  ['CodeQualityResultSchema', CodeQualityResultSchema],
  ['TestCoverageResultSchema', TestCoverageResultSchema],
  ['RefactoringSuggestionSchema', RefactoringSuggestionSchema],
  ['ReviewReportSchema', ReviewReportSchema],
];

function expectValid(schema: ZodTypeAny, data: unknown, context: string): void {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`${context} should be valid but failed: ${JSON.stringify(result.error.issues, null, 2)}`);
  }
}

function expectInvalid(schema: ZodTypeAny, data: unknown, context: string): void {
  const result = schema.safeParse(data);
  if (result.success) throw new Error(`${context} should be rejected but was accepted`);
  expect(result.error).toBeInstanceOf(ZodError);
}

describe.each(SCHEMAS)('%s', (_name, schema) => {
  const minimal = buildValid(schema);
  const full = buildValid(schema, { includeOptional: true, arrayLength: 1 });
  const leaves = collectLeaves(schema);
  const shape = objectShape(schema) ?? {};
  const required = requiredKeys(schema);

  describe('valid data', () => {
    it('accepts an object with only the required fields', () => {
      expect(() => schema.parse(minimal)).not.toThrow();
    });

    it('accepts a fully populated object including optional fields', () => {
      expect(() => schema.parse(full)).not.toThrow();
    });

    it('survives a JSON round trip (what the report files contain)', () => {
      expectValid(schema, JSON.parse(JSON.stringify(full)), 'JSON round trip');
    });
  });

  describe('invalid data', () => {
    const nonObjects: Array<[string, unknown]> = [
      ['null', null],
      ['undefined', undefined],
      ['a string', 'not an object'],
      ['a number', 42],
      ['an array', []],
    ];
    it.each(nonObjects)('rejects %s', (_label, value) => {
      expect(() => schema.parse(value)).toThrow(ZodError);
    });

    it('rejects an empty object', () => {
      expect(required.length).toBeGreaterThan(0);
      expect(() => schema.parse({})).toThrow(ZodError);
    });

    it('rejects an object missing any required field', () => {
      for (const key of required) {
        expectInvalid(schema, deleteKey(full, key), `missing "${key}"`);
      }
    });

    it('rejects wrong types for string fields', () => {
      for (const leaf of leaves.filter((l) => l.kind === 'string')) {
        expectInvalid(schema, setAtPath(full, leaf.path, 12345), `number in ${formatPath(leaf.path)}`);
      }
    });

    it('rejects wrong types for number fields', () => {
      for (const leaf of leaves.filter((l) => l.kind === 'number')) {
        expectInvalid(schema, setAtPath(full, leaf.path, 'not-a-number'), `string in ${formatPath(leaf.path)}`);
      }
    });

    it('rejects values outside enum fields (e.g. an unknown severity)', () => {
      for (const leaf of leaves.filter((l) => l.kind === 'enum')) {
        expectInvalid(schema, setAtPath(full, leaf.path, '__not_a_valid_enum_value__'), `enum ${formatPath(leaf.path)}`);
      }
    });
  });

  describe('edge cases', () => {
    it('accepts empty arrays for array fields without a minimum length', () => {
      for (const [key, field] of Object.entries(shape)) {
        const def = defOf(unwrap(field));
        if (def.typeName !== 'ZodArray' || def.minLength || def.exactLength) continue;
        expectValid(schema, setAtPath(full, [key], []), `empty array in ${key}`);
      }
    });

    it('accepts inclusive numeric boundary values (e.g. scores of 0 and 100)', () => {
      for (const leaf of leaves.filter((l) => l.kind === 'number')) {
        const { min, max } = numberBounds(leaf.schema);
        if (min?.inclusive) expectValid(schema, setAtPath(full, leaf.path, min.value), `${formatPath(leaf.path)} = min`);
        if (max?.inclusive) expectValid(schema, setAtPath(full, leaf.path, max.value), `${formatPath(leaf.path)} = max`);
      }
    });

    it('rejects numeric values just outside their bounds (e.g. -1 and 101)', () => {
      for (const leaf of leaves.filter((l) => l.kind === 'number')) {
        const { min, max } = numberBounds(leaf.schema);
        if (min) expectInvalid(schema, setAtPath(full, leaf.path, min.value - 1), `${formatPath(leaf.path)} below min`);
        if (max) expectInvalid(schema, setAtPath(full, leaf.path, max.value + 1), `${formatPath(leaf.path)} above max`);
      }
    });

    it('treats optional fields as optional (present or absent)', () => {
      const optionalKeys = Object.keys(shape).filter((key) => !required.includes(key));
      for (const key of optionalKeys) {
        expectValid(schema, deleteKey(full, key), `without optional "${key}"`);
      }
    });
  });
});

describe('JSON Schema export for SDK structured outputs', () => {
  it.each(SCHEMAS)('%s converts to an object schema with all properties', (_name, schema) => {
    const jsonSchema = zodToJsonSchema(schema, { $refStrategy: 'root' }) as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(jsonSchema.type).toBe('object');
    expect(Object.keys(jsonSchema.properties ?? {}).sort()).toEqual(Object.keys(objectShape(schema) ?? {}).sort());
  });

  it.each(SCHEMAS)('%s marks exactly the required properties as required', (_name, schema) => {
    const jsonSchema = zodToJsonSchema(schema, { $refStrategy: 'root' }) as { required?: string[] };
    expect([...(jsonSchema.required ?? [])].sort()).toEqual(requiredKeys(schema).sort());
  });

  it('toSdkJsonSchema produces a serializable schema without the $schema meta key', () => {
    const sdkSchema = toSdkJsonSchema(ReviewReportSchema);
    expect(sdkSchema.$schema).toBeUndefined();
    expect(sdkSchema.type).toBe('object');
    expect(() => JSON.parse(JSON.stringify(sdkSchema))).not.toThrow();
  });

  it('schemaForPrompt inlines the schema as pretty-printed JSON for the prompts', () => {
    const text = schemaForPrompt(CodeQualityResultSchema);
    const parsed = JSON.parse(text) as { type?: string };
    expect(parsed.type).toBe('object');
    expect(text).not.toContain('$ref');
  });
});

// ---------------------------------------------------------------------------
// Generated deliverables (runs once reports exist)
// ---------------------------------------------------------------------------

const reportsDir = fileURLToPath(new URL('../reports', import.meta.url));
const jsonReports = existsSync(reportsDir) ? readdirSync(reportsDir).filter((f) => f.endsWith('.json')) : [];

function findUndefinedStrings(value: unknown, at = 'report'): string[] {
  if (typeof value === 'string') return /^(undefined|null)$/i.test(value.trim()) ? [at] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => findUndefinedStrings(item, `${at}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => findUndefinedStrings(v, `${at}.${k}`));
  }
  return [];
}

describe.skipIf(jsonReports.length === 0)('generated JSON reports', () => {
  it.each(jsonReports)('%s is valid JSON that matches ReviewReportSchema', (file) => {
    const data: unknown = JSON.parse(readFileSync(path.join(reportsDir, file), 'utf8'));
    expectValid(ReviewReportSchema, data, file);
    expect(findUndefinedStrings(data)).toEqual([]);
  });
});

describe.skipIf(!process.env.CHECK_DELIVERABLES)('submission deliverables (CHECK_DELIVERABLES=1)', () => {
  const expected = [1, 2, 3].flatMap((pr) =>
    ['json', 'md', 'html'].map((ext) => `udacity_cd14715-simple-todo-app_${pr}.${ext}`),
  );

  it.each(expected)('%s exists and is not empty', (file) => {
    const filePath = path.join(reportsDir, file);
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf8');
    expect(content.trim().length).toBeGreaterThan(200);
  });
});
