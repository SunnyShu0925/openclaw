// JSON schema default helpers fill object values from TypeBox schema defaults.
import {
  normalizeJsonSchemaForTypeBox,
  type JsonSchemaValue,
} from "@openclaw/normalization-core/json-schema";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Compile } from "typebox/compile";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

type LocalRefResolution =
  | {
      found: true;
      schema: JsonSchemaValue;
      resourceRoot: JsonSchemaValue;
      resourceBaseId: string | undefined;
    }
  | { found: false };
const schemaResourceIds = new WeakMap<object, number>();
let nextSchemaResourceId = 1;
const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const schemaValueKeywords = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const schemaArrayKeywords = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaCombinatorKeywords = new Set(["allOf", "anyOf", "oneOf"]);
const jsonSchemaTypes = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const schemaStringKeywords = new Set([
  "$anchor",
  "$comment",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$schema",
  "$ref",
  "contentEncoding",
  "contentMediaType",
  "description",
  "format",
  "pattern",
  "title",
]);
const schemaNumberKeywords = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maximum",
  "minimum",
  "multipleOf",
]);
const schemaIntegerKeywords = new Set([
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
]);
const schemaBooleanKeywords = new Set(["deprecated", "readOnly", "uniqueItems", "writeOnly"]);
const JSON_POINTER_ARRAY_INDEX_SEGMENT = /^(0|[1-9]\d*)$/;

function schemaTypeIncludes(schema: Record<string, unknown>, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function schemaResourceRefKey(
  resourceRoot: JsonSchemaValue,
  ref: string,
  baseId: string | undefined,
): string {
  if (!isRecord(resourceRoot)) {
    return `boolean:${String(resourceRoot)}:${baseId ?? ""}:${ref}`;
  }
  let id = schemaResourceIds.get(resourceRoot);
  if (id === undefined) {
    id = nextSchemaResourceId++;
    schemaResourceIds.set(resourceRoot, id);
  }
  return `schema:${id}:${baseId ?? ""}:${ref}`;
}

function validateTypeKeyword(type: unknown, path: string): string | undefined {
  if (typeof type === "string") {
    return jsonSchemaTypes.has(type) ? undefined : `${path}.type: unsupported JSON Schema type`;
  }
  if (Array.isArray(type) && type.length > 0) {
    const invalid = type.find((entry) => typeof entry !== "string" || !jsonSchemaTypes.has(entry));
    if (invalid !== undefined) {
      return `${path}.type: unsupported JSON Schema type`;
    }
    return new Set(type).size === type.length
      ? undefined
      : `${path}.type: expected unique JSON Schema types`;
  }
  return `${path}.type: expected string or non-empty string array`;
}

function decodePointerSegment(segment: string): string {
  let decodedSegment;
  try {
    decodedSegment = decodeURIComponent(segment);
  } catch {
    decodedSegment = segment;
  }
  return decodedSegment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parseJsonPointerArrayIndex(segment: string): number | undefined {
  if (!JSON_POINTER_ARRAY_INDEX_SEGMENT.test(segment)) {
    return undefined;
  }
  const index = Number(segment);
  return Number.isSafeInteger(index) ? index : undefined;
}

function resolveLocalAnchor(
  schema: JsonSchemaValue,
  anchor: string,
  isRoot = true,
): JsonSchemaValue | undefined {
  // Iterative DFS so a deep or cyclic schema graph cannot overflow the call stack. A
  // `visited` set guards cycles (e.g. a `$ref`-rooted properties loop); the 256 KiB
  // manifest admission limit bounds the acyclic case to a few tens of thousands of nodes.
  const visited = new Set<object>();
  const stack: Array<{ schema: JsonSchemaValue; isRoot: boolean }> = [{ schema, isRoot }];
  while (stack.length > 0) {
    const item = stack.pop() as { schema: JsonSchemaValue; isRoot: boolean };
    const { schema: current, isRoot: currentIsRoot } = item;
    if (!isRecord(current)) {
      continue;
    }
    if (!currentIsRoot && typeof current.$id === "string") {
      // A nested `$id` starts a new resource; local anchors do not cross resource boundaries.
      continue;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (current.$anchor === anchor || current.$dynamicAnchor === anchor) {
      return current;
    }
    // Push children in reverse iteration order so they are popped in source order, matching
    // the previous recursive left-to-right search.
    const children: JsonSchemaValue[] = [];
    for (const key of schemaMapKeywords) {
      const value = current[key];
      if (!isRecord(value)) {
        continue;
      }
      for (const entry of Object.values(value)) {
        children.push(entry as JsonSchemaValue);
      }
    }
    if (isRecord(current.dependencies)) {
      for (const entry of Object.values(current.dependencies)) {
        if (isStringArray(entry)) {
          continue;
        }
        children.push(entry as JsonSchemaValue);
      }
    }
    for (const key of schemaValueKeywords) {
      const value = current[key];
      if (typeof value === "boolean" || isRecord(value)) {
        children.push(value as JsonSchemaValue);
        continue;
      }
      if (key === "items" && Array.isArray(value)) {
        for (const entry of value) {
          children.push(entry as JsonSchemaValue);
        }
      }
    }
    for (const key of schemaArrayKeywords) {
      const value = current[key];
      if (!Array.isArray(value)) {
        continue;
      }
      for (const entry of value) {
        children.push(entry as JsonSchemaValue);
      }
    }
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ schema: children[index], isRoot: false });
    }
  }
  return undefined;
}

