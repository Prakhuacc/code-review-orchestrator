/**
 * Zod -> JSON Schema helpers.
 * - toSdkJsonSchema: schema for the Agent SDK outputFormat option ($refStrategy 'root').
 * - schemaForPrompt: fully inlined schema embedded in prompts so agents see exact fields/enums.
 */
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export type JsonSchemaObject = Record<string, unknown>;

// zod-to-json-schema's generic signature can trigger TS2589 ("type instantiation is excessively
// deep") with newer zod 3.x releases. Calling it through this narrow signature avoids that.
type Converter = (schema: unknown, options?: Record<string, unknown>) => JsonSchemaObject;
const convert = zodToJsonSchema as unknown as Converter;

function withoutMetaKeys(schema: JsonSchemaObject): JsonSchemaObject {
  const copy: JsonSchemaObject = { ...schema };
  delete copy.$schema;
  return copy;
}

export function toSdkJsonSchema(schema: ZodTypeAny): JsonSchemaObject {
  return withoutMetaKeys(convert(schema, { $refStrategy: 'root', target: 'jsonSchema7' }));
}

export function schemaForPrompt(schema: ZodTypeAny): string {
  return JSON.stringify(withoutMetaKeys(convert(schema, { $refStrategy: 'none' })), null, 2);
}