function resolveLocalRef(
  resourceRoot: JsonSchemaValue,
  ref: string,
  resourceBaseId: string | undefined,
): LocalRefResolution {
  if (isRecord(resourceRoot) && typeof resourceRoot.$id === "string" && resourceRoot.$id !== "") {
    if (ref === resourceRoot.$id) {
      return { found: true, schema: resourceRoot, resourceRoot, resourceBaseId };
    }
    if (ref.startsWith(`${resourceRoot.$id}#`)) {
      return resolveLocalRef(resourceRoot, ref.slice(resourceRoot.$id.length), resourceBaseId);
    }
  }
  if (ref === "#") {
    return { found: true, schema: resourceRoot, resourceRoot, resourceBaseId };
  }
  if (ref.startsWith("#/")) {
    let current: unknown = resourceRoot;
    let currentResourceRoot = resourceRoot;
    let currentResourceBaseId = resourceBaseId;
    for (const segment of ref.slice(2).split("/").map(decodePointerSegment)) {
      if (Array.isArray(current)) {
        const index = parseJsonPointerArrayIndex(segment);
        if (index === undefined) {
          return { found: false };
        }
        current = current[index];
      } else if (isRecord(current)) {
        current = current[segment];
      } else {
        return { found: false };
      }
      if (isRecord(current) && typeof current.$id === "string") {
        currentResourceRoot = current as JsonSchemaValue;
        currentResourceBaseId = resolveSchemaId(current.$id, currentResourceBaseId);
      }
    }
    return typeof current === "boolean" || isRecord(current)
      ? {
          found: true,
          schema: current as JsonSchemaValue,
          resourceRoot: currentResourceRoot,
          resourceBaseId: currentResourceBaseId,
        }
      : { found: false };
  }
  if (ref.startsWith("#")) {
    const resolved = resolveLocalAnchor(resourceRoot, decodeURIComponent(ref.slice(1)));
    return resolved === undefined
      ? { found: false }
      : { found: true, schema: resolved, resourceRoot, resourceBaseId };
  }
  return { found: false };
}

function splitResourceRef(ref: string): { resource: string; fragment: string } {
  const hashIndex = ref.indexOf("#");
  return hashIndex === -1
    ? { resource: ref, fragment: "" }
    : { resource: ref.slice(0, hashIndex), fragment: ref.slice(hashIndex) };
}

function stripFragment(id: string): string {
  return splitResourceRef(id).resource;
}

function resolveSchemaId(id: string, baseId: string | undefined): string {
  if (!baseId) {
    return stripFragment(id);
  }
  try {
    return stripFragment(new URL(id, baseId).href);
  } catch {
    return stripFragment(id);
  }
}

function resolveSchemaResourceRef(
  schema: JsonSchemaValue,
  ref: string,
  baseId: string | undefined,
): LocalRefResolution {
  const refParts = splitResourceRef(ref);
  const resolvedRefResource =
    refParts.resource === "" ? refParts.resource : resolveSchemaId(refParts.resource, baseId);
  const seen = new Set<object>();
  const stack: Array<{ schema: JsonSchemaValue; baseId: string | undefined }> = [
    { schema, baseId: undefined },
  ];
  while (stack.length > 0) {
    const item = stack.pop() as { schema: JsonSchemaValue; baseId: string | undefined };
    const { schema: current, baseId: baseIdLocal } = item;
    if (!isRecord(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);

    let currentBaseId = baseIdLocal;
    if (typeof current.$id === "string" && current.$id !== "") {
      const resolvedId = resolveSchemaId(current.$id, baseIdLocal);
      currentBaseId = resolvedId;
      if (resolvedRefResource === resolvedId || refParts.resource === stripFragment(current.$id)) {
        return refParts.fragment
          ? resolveLocalRef(current, refParts.fragment, currentBaseId)
          : { found: true, schema: current, resourceRoot: current, resourceBaseId: currentBaseId };
      }
    }

    // Collect children, then push in reverse so they are popped in source order, matching the
    // previous recursive left-to-right search.
    const children: JsonSchemaValue[] = [];
    for (const key of schemaMapKeywords) {
      const value = current[key];
      if (!isRecord(value)) {
        continue;
      }
      for (const entry of Object.values(value)) {
        children.push(entry as JsonSchemaValue);
      }
    }
    if (isRecord(current.dependencies)) {
      for (const entry of Object.values(current.dependencies)) {
        if (isStringArray(entry)) {
          continue;
        }
        children.push(entry as JsonSchemaValue);
      }
    }
    for (const key of schemaValueKeywords) {
      const value = current[key];
      if (typeof value === "boolean" || isRecord(value)) {
        children.push(value as JsonSchemaValue);
        continue;
      }
      if (key === "items" && Array.isArray(value)) {
        for (const entry of value) {
          children.push(entry as JsonSchemaValue);
        }
      }
    }
    for (const key of schemaArrayKeywords) {
      const value = current[key];
      if (!Array.isArray(value)) {
        continue;
      }
      for (const entry of value) {
        children.push(entry as JsonSchemaValue);
      }
    }
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ schema: children[index], baseId: currentBaseId });
    }
  }
  return { found: false };
}

function resolveSchemaRef(
  root: JsonSchemaValue,
  resourceRoot: JsonSchemaValue,
  ref: string,
  baseId: string | undefined,
): LocalRefResolution {
  const localTarget = resolveLocalRef(resourceRoot, ref, baseId);
  return localTarget.found ? localTarget : resolveSchemaResourceRef(root, ref, baseId);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasDuplicateJsonValues(values: unknown[]): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }
  return false;
}

function validateSchemaKeywordShapes(
  schema: Record<string, unknown>,
  path: string,
): string | undefined {
  for (const key of schemaStringKeywords) {
    const value = schema[key];
    if (value !== undefined && typeof value !== "string") {
      return `${path}.${key}: expected string`;
    }
  }
  for (const key of schemaNumberKeywords) {
    const value = schema[key];
    if (value !== undefined && typeof value !== "number") {
      return `${path}.${key}: expected number`;
    }
  }
  for (const key of schemaIntegerKeywords) {
    const value = schema[key];
    if (
      value !== undefined &&
      (!Number.isInteger(value) || (typeof value === "number" && value < 0))
    ) {
      return `${path}.${key}: expected non-negative integer`;
    }
  }
  for (const key of schemaBooleanKeywords) {
    const value = schema[key];
    if (value !== undefined && typeof value !== "boolean") {
      return `${path}.${key}: expected boolean`;
    }
  }
  if (
    schema.multipleOf !== undefined &&
    typeof schema.multipleOf === "number" &&
    schema.multipleOf <= 0
  ) {
    return `${path}.multipleOf: expected positive number`;
  }
  if (schema.required !== undefined) {
    if (!isStringArray(schema.required)) {
      return `${path}.required: expected string array`;
    }
    if (new Set(schema.required).size !== schema.required.length) {
      return `${path}.required: expected unique string array`;
    }
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) {
      return `${path}.enum: expected array`;
    }
    if (schema.enum.length === 0 || hasDuplicateJsonValues(schema.enum)) {
      return `${path}.enum: expected non-empty array with unique values`;
    }
  }
  for (const key of schemaCombinatorKeywords) {
    const value = schema[key];
    if (Array.isArray(value) && value.length === 0) {
      return `${path}.${key}: expected non-empty schema array`;
    }
  }
  if (schema.dependentRequired !== undefined) {
    if (!isRecord(schema.dependentRequired)) {
      return `${path}.dependentRequired: expected string array map`;
    }
    for (const [key, value] of Object.entries(schema.dependentRequired)) {
      if (!isStringArray(value)) {
        return `${path}.dependentRequired.${key}: expected string array`;
      }
    }
  }
  if (schema.dependencies !== undefined) {
    if (!isRecord(schema.dependencies)) {
      return `${path}.dependencies: expected schema or string array map`;
    }
    for (const [key, value] of Object.entries(schema.dependencies)) {
      if (!isStringArray(value) && typeof value !== "boolean" && !isRecord(value)) {
        return `${path}.dependencies.${key}: expected schema or string array`;
      }
    }
  }
  return undefined;
}

type NodeWorkItem = {
  schema: unknown;
  path: string;
  resourceRoot: JsonSchemaValue;
  resourceBaseId: string | undefined;
};

/**
 * Walk every schema node reachable from `schema` without recursing on the call stack.
 *
 * Each reachable node is handed to `visit`, which may return a shape-error string to short-
 * circuit the walk. A `visited` set guards against cyclic schema graphs (a `$ref`-rooted
 * cycle, or a `properties` chain that loops back) so the walk always terminates; the 256 KiB
 * manifest admission limit bounds the acyclic case to a few tens of thousands of nodes, which
 * an explicit work stack traverses in constant call-stack space with no depth ceiling.
 */
function walkSchemaNodes(
  root: JsonSchemaValue,
  start: unknown,
  startPath: string,
  startResourceRoot: JsonSchemaValue,
  startResourceBaseId: string | undefined,
): string | undefined {
  const visited = new Set<object>();
  const stack: NodeWorkItem[] = [
    {
      schema: start,
      path: startPath,
      resourceRoot: startResourceRoot,
      resourceBaseId: startResourceBaseId,
    },
  ];
  while (stack.length > 0) {
    const item = stack.pop() as NodeWorkItem;
    const { schema, path, resourceRoot, resourceBaseId } = item;
    if (typeof schema === "boolean") {
      continue;
    }
    if (!isRecord(schema)) {
      return `${path}: schema must be an object or boolean`;
    }
    if (visited.has(schema)) {
      continue;
    }
    visited.add(schema);
    if (Object.hasOwn(schema, "type")) {
      const typeError = validateTypeKeyword(schema.type, path);
      if (typeError) {
        return typeError;
      }
    }
    if (schema.nullable !== undefined) {
      if (typeof schema.nullable !== "boolean") {
        return `${path}.nullable: expected boolean`;
      }
      if (!Object.hasOwn(schema, "type")) {
        return `${path}.nullable: expected type`;
      }
    }
    const keywordError = validateSchemaKeywordShapes(schema, path);
    if (keywordError) {
      return keywordError;
    }
    const currentResourceRoot = typeof schema.$id === "string" ? schema : resourceRoot;
    const currentResourceBaseId =
      typeof schema.$id === "string" ? resolveSchemaId(schema.$id, resourceBaseId) : resourceBaseId;
    if (typeof schema.$ref === "string") {
      if (!resolveSchemaRef(root, currentResourceRoot, schema.$ref, currentResourceBaseId).found) {
        return `${path}.$ref: unresolved ref`;
      }
    }
    if (typeof schema.$dynamicRef === "string") {
      if (
        !resolveSchemaRef(root, currentResourceRoot, schema.$dynamicRef, currentResourceBaseId)
          .found
      ) {
        return `${path}.$dynamicRef: unresolved ref`;
      }
    }
    for (const key of schemaMapKeywords) {
      const value = schema[key];
      if (value === undefined) {
        continue;
      }
      if (!isRecord(value)) {
        return `${path}.${key}: expected schema map`;
      }
      for (const [entryKey, entry] of Object.entries(value)) {
        stack.push({
          schema: entry,
          path: `${path}.${key}.${entryKey}`,
          resourceRoot: currentResourceRoot,
          resourceBaseId: currentResourceBaseId,
        });
      }
    }
    if (isRecord(schema.dependencies)) {
      for (const [key, value] of Object.entries(schema.dependencies)) {
        if (isStringArray(value)) {
          continue;
        }
        stack.push({
          schema: value,
          path: `${path}.dependencies.${key}`,
          resourceRoot: currentResourceRoot,
          resourceBaseId: currentResourceBaseId,
        });
      }
    }
    for (const key of schemaValueKeywords) {
      const value = schema[key];
      if (value === undefined || typeof value === "boolean") {
        continue;
      }
      if (Array.isArray(value)) {
        if (key !== "items") {
          return `${path}.${key}: expected schema`;
        }
        for (const [index, entry] of value.entries()) {
          stack.push({
            schema: entry,
            path: `${path}.${key}.${index}`,
            resourceRoot: currentResourceRoot,
            resourceBaseId: currentResourceBaseId,
          });
        }
        continue;
      }
      stack.push({
        schema: value,
        path: `${path}.${key}`,
        resourceRoot: currentResourceRoot,
        resourceBaseId: currentResourceBaseId,
      });
    }
    for (const key of schemaArrayKeywords) {
      const value = schema[key];
      if (value === undefined) {
        continue;
      }
      if (!Array.isArray(value)) {
        return `${path}.${key}: expected schema array`;
      }
      for (const [index, entry] of value.entries()) {
        stack.push({
          schema: entry,
          path: `${path}.${key}.${index}`,
          resourceRoot: currentResourceRoot,
          resourceBaseId: currentResourceBaseId,
        });
      }
    }
  }
  return undefined;
}

/** Return the first structural JSON Schema error that would make validation/defaulting unsafe. */
export function findJsonSchemaShapeError(schema: JsonSchemaValue): string | undefined {
  return walkSchemaNodes(schema, schema, "<schema>", schema, undefined);
}

function cloneDefault<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  return structuredClone(value);
}

function getDefault(schema: JsonSchemaValue): unknown {
  if (!isRecord(schema) || !Object.hasOwn(schema, "default")) {
    return undefined;
  }
  return cloneDefault(schema.default);
}

function schemaWithResourceContext(
  schema: JsonSchemaValue,
  resourceRoot: JsonSchemaValue,
): JsonSchemaValue {
  if (!isRecord(schema) || !isRecord(resourceRoot)) {
    return schema;
  }
  return {
    ...schema,
    ...(typeof resourceRoot.$id === "string" && schema.$id === undefined
      ? { $id: resourceRoot.$id }
      : {}),
    ...(isRecord(resourceRoot.$defs) ? { $defs: resourceRoot.$defs } : {}),
    ...(isRecord(resourceRoot.definitions) ? { definitions: resourceRoot.definitions } : {}),
  };
}

function inlineLocalRefsForMatch(
  schema: JsonSchemaValue,
  root: JsonSchemaValue,
  resourceRoot: JsonSchemaValue,
  resourceBaseId: string | undefined,
  resolvingRefs = new Set<string>(),
): JsonSchemaValue {
  if (Array.isArray(schema)) {
    return schema.map((entry) =>
      inlineLocalRefsForMatch(
        entry as JsonSchemaValue,
        root,
        resourceRoot,
        resourceBaseId,
        resolvingRefs,
      ),
    ) as unknown as JsonSchemaValue;
  }
  if (!isRecord(schema)) {
    return schema;
  }
  const currentResourceRoot = typeof schema.$id === "string" ? schema : resourceRoot;
  const currentResourceBaseId =
    typeof schema.$id === "string" ? resolveSchemaId(schema.$id, resourceBaseId) : resourceBaseId;
  if (isRecord(schema) && typeof schema.$ref === "string") {
    const refKey = schemaResourceRefKey(currentResourceRoot, schema.$ref, currentResourceBaseId);
    const target = resolvingRefs.has(refKey)
      ? { found: false as const }
      : resolveSchemaRef(root, currentResourceRoot, schema.$ref, currentResourceBaseId);
    if (target.found) {
      const { $ref: _$ref, ...siblingSchema } = schema;
      resolvingRefs.add(refKey);
      const inlinedTarget = inlineLocalRefsForMatch(
        target.schema,
        root,
        target.resourceRoot,
        target.resourceBaseId,
        resolvingRefs,
      );
      resolvingRefs.delete(refKey);
      if (Object.keys(siblingSchema).length === 0) {
        return inlinedTarget;
      }
      return {
        allOf: [
          inlinedTarget,
          inlineLocalRefsForMatch(
            siblingSchema as JsonSchemaValue,
            root,
            currentResourceRoot,
            currentResourceBaseId,
            resolvingRefs,
          ),
        ],
      };
    }
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (schemaMapKeywords.has(key) && isRecord(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([entryKey, entry]) => [
              entryKey,
              inlineLocalRefsForMatch(
                entry as JsonSchemaValue,
                root,
                currentResourceRoot,
                currentResourceBaseId,
                resolvingRefs,
              ),
            ]),
          ),
        ];
      }
      if (key === "dependencies" && isRecord(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([entryKey, entry]) => [
              entryKey,
              isStringArray(entry)
                ? entry
                : inlineLocalRefsForMatch(
                    entry as JsonSchemaValue,
                    root,
                    currentResourceRoot,
                    currentResourceBaseId,
                    resolvingRefs,
                  ),
            ]),
          ),
        ];
      }
      if (schemaValueKeywords.has(key) || schemaArrayKeywords.has(key)) {
        return [
          key,
          inlineLocalRefsForMatch(
            value as JsonSchemaValue,
            root,
            currentResourceRoot,
            currentResourceBaseId,
            resolvingRefs,
          ),
        ];
      }
      return [key, value];
    }),
  ) as JsonSchemaValue;
}

function schemaMatches(
  schema: JsonSchemaValue,
  value: unknown,
  root: JsonSchemaValue,
  resourceRoot: JsonSchemaValue,
  resourceBaseId: string | undefined,
): boolean {
  try {
    const matchSchema = inlineLocalRefsForMatch(schema, root, resourceRoot, resourceBaseId);
    return Compile(
      normalizeJsonSchemaForTypeBox(schemaWithResourceContext(matchSchema, resourceRoot)) as never,
    ).Check(value);
  } catch {
    return false;
  }
}

function applyObjectPropertyDefaults(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  root: JsonSchemaValue,
  resolvingRefs: Set<string>,
  currentResourceRoot: JsonSchemaValue,
  currentResourceBaseId: string | undefined,
): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    const currentValue = value[key];
    const defaultedValue = applySchemaDefaults(
      propertySchema as JsonSchemaValue,
      currentValue,
      root,
      resolvingRefs,
      currentResourceRoot,
      currentResourceBaseId,
    );
    if (defaultedValue !== currentValue || currentValue === undefined) {
      if (defaultedValue !== undefined) {
        value[key] = defaultedValue;
      }
    }
  }
  const patternMatchedKeys = new Set<string>();
  if (isRecord(schema.patternProperties)) {
    for (const [pattern, propertySchema] of Object.entries(schema.patternProperties)) {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        continue;
      }
      for (const key of Object.keys(value)) {
        if (isBlockedObjectKey(key) || !regex.test(key)) {
          continue;
        }
        patternMatchedKeys.add(key);
        value[key] = applySchemaDefaults(
          propertySchema as JsonSchemaValue,
          value[key],
          root,
          resolvingRefs,
          currentResourceRoot,
          currentResourceBaseId,
        );
      }
    }
  }
  if (isRecord(schema.additionalProperties)) {
    const additionalSchema = schema.additionalProperties as JsonSchemaValue;
    for (const key of Object.keys(value)) {
      if (
        isBlockedObjectKey(key) ||
        Object.hasOwn(properties, key) ||
        patternMatchedKeys.has(key)
      ) {
        continue;
      }
      value[key] = applySchemaDefaults(
        additionalSchema,
        value[key],
        root,
        resolvingRefs,
        currentResourceRoot,
        currentResourceBaseId,
      );
    }
  }
  return value;
}

function applyObjectDependencyDefaults(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  root: JsonSchemaValue,
  resolvingRefs: Set<string>,
  currentResourceRoot: JsonSchemaValue,
  currentResourceBaseId: string | undefined,
): Record<string, unknown> {
  let nextValue = value;
  if (isRecord(schema.dependencies)) {
    for (const [key, dependencySchema] of Object.entries(schema.dependencies)) {
      if (!Object.hasOwn(nextValue, key) || isStringArray(dependencySchema)) {
        continue;
      }
      nextValue = applySchemaDefaults(
        dependencySchema as JsonSchemaValue,
        nextValue,
        root,
        resolvingRefs,
        currentResourceRoot,
        currentResourceBaseId,
      ) as Record<string, unknown>;
    }
  }
  if (isRecord(schema.dependentSchemas)) {
    for (const [key, dependentSchema] of Object.entries(schema.dependentSchemas)) {
      if (!Object.hasOwn(nextValue, key)) {
        continue;
      }
      nextValue = applySchemaDefaults(
        dependentSchema as JsonSchemaValue,
        nextValue,
        root,
        resolvingRefs,
        currentResourceRoot,
        currentResourceBaseId,
      ) as Record<string, unknown>;
    }
  }
  return nextValue;
}

function applyObjectConditionalDefaults(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  root: JsonSchemaValue,
  resolvingRefs: Set<string>,
  currentResourceRoot: JsonSchemaValue,
  currentResourceBaseId: string | undefined,
): Record<string, unknown> {
  if (!(typeof schema.if === "boolean" || isRecord(schema.if))) {
    return value;
  }
  const branch = schemaMatches(
    schema.if as JsonSchemaValue,
    value,
    root,
    currentResourceRoot,
    currentResourceBaseId,
  )
    ? schema.then
    : schema.else;
  if (!(typeof branch === "boolean" || isRecord(branch))) {
    return value;
  }
  return applySchemaDefaults(
    branch as JsonSchemaValue,
    value,
    root,
    resolvingRefs,
    currentResourceRoot,
    currentResourceBaseId,
  ) as Record<string, unknown>;
}

function countSchemaNodes(schema: JsonSchemaValue, seen = new Set<object>()): number {
  // Iterative DFS so a deep schema graph cannot overflow the call stack. `seen` guards cycles.
  let count = 0;
  const stack: JsonSchemaValue[] = [schema];
  while (stack.length > 0) {
    const current = stack.pop() as JsonSchemaValue;
    count += 1;
    if (typeof current === "boolean" || !isRecord(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const key of schemaMapKeywords) {
      const value = current[key];
      if (!isRecord(value)) {
        continue;
      }
      for (const entry of Object.values(value)) {
        stack.push(entry as JsonSchemaValue);
      }
    }
    if (isRecord(current.dependencies)) {
      for (const entry of Object.values(current.dependencies)) {
        if (!isStringArray(entry)) {
          stack.push(entry as JsonSchemaValue);
        }
      }
    }
    for (const key of schemaValueKeywords) {
      const value = current[key];
      if (typeof value === "boolean" || isRecord(value)) {
        stack.push(value as JsonSchemaValue);
        continue;
      }
      if (key === "items" && Array.isArray(value)) {
        for (const entry of value) {
          stack.push(entry as JsonSchemaValue);
        }
      }
    }
    for (const key of schemaArrayKeywords) {
      const value = current[key];
      if (!Array.isArray(value)) {
        continue;
      }
      for (const entry of value) {
        stack.push(entry as JsonSchemaValue);
      }
    }
  }
  return count;
}

function applyObjectApplicatorDefaults(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  root: JsonSchemaValue,
  resolvingRefs: Set<string>,
  currentResourceRoot: JsonSchemaValue,
  currentResourceBaseId: string | undefined,
): Record<string, unknown> {
  let nextValue = applyObjectPropertyAndDependencyDefaults(
    schema,
    value,
    root,
    resolvingRefs,
    currentResourceRoot,
    currentResourceBaseId,
  );
  nextValue = applyObjectConditionalDefaults(
    schema,
    nextValue,
    root,
    resolvingRefs,
    currentResourceRoot,
    currentResourceBaseId,
  );
  return applyObjectPropertyAndDependencyDefaults(
    schema,
    nextValue,
    root,
    resolvingRefs,
    currentResourceRoot,
    currentResourceBaseId,
  );
}

function applyObjectPropertyAndDependencyDefaults(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  root: JsonSchemaValue,
  resolvingRefs: Set<string>,
  currentResourceRoot: JsonSchemaValue,
  currentResourceBaseId: string | undefined,
): Record<string, unknown> {
  let nextValue = value;
  const maxIterations = countSchemaNodes(schema);
  for (let index = 0; index < maxIterations; index++) {
    const before = JSON.stringify(nextValue);
    nextValue = applyObjectPropertyDefaults(
      schema,
      nextValue,
      root,
      resolvingRefs,
      currentResourceRoot,
      currentResourceBaseId,
    );
    nextValue = applyObjectDependencyDefaults(
      schema,
      nextValue,
      root,
      resolvingRefs,
      currentResourceRoot,
      currentResourceBaseId,
    );
    if (JSON.stringify(nextValue) === before) {
      break;
    }
  }
  return nextValue;
}

function applySchemaDefaults(
  schema: JsonSchemaValue,
  valueInput: unknown,
  root = schema,
  resolvingRefs = new Set<string>(),
  resourceRoot = root,
  resourceBaseId?: string,
): unknown {
  let value = valueInput;
  if (value === undefined) {
    const defaultValue = getDefault(schema);
    if (defaultValue !== undefined) {
      value = defaultValue;
    }
  }
  if (!isRecord(schema)) {
    return value;
  }

  const currentResourceRoot = typeof schema.$id === "string" ? schema : resourceRoot;
  const currentResourceBaseId =
    typeof schema.$id === "string" ? resolveSchemaId(schema.$id, resourceBaseId) : resourceBaseId;
  let nextValue = value;
  const refKey =
    typeof schema.$ref === "string"
      ? schemaResourceRefKey(currentResourceRoot, schema.$ref, currentResourceBaseId)
      : undefined;
  if (typeof schema.$ref === "string" && refKey !== undefined && !resolvingRefs.has(refKey)) {
    const target = resolveSchemaRef(root, currentResourceRoot, schema.$ref, currentResourceBaseId);
    if (target.found) {
      resolvingRefs.add(refKey);
      nextValue = applySchemaDefaults(
        target.schema,
        nextValue,
        root,
        resolvingRefs,
        target.resourceRoot,
        target.resourceBaseId,
      );
      resolvingRefs.delete(refKey);
    }
  }

  const composedSchemas = [...(Array.isArray(schema.allOf) ? schema.allOf : [])];
  for (const branch of composedSchemas) {
    nextValue = applySchemaDefaults(
      branch as JsonSchemaValue,
      nextValue,
      root,
      resolvingRefs,
      currentResourceRoot,
      currentResourceBaseId,
    );
  }

  const hasObjectApplicators =
    isRecord(schema.properties) ||
    isRecord(schema.patternProperties) ||
    isRecord(schema.additionalProperties) ||
    isRecord(schema.dependencies) ||
    isRecord(schema.dependentSchemas) ||
    typeof schema.if === "boolean" ||
    isRecord(schema.if);
  if ((schemaTypeIncludes(schema, "object") || hasObjectApplicators) && isRecord(nextValue)) {
    nextValue = applyObjectApplicatorDefaults(
      schema,
      nextValue,
      root,
      resolvingRefs,
      currentResourceRoot,
      currentResourceBaseId,
    );
    return nextValue;
  }

  if (
    (schemaTypeIncludes(schema, "array") ||
      schema.items !== undefined ||
      schema.prefixItems !== undefined) &&
    Array.isArray(nextValue)
  ) {
    const tupleSchemas = Array.isArray(schema.prefixItems)
      ? schema.prefixItems
      : Array.isArray(schema.items)
        ? schema.items
        : null;
    if (tupleSchemas) {
      const result = nextValue.slice();
      for (const [index, itemSchema] of tupleSchemas.entries()) {
        const defaultedValue = applySchemaDefaults(
          itemSchema as JsonSchemaValue,
          result[index],
          root,
          resolvingRefs,
          currentResourceRoot,
          currentResourceBaseId,
        );
        if (defaultedValue !== undefined) {
          result[index] = defaultedValue;
        }
      }
      const restSchema = isRecord(schema.items)
        ? schema.items
        : isRecord(schema.additionalItems)
          ? schema.additionalItems
          : null;
      if (restSchema) {
        for (let index = tupleSchemas.length; index < result.length; index++) {
          result[index] = applySchemaDefaults(
            restSchema as JsonSchemaValue,
            result[index],
            root,
            resolvingRefs,
            currentResourceRoot,
            currentResourceBaseId,
          );
        }
      }
      return result;
    }
    if (!isRecord(schema.items)) {
      return nextValue;
    }
    return nextValue.map((item) =>
      applySchemaDefaults(
        schema.items as JsonSchemaValue,
        item,
        root,
        resolvingRefs,
        currentResourceRoot,
        currentResourceBaseId,
      ),
    );
  }

  return nextValue;
}

/** Apply schema defaults to a config value while preserving caller-owned value shape. */
export function applyJsonSchemaDefaults<T>(schema: JsonSchemaValue, value: T): T {
  return applySchemaDefaults(schema, value) as T;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
